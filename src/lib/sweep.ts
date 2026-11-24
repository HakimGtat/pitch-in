import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { parseTaskLine } from "./checks/pr-body";
import { queueChecks } from "./checks/run";
import { SITE_CHECK_NAME } from "./checks/types";
import type { Db } from "./db/client";
import { jobs, repos, submissions, tasks } from "./db/schema";
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

export type SweepResult = { looked: number; queued: number; questions: number };

export async function runSweep(db: Db, gh: RepoGitHub, now: Date = new Date()): Promise<SweepResult> {
  let looked = 0;
  let queued = 0;
  let questions = 0;

  // 1. PRs linked here and still open here: did GitHub close, merge or move them without telling us?
  const open = await db
    .select({ submission: submissions, repo: repos })
    .from(submissions)
    .innerJoin(tasks, eq(submissions.taskId, tasks.id))
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(and(inArray(submissions.status, [...OPEN_SUBMISSION]), isNull(repos.removedAt)));
  for (const { submission, repo } of open) {
    looked++;
    const job = { repoId: repo.id, prNumber: submission.prNumber };
    const pr = await gh.getPullRequest(repo.fullName, submission.prNumber);
    if (!pr || pr.state !== "open" || pr.headSha !== submission.headSha) {
      // The checks job settles it: a closed or merged PR is caught up, a gone one lets go, a new push is checked.
      await queueChecks(db, job, pr?.headSha || `sweep-${submission.id}-${now.getTime()}`, now);
      queued++;
      continue;
    }
    for (const c of await gh.listIssueComments(repo.fullName, submission.prNumber)) {
      if (!isQuestion(c.body)) continue;
      const out = await recordQuestion(db, { repoId: repo.id, prNumber: pr.number, commentId: c.id, body: c.body, commenter: c.author }, now);
      if (out.status === "asked") questions++;
    }
  }

  // 2. Open PRs that name a task but were never seen (their "opened" webhook went missing).
  const connected = await db.select().from(repos).where(isNull(repos.removedAt));
  for (const repo of connected) {
    for (const pr of await gh.listOpenPullRequests(repo.fullName)) {
      if (pr.baseRef !== repo.defaultBranch || parseTaskLine(pr.body) === null) continue;
      const [known] = await db
        .select({ id: submissions.id })
        .from(submissions)
        .innerJoin(tasks, eq(submissions.taskId, tasks.id))
        .where(and(eq(tasks.repoId, repo.id), eq(submissions.prNumber, pr.number), ne(submissions.status, "closed")));
      if (known) continue;
      looked++;
      const runs = await gh.listCheckRuns(repo.fullName, pr.headSha);
      if (runs.some((r) => r.name === SITE_CHECK_NAME)) continue;
      await queueChecks(db, { repoId: repo.id, prNumber: pr.number }, pr.headSha, now);
      queued++;
    }
  }
  return { looked, queued, questions };
}
