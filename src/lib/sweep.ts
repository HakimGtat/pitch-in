import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { parseTaskLine } from "./checks/pr-body";
import type { StoredChecks } from "./checks/run";
import { CI_MAX_WAIT_MS, queueChecks } from "./checks/run";
import { SITE_CHECK_NAME } from "./checks/types";
import type { Db } from "./db/client";
import { jobs, repos, submissions, tasks, type Repo } from "./db/schema";
import type { RepoGitHub } from "./github/repos";
import { isQuestion, recordQuestion } from "./questions";
import { OPEN_SUBMISSION } from "./views";

// The catch-up sweep. Webhooks reach this machine through the smee relay,
// which drops whatever arrives while the machine is off. Every few minutes
// (and when the worker starts) the worker asks GitHub directly about the PRs
// the site cares about, so a missed close, merge, push, question or newly
// opened PR is caught up within minutes instead of leaving a task stuck. smee
// stays as the fast path.

export const SWEEP_JOB = "catch_up_sweep";
export const SWEEP_EVERY_MS = 5 * 60_000;

/** Queues the next sweep at the next five-minute mark (once per mark), or right away when the worker starts. */
export async function queueSweep(db: Db, now: Date, opts: { now?: boolean } = {}): Promise<void> {
  const at = opts.now ? now : new Date(Math.ceil((now.getTime() + 1) / SWEEP_EVERY_MS) * SWEEP_EVERY_MS);
  await db
    .insert(jobs)
    .values({ type: SWEEP_JOB, payload: {}, dedupeKey: opts.now ? `sweep@start-${now.getTime()}` : `sweep@${at.getTime()}`, runAfter: at })
    .onConflictDoNothing({ target: jobs.dedupeKey });
}

export type SweepResult = { looked: number; queued: number; questions: number; skippedRepos: number; errors: number };

/** A PR whose checks job gave up (GitHub was down, say) is checked again once it's been "checking" this long. */
export const STUCK_CHECKING_MS = 15 * 60_000;

/** Did anything change on GitHub that the site would have heard about from a webhook it missed? */
function needsCheck(
  submission: { status: string; headSha: string; updatedAt: Date; checkResults: unknown },
  pr: { state: string; headSha: string; baseRef: string; body: string | null },
  repo: Repo,
  now: Date,
): boolean {
  const stored = submission.checkResults as StoredChecks | null;
  if (pr.state !== "open" || pr.headSha !== submission.headSha) return true; // closed, merged or pushed to
  if (pr.baseRef !== repo.defaultBranch) return true; // retargeted
  if (stored && (stored.pr.body ?? "") !== (pr.body ?? "")) return true; // description edited (a fix, or a question)
  if (submission.status === "checking" && now.getTime() - submission.updatedAt.getTime() > STUCK_CHECKING_MS) return true;
  // CI failed last time: a re-run on the same commit may have turned it green. Only for an hour after
  // that run, so a PR that stays red isn't re-checked every five minutes forever; a new push re-checks it anyway.
  if (
    submission.status === "checks_failed" &&
    stored?.results.some((r) => r.name === "CI" && !r.passed) &&
    now.getTime() - new Date(stored.ranAt).getTime() < CI_MAX_WAIT_MS
  )
    return true;
  return false;
}

export async function runSweep(db: Db, gh: RepoGitHub, now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { looked: 0, queued: 0, questions: 0, skippedRepos: 0, errors: 0 };
  const connected = await db.select().from(repos).where(isNull(repos.removedAt));

  for (const repo of connected) {
    // A repo the App can't see right now (access removed, or GitHub having a moment): learn nothing, change nothing.
    try {
      if (!(await gh.getRepo(repo.githubRepoId))) {
        result.skippedRepos++;
        continue;
      }
    } catch {
      result.errors++;
      continue;
    }

    // 1. PRs linked here and still open here: did GitHub close, merge or change them without telling us?
    const open = await db
      .select({ submission: submissions })
      .from(submissions)
      .innerJoin(tasks, eq(submissions.taskId, tasks.id))
      .where(and(eq(tasks.repoId, repo.id), inArray(submissions.status, [...OPEN_SUBMISSION])));
    for (const { submission } of open) {
      try {
        result.looked++;
        const pr = await gh.getPullRequest(repo.fullName, submission.prNumber);
        if (!pr || needsCheck(submission, pr, repo, now)) {
          // The checks job settles it: a closed or merged PR is caught up, a gone one lets go, a change is checked.
          await queueChecks(db, { repoId: repo.id, prNumber: submission.prNumber }, pr?.headSha || `sweep-${submission.id}`, now);
          result.queued++;
          continue;
        }
        for (const c of await gh.listIssueComments(repo.fullName, submission.prNumber)) {
          if (!isQuestion(c.body)) continue;
          const out = await recordQuestion(db, { repoId: repo.id, prNumber: pr.number, commentId: c.id, body: c.body, commenter: c.author }, now);
          if (out.status === "asked") result.questions++;
        }
      } catch {
        result.errors++;
      }
    }

    // 2. Open PRs that name a task but were never seen (their "opened" webhook went missing).
    try {
      for (const pr of await gh.listOpenPullRequests(repo.fullName)) {
        if (pr.baseRef !== repo.defaultBranch || parseTaskLine(pr.body) === null) continue;
        const [known] = await db
          .select({ id: submissions.id })
          .from(submissions)
          .innerJoin(tasks, eq(submissions.taskId, tasks.id))
          .where(and(eq(tasks.repoId, repo.id), eq(submissions.prNumber, pr.number), ne(submissions.status, "closed")));
        if (known) continue;
        result.looked++;
        const runs = await gh.listCheckRuns(repo.fullName, pr.headSha);
        if (runs.some((r) => r.name === SITE_CHECK_NAME)) continue;
        await queueChecks(db, { repoId: repo.id, prNumber: pr.number }, pr.headSha, now);
        result.queued++;
      }
    } catch {
      result.errors++;
    }
  }
  return result;
}
