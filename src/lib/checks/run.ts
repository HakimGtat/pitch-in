import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { jobs, repos, submissions, tasks, type Repo, type Submission, type Task } from "../db/schema";
import type { CheckRunInput, PullRequest, RepoGitHub } from "../github/repos";
import { checkMerge } from "../alerts";
import { handlePrClosed } from "../merge";
import { detachSubmission, linkPullRequest } from "../pr-link";
import { taskRef } from "../prompt";
import { checkCi, fromCommitStatus } from "./ci";
import { checkCriteria } from "./criteria";
import { changedLineMap } from "./diff";
import { checkEvidence } from "./evidence";
import type { ChangedFile } from "./files";
import { parseTaskLine } from "./pr-body";
import { buildExcerpts, type Excerpt } from "./excerpts";
import { checkScope } from "./scope";
import { checkSecrets, type SecretScanner } from "./secrets";
import { checkSize } from "./size";
import { checkTemplate } from "./template";
import { CHECK_ORDER, SITE_CHECK_NAME, type CheckResult } from "./types";

// Running the seven checks on a PR and posting them as one GitHub check run
// (plan.md, "Review-friendly PRs"). The worker reads the PR, its files and its
// CI results through the GitHub API; it never runs contributor code.

export const CHECKS_JOB = "run_checks";
export type ChecksJob = { repoId: number; prNumber: number };

/** How long to wait for the repo's own CI before checking again, and how many times. */
export const CI_WAIT_MS = 60_000;
export const CI_MAX_WAITS = 60;

/** What the worker stores in submissions.check_results. */
export type StoredChecks = {
  headSha: string;
  ranAt: string;
  results: CheckResult[];
  passed: number;
  failed: number;
  /** The repo's CI hadn't finished yet; the worker checks again. */
  ciPending: boolean;
  ciWaits: number;
  pr: { title: string; url: string; draft: boolean; body: string; headRef: string; author: string };
  /** The changed lines around each criterion's pointer, for the review packet. */
  excerpts: Excerpt[];
};

export const checksJobKey = (job: ChecksJob, headSha: string) => `checks:${job.repoId}#${job.prNumber}@${headSha}`;

/**
 * Queues a checks run for a PR's head commit. There's one job per PR and head
 * sha: a new event for the same commit (a PR body edit, CI finishing) re-arms
 * it once it has run.
 */
export async function queueChecks(db: Db, job: ChecksJob, headSha: string, now: Date = new Date()): Promise<void> {
  await db
    .insert(jobs)
    .values({ type: CHECKS_JOB, payload: job, dedupeKey: checksJobKey(job, headSha), runAfter: now })
    .onConflictDoUpdate({
      target: jobs.dedupeKey,
      set: { status: "queued", attempts: 0, runAfter: now, lastError: null, finishedAt: null, updatedAt: now },
      setWhere: sql`${jobs.status} in ('done', 'failed')`,
    });
}

/** `✓ Size       142 of 300 lines`, as in plan.md's example. */
export const resultLine = (r: CheckResult) => `${r.passed ? "✓" : "✗"} ${r.name.padEnd(10)} ${r.detail}`;

export function checkRunOutput(results: CheckResult[], ciPending: boolean): CheckRunInput & { headSha: "" } {
  const failed = results.filter((r) => !r.passed).length;
  const head = `${results.length - failed} passed, ${failed} failed`;
  const summary = [
    `Pitch In checks: ${head}${ciPending ? " (waiting for CI to finish)" : ""}`,
    "",
    "```",
    ...results.map(resultLine),
    "```",
    "",
    failed === 0 && !ciPending
      ? "Ready for the owner's review."
      : "The owner handles anything that failed. Nothing is needed from the contributor.",
  ].join("\n");
  return {
    headSha: "",
    status: ciPending ? "in_progress" : "completed",
    ...(ciPending ? {} : { conclusion: failed === 0 ? ("success" as const) : ("failure" as const) }),
    title: ciPending ? `${head}, waiting for CI` : head,
    summary,
  };
}

/** Pure: the seven results in plan order. */
export async function runAllChecks(input: {
  ref: string;
  body: string | null;
  acceptance: string[];
  files: ChangedFile[];
  sizeTier: Task["sizeTier"];
  allowedPaths: string[];
  settings: Repo["settings"];
  ci: ReturnType<typeof fromCommitStatus>[];
  scanner: SecretScanner;
}): Promise<CheckResult[]> {
  const byName = {
    Template: checkTemplate(input.body, input.ref),
    Size: checkSize(input.files, input.sizeTier, input.settings.sizeCapIgnore),
    Scope: checkScope(input.files, input.allowedPaths, input.settings.offLimitsPaths),
    Secrets: await checkSecrets(input.files, input.scanner),
    CI: checkCi(input.ci),
    Criteria: checkCriteria(input.body, input.acceptance),
    Evidence: checkEvidence(input.body, input.acceptance, changedLineMap(input.files)),
  };
  return CHECK_ORDER.map((name) => byName[name]);
}

async function postCheckRun(gh: RepoGitHub, fullName: string, run: CheckRunInput): Promise<number> {
  const existing = (await gh.listCheckRuns(fullName, run.headSha)).find((r) => r.name === SITE_CHECK_NAME);
  if (existing) {
    await gh.updateCheckRun(fullName, existing.id, run);
    return existing.id;
  }
  return gh.createCheckRun(fullName, SITE_CHECK_NAME, run);
}

export type ChecksOutcome =
  | { status: "skipped"; why: string }
  | { status: "unlinked"; reason: string }
  | { status: "checked"; passed: number; failed: number; ciPending: boolean };

async function linkedSubmission(db: Db, repoId: number, prNumber: number) {
  const [row] = await db
    .select({ submission: submissions, task: tasks })
    .from(submissions)
    .innerJoin(tasks, eq(submissions.taskId, tasks.id))
    .where(and(eq(tasks.repoId, repoId), eq(submissions.prNumber, prNumber)))
    .orderBy(desc(submissions.id))
    .limit(1);
  return row ?? null;
}

const OPEN_SUBMISSION = new Set<Submission["status"]>(["checking", "checks_failed", "in_review"]);

/**
 * The run_checks job. Reads the PR fresh, so it always checks the latest
 * state, whatever event queued it.
 */
export async function runChecks(
  db: Db,
  deps: { gh: RepoGitHub; scanner: SecretScanner },
  job: ChecksJob,
  now: Date = new Date(),
): Promise<ChecksOutcome> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, job.repoId));
  if (!repo || repo.removedAt) return { status: "skipped", why: "the repo isn't connected" };
  const pr = await deps.gh.getPullRequest(repo.fullName, job.prNumber);
  const before = await linkedSubmission(db, repo.id, job.prNumber);
  const stillOpen = before && OPEN_SUBMISSION.has(before.submission.status);
  if (!pr) {
    // A pasted link to a PR that doesn't exist mustn't hold the task forever.
    if (stillOpen) await detachSubmission(db, before.submission.id, before.task.id, now, "the PR doesn't exist");
    return { status: "skipped", why: "the PR is gone" };
  }
  if (pr.state !== "open") {
    // Closed or merged, and the webhook that said so was missed or came first: catch up now.
    if (stillOpen) {
      await handlePrClosed(
        db,
        {
          repoId: repo.id,
          prNumber: pr.number,
          merged: pr.merged,
          mergedBy: pr.mergedBy,
          mergeCommitSha: pr.mergeCommitSha,
          baseRef: pr.baseRef,
          defaultBranch: repo.defaultBranch,
        },
        now,
      );
      if (pr.merged && pr.baseRef === repo.defaultBranch) {
        await checkMerge(db, deps.gh, { repo, prNumber: pr.number, mergedBy: pr.mergedBy, mergeCommitSha: pr.mergeCommitSha }, now);
      }
    }
    return { status: "skipped", why: "the PR is closed" };
  }

  // Link (or re-link) first: it fills in a pasted link's head commit and gives the reason when a PR doesn't link.
  const link = await linkPullRequest(db, prInfo(repo, pr), now);
  if (link.status === "ignored") return { status: "skipped", why: "the PR isn't into the default branch" };
  if (link.status === "unlinked") {
    // Only PRs that name a task get a failing check; other PRs aren't Pitch In's business.
    if (parseTaskLine(pr.body) === null) return { status: "skipped", why: "the PR doesn't name a task" };
    await postCheckRun(deps.gh, repo.fullName, {
      headSha: pr.headSha,
      status: "completed",
      conclusion: "failure",
      title: "Not linked to a task",
      summary: `Pitch In checks: not linked\n\n${link.reason} Only the PR of the person who took on the task is checked and reviewed.`,
    });
    return { status: "unlinked", reason: link.reason };
  }

  const row = await linkedSubmission(db, repo.id, pr.number);
  if (!row) return { status: "skipped", why: "the PR isn't linked" };
  const { submission, task } = row;
  if (!OPEN_SUBMISSION.has(submission.status)) return { status: "skipped", why: `the submission is ${submission.status}` };

  const files = await deps.gh.listPullRequestFiles(repo.fullName, pr.number);
  const ci = [
    ...(await deps.gh.listCheckRuns(repo.fullName, pr.headSha)),
    ...(await deps.gh.listCommitStatuses(repo.fullName, pr.headSha)).map(fromCommitStatus),
  ];
  const results = await runAllChecks({
    ref: taskRef(task.id),
    body: pr.body,
    acceptance: task.brief.acceptance,
    files,
    sizeTier: task.sizeTier,
    allowedPaths: task.allowedPaths,
    settings: repo.settings,
    ci,
    scanner: deps.scanner,
  });

  const previous = submission.checkResults as StoredChecks | null;
  const sameSha = previous?.headSha === pr.headSha;
  const ciWaits = sameSha && previous?.ciPending ? previous.ciWaits + 1 : 0;
  const ciRunning = results.some((r) => r.name === "CI" && /still running|no CI results yet/.test(r.detail));
  const ciPending = ciRunning && ciWaits < CI_MAX_WAITS;
  const failed = results.filter((r) => !r.passed).length;

  const stored: StoredChecks = {
    headSha: pr.headSha,
    ranAt: now.toISOString(),
    results,
    passed: results.length - failed,
    failed,
    ciPending,
    ciWaits,
    pr: { title: pr.title, url: pr.url, draft: pr.draft, body: pr.body ?? "", headRef: pr.headRef, author: pr.author },
    excerpts: buildExcerpts(pr.body, task.brief.acceptance, files),
  };
  const status: Submission["status"] = ciPending ? "checking" : failed === 0 ? "in_review" : "checks_failed";

  await db.transaction(async (tx) => {
    await tx
      .update(submissions)
      .set({ checkResults: stored, status, headSha: pr.headSha, updatedAt: now })
      .where(eq(submissions.id, submission.id));
    if (status === "in_review" && task.status === "adopted") {
      await tx.update(tasks).set({ status: "in_review", updatedAt: now }).where(eq(tasks.id, task.id));
    } else if (status !== "in_review" && task.status === "in_review") {
      await tx.update(tasks).set({ status: "adopted", updatedAt: now }).where(eq(tasks.id, task.id));
    }
  });

  await postCheckRun(deps.gh, repo.fullName, { ...checkRunOutput(results, ciPending), headSha: pr.headSha });

  if (ciPending) {
    // Check again once CI has had time to finish, whether or not GitHub tells us it did.
    await db
      .insert(jobs)
      .values({
        type: CHECKS_JOB,
        payload: job,
        dedupeKey: `${checksJobKey(job, pr.headSha)}:wait:${ciWaits + 1}`,
        runAfter: new Date(now.getTime() + CI_WAIT_MS),
      })
      .onConflictDoNothing({ target: jobs.dedupeKey });
  }
  return { status: "checked", passed: results.length - failed, failed, ciPending };
}

export function prInfo(repo: Repo, pr: PullRequest) {
  return {
    repoId: repo.id,
    repoFullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    number: pr.number,
    baseRef: pr.baseRef,
    headSha: pr.headSha,
    authorHandle: pr.author,
    body: pr.body,
    draft: pr.draft,
  };
}
