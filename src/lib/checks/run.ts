import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { jobs, repos, submissions, tasks, users, type Repo, type Submission, type Task } from "../db/schema";
import type { CheckRunInput, PullRequest, RepoGitHub } from "../github/repos";
import { checkMerge } from "../alerts";
import { handlePrClosed } from "../merge";
import { isQuestion, recordQuestion } from "../questions";
import { detachSubmission, linkPullRequest } from "../pr-link";
import { taskRef } from "../prompt";
import { checkCi, fromCommitStatus } from "./ci";
import { checkCriteria } from "./criteria";
import { changedLineMap } from "./diff";
import { checkEvidence } from "./evidence";
import type { ChangedFile } from "./files";
import { OPEN_SUBMISSION as OPEN_SUBMISSION_LIST } from "../views";
import { hasContent, parsePrBody, parseTaskLine, QUESTION_SECTION } from "./pr-body";
import { buildExcerpts, type Excerpt } from "./excerpts";
import { checkScope } from "./scope";
import { checkSecrets, type SecretScanner } from "./secrets";
import { checkSize, generatedFromGitattributes } from "./size";
import { checkTemplate } from "./template";
import { CHECK_ORDER, isGate, SITE_CHECK_NAME, type CheckResult } from "./types";

// Running the seven checks on a PR and posting them as one GitHub check run
// (plan.md, "Review-friendly PRs"). The worker reads the PR, its files and its
// CI results through the GitHub API; it never runs contributor code.

export const CHECKS_JOB = "run_checks";
export type ChecksJob = { repoId: number; prNumber: number };

/** How long to wait for the repo's own CI before checking again, and how many times. */
export const CI_WAIT_MS = 60_000;
export const CI_MAX_WAIT_MS = 60 * 60_000;

/** The follow-up check's key: one per PR, commit and minute, so several events never start parallel chains. */
export const ciWaitKey = (job: ChecksJob, headSha: string, runAfter: Date) =>
  `${checksJobKey(job, headSha)}:wait@${Math.ceil(runAfter.getTime() / CI_WAIT_MS)}`;

/** What the worker stores in submissions.check_results. */
export type StoredChecks = {
  headSha: string;
  ranAt: string;
  results: CheckResult[];
  passed: number;
  /** Gates that failed: the PR isn't ready for review. */
  failed: number;
  /** Format checks that failed: shown, but they don't hold the PR back. */
  warnings?: number;
  /** The repo's CI hadn't finished yet; the worker checks again. */
  ciPending: boolean;
  /** When this commit's CI was first seen still running; the wait stops an hour after it. */
  ciPendingSince: string | null;
  pr: { title: string; url: string; draft: boolean; body: string; headRef: string; author: string };
  /** The changed lines around each criterion's pointer, for the review packet. */
  excerpts: Excerpt[];
  /** The task owner's review was requested on GitHub once the PR passed (done once per PR). */
  reviewRequested?: boolean;
  /** When this PR first passed its gates and became ready for review (for the Trial panel's review wait). */
  readyAt?: string | null;
  /** The results of the PR's very first check run (for first-pass rates). */
  firstResults?: CheckResult[];
};

/** "None", "N/A", "No questions": an agent filling in every heading, not asking anything. */
const NO_QUESTION = /^(none|n\/a|no|nothing|no questions?|not applicable)[.!]?$/i;

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
/** ✓ passed, ✗ a gate failed, ⚠ a format warning. */
export const resultLine = (r: CheckResult) => `${r.passed ? "✓" : isGate(r.name) ? "✗" : "⚠"} ${r.name.padEnd(10)} ${r.detail}`;

/** Counts for a set of results: gates that failed hold the PR back, format problems only warn. */
export function tally(results: CheckResult[]) {
  const failed = results.filter((r) => !r.passed && isGate(r.name)).length;
  const warnings = results.filter((r) => !r.passed && !isGate(r.name)).length;
  return { passed: results.length - failed - warnings, failed, warnings };
}

/** "6 passed, 0 failed, 1 warning", as in plan.md's example plus warnings. */
export function tallyText(results: CheckResult[]): string {
  const t = tally(results);
  return `${t.passed} passed, ${t.failed} failed${t.warnings ? `, ${t.warnings} ${t.warnings === 1 ? "warning" : "warnings"}` : ""}`;
}

export function checkRunOutput(results: CheckResult[], ciPending: boolean): CheckRunInput & { headSha: "" } {
  const { failed, warnings } = tally(results);
  const head = tallyText(results);
  const summary = [
    `Pitch In checks: ${head}${ciPending ? " (waiting for CI to finish)" : ""}`,
    "",
    "```",
    ...results.map(resultLine),
    "```",
    "",
    ciPending || failed
      ? "The owner handles anything that failed. Nothing is needed from the contributor."
      : warnings
        ? "Ready for the owner's review. The warnings are about the PR description's format; the owner's review covers them. Nothing is needed from the contributor."
        : "Ready for the owner's review.",
  ].join("\n");
  const conclusion = failed ? ("failure" as const) : warnings ? ("neutral" as const) : ("success" as const);
  return {
    headSha: "",
    status: ciPending ? "in_progress" : "completed",
    ...(ciPending ? {} : { conclusion }),
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
  /** Paths marked linguist-generated in the repo's .gitattributes: skipped by the size cap. */
  generated?: string[];
}): Promise<CheckResult[]> {
  const byName = {
    Template: checkTemplate(input.body, input.ref),
    Size: checkSize(input.files, input.sizeTier, [...input.settings.sizeCapIgnore, ...(input.generated ?? [])]),
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

/** One list of "the PR is still open" states for the whole site (views.ts). */
const OPEN_SUBMISSION = new Set<Submission["status"]>(OPEN_SUBMISSION_LIST);

/**
 * The run_checks job. Reads the PR fresh, so it always checks the latest
 * state, whatever event queued it.
 */
export async function runChecks(
  db: Db,
  deps: { gh: RepoGitHub; scanner: SecretScanner; appUrl?: string },
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
    // But a 404 can also mean the App lost access to the repo: then nothing is known, and nothing changes.
    if (stillOpen && (await deps.gh.getRepo(repo.githubRepoId))) {
      await detachSubmission(db, before.submission.id, before.task.id, now, "the PR doesn't exist");
    }
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
      ...(deps.appUrl ? { detailsUrl: `${deps.appUrl}/tasks/${parseTaskLine(pr.body)}` } : {}),
    });
    return { status: "unlinked", reason: link.reason };
  }

  const row = await linkedSubmission(db, repo.id, pr.number);
  if (!row) return { status: "skipped", why: "the PR isn't linked" };
  const { submission, task } = row;
  if (!OPEN_SUBMISSION.has(submission.status)) return { status: "skipped", why: `the submission is ${submission.status}` };

  // A question left before the PR linked (or whose webhook was missed) is picked up here. Recording is idempotent.
  for (const c of await deps.gh.listIssueComments(repo.fullName, pr.number)) {
    if (isQuestion(c.body)) {
      await recordQuestion(db, { repoId: repo.id, prNumber: pr.number, commentId: c.id, body: c.body, commenter: c.author }, now);
    }
  }
  // ...or in the PR's description, as a "## Question for owner" section (it arrives with pull_request events).
  const asked = parsePrBody(pr.body).sections[QUESTION_SECTION];
  if (hasContent(asked) && !NO_QUESTION.test(asked!.trim())) {
    await recordQuestion(
      db,
      // One description question per PR, keyed by the submission (negative, so it can't clash with a GitHub comment id).
      { repoId: repo.id, prNumber: pr.number, commentId: -submission.id, body: `Question for owner: ${asked}`, commenter: pr.author },
      now,
    );
  }

  const files = await withContentForUnpatched(deps.gh, repo.fullName, pr.headSha, await deps.gh.listPullRequestFiles(repo.fullName, pr.number));
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
    // From the default branch, so a PR can't mark its own files as generated.
    generated: generatedFromGitattributes((await deps.gh.readFile(repo.fullName, ".gitattributes", repo.defaultBranch).catch(() => null))?.text ?? ""),
  });

  const previous = submission.checkResults as StoredChecks | null;
  const sameSha = previous?.headSha === pr.headSha;
  const ciPendingSince = sameSha && previous?.ciPending && previous.ciPendingSince ? previous.ciPendingSince : now.toISOString();
  const ciRunning = results.some((r) => r.name === "CI" && /still running|no CI results yet/.test(r.detail));
  const ciPending = ciRunning && now.getTime() - new Date(ciPendingSince).getTime() < CI_MAX_WAIT_MS;
  const { passed, failed, warnings } = tally(results);

  const stored: StoredChecks = {
    headSha: pr.headSha,
    ranAt: now.toISOString(),
    results,
    passed,
    failed,
    warnings,
    ciPending,
    ciPendingSince: ciPending ? ciPendingSince : null,
    pr: { title: pr.title, url: pr.url, draft: pr.draft, body: pr.body ?? "", headRef: pr.headRef, author: pr.author },
    excerpts: buildExcerpts(pr.body, task.brief.acceptance, files),
    // Once per PR: GitHub keeps a review request across later pushes.
    reviewRequested: previous?.reviewRequested ?? false,
    readyAt: previous?.readyAt ?? (!ciPending && failed === 0 ? now.toISOString() : null),
    // The first run that finished (not one still waiting for CI) is the first pass.
    firstResults: previous?.firstResults ?? (ciPending ? undefined : results),
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

  await postCheckRun(deps.gh, repo.fullName, {
    ...checkRunOutput(results, ciPending),
    headSha: pr.headSha,
    ...(deps.appUrl ? { detailsUrl: `${deps.appUrl}/tasks/${task.id}` } : {}),
  });

  // GitHub is the owner's inbox: once the PR passes, ask for their review there, so GitHub's own notifications tell them.
  if (status === "in_review" && !stored.reviewRequested) {
    const [owner] = await db.select({ handle: users.handle }).from(users).where(eq(users.id, task.ownerId));
    // Done when GitHub took the request, when there's nobody to ask (the owner wrote the PR), or when GitHub
    // refused it for good (a 4xx). A passing failure (a 5xx, a timeout) is tried again on the next check.
    let settled = !owner || owner.handle.toLowerCase() === pr.author.toLowerCase();
    if (!settled) {
      try {
        await deps.gh.requestReview(repo.fullName, pr.number, owner!.handle);
        settled = true;
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0;
        settled = status >= 400 && status < 500;
      }
    }
    if (settled) {
      await db
        .update(submissions)
        .set({ checkResults: { ...stored, reviewRequested: true } })
        .where(eq(submissions.id, submission.id));
    }
  }

  if (ciPending) {
    // Check again once CI has had time to finish, whether or not GitHub tells us it did.
    await db
      .insert(jobs)
      .values({
        type: CHECKS_JOB,
        payload: job,
        dedupeKey: ciWaitKey(job, pr.headSha, new Date(now.getTime() + CI_WAIT_MS)),
        runAfter: new Date(now.getTime() + CI_WAIT_MS),
      })
      .onConflictDoNothing({ target: jobs.dedupeKey });
  }
  return { status: "checked", passed, failed, ciPending };
}

/** GitHub sends no patch for very large diffs; fetch those files whole (text only, up to 1 MB) so Secrets can scan them. */
async function withContentForUnpatched(gh: RepoGitHub, fullName: string, ref: string, files: ChangedFile[]): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  for (const f of files) {
    if (f.patch !== undefined || f.status === "removed") {
      out.push(f);
      continue;
    }
    const file = await gh.readFile(fullName, f.path, ref).catch(() => null);
    const text = file?.text;
    out.push(text !== undefined && !text.includes("\u0000") && text.length <= 1_000_000 ? { ...f, content: text } : f);
  }
  return out;
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
