import { checkMerge, checkPush, PUSH_ALERT_JOB, queuePushCheck, type PushAlertJob } from "@/lib/alerts";
import { writeAudit } from "@/lib/audit";
import { gitleaksScanner } from "@/lib/checks/gitleaks";
import { parseTaskLine } from "@/lib/checks/pr-body";
import { CHECKS_JOB, queueChecks, runChecks, type ChecksJob } from "@/lib/checks/run";
import type { SecretScanner } from "@/lib/checks/secrets";
import { SITE_CHECK_NAME } from "@/lib/checks/types";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { createRepoGitHub } from "@/lib/github/app";
import type { RepoGitHub } from "@/lib/github/repos";
import type { JobHandler, Logger } from "@/lib/jobs";
import { WEBHOOK_JOB, type GitHubWebhookJob } from "@/lib/github/webhook";
import { handlePullRequestEvent } from "@/lib/pr-link";
import { handlePrClosed, renewLock } from "@/lib/merge";
import { recordQuestion } from "@/lib/questions";
import { refreshRepo, reposForPush } from "@/lib/repos";
import { queueSweep, runSweep, SWEEP_JOB } from "@/lib/sweep";

/** What the handlers need from outside. Tests pass a fake GitHub and a fake scanner. */
/** What the handlers need from outside. Tests pass a fake GitHub and a fake scanner. `appId` is the Pitch In App's own id. */
export type HandlerDeps = {
  repoGitHub: () => RepoGitHub;
  scanner?: () => SecretScanner;
  appId?: () => number | null;
  /** The site's address, for the check run's Details link. */
  appUrl?: () => string;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const INSTALLATION_ACTIONS: Record<string, string> = {
  created: "github.app_installed",
  deleted: "github.app_uninstalled",
  suspend: "github.app_suspended",
  unsuspend: "github.app_unsuspended",
};

/** pull_request actions that can change what the checks say. */
const CHECKED_ACTIONS = new Set(["opened", "reopened", "edited", "synchronize", "ready_for_review", "converted_to_draft"]);

export async function handleGitHubWebhook(
  db: Db,
  job: GitHubWebhookJob,
  log: Logger,
  deps: HandlerDeps,
): Promise<void> {
  const body = obj(job.body);
  const sender = str(obj(body.sender).login);
  const label = job.action ? `${job.event}.${job.action}` : job.event;

  if (job.event === "installation" && job.action && INSTALLATION_ACTIONS[job.action]) {
    const installation = obj(body.installation);
    const account = str(obj(installation.account).login) ?? "unknown";
    await writeAudit(db, {
      actorId: null,
      action: INSTALLATION_ACTIONS[job.action],
      target: account,
      details: {
        installationId: installation.id,
        sender,
        deliveryId: job.deliveryId,
      },
    });
    log.info(`GitHub webhook ${label}: ${INSTALLATION_ACTIONS[job.action]} on ${account} by ${sender ?? "unknown"}`);
    return;
  }

  const repository = obj(body.repository);
  const [repo] = Number(repository.id) ? await reposForPush(db, Number(repository.id)) : [];

  // A push to a connected repo's default branch: re-read PROJECT_BRIEF.md and CI.
  if (job.event === "push") {
    const branch = str(repository.default_branch);
    if (!branch || str(body.ref) !== `refs/heads/${branch}`) {
      log.info(`GitHub webhook push to a branch other than the default (delivery ${job.deliveryId}); nothing to refresh`);
      return;
    }
    if (!repo) {
      log.info(`GitHub webhook push to ${str(repository.full_name) ?? repository.id}, which isn't connected; ignored`);
      return;
    }
    // Did this change to the default branch come through an owner-merged PR? Checked shortly, by its own job,
    // queued first so a failing refresh can't skip it.
    const after = str(body.after);
    if (after) {
      await queuePushCheck(db, {
        repoId: repo.id,
        after,
        before: str(body.before) ?? "",
        pusher: sender ?? str(obj(body.pusher).name) ?? null,
        forced: body.forced === true,
      });
    }
    const updated = await refreshRepo(db, deps.repoGitHub(), repo.id);
    log.info(
      `Refreshed ${updated.fullName} after a push: CI ${updated.hasCi ? "found" : "missing"}, PROJECT_BRIEF.md ${updated.projectBrief ? "found" : "missing"}`,
    );
    return;
  }

  if (!repo && ["pull_request", "check_suite", "check_run", "issue_comment"].includes(job.event)) {
    log.info(`GitHub webhook ${label} on ${str(repository.full_name) ?? "a repo"} that isn't connected; ignored`);
    return;
  }

  // A PR event: link the PR to its task (or record why it didn't link), then check it.
  if (job.event === "pull_request" && repo) {
    const pr = obj(body.pull_request);
    const outcome = await handlePullRequestEvent(db, job.action, body, {
      id: repo.id,
      fullName: repo.fullName,
      defaultBranch: str(repository.default_branch) ?? repo.defaultBranch,
    });
    if (!outcome) log.info(`GitHub webhook ${label} needs no linking`);
    else if (outcome.status === "ignored") log.info(`GitHub webhook ${label}: PR isn't into the default branch; ignored`);
    else if (outcome.status === "linked") log.info(`GitHub webhook ${label}: PR linked to task ${outcome.taskId}`);
    else log.info(`GitHub webhook ${label}: PR not linked: ${outcome.reason}`);

    // Closed: merged moves the task and milestone on; closed without a merge leaves the task with its adopter.
    if (job.action === "closed") {
      const closed = await handlePrClosed(db, {
        repoId: repo.id,
        prNumber: Number(pr.number),
        merged: pr.merged === true,
        mergedBy: str(obj(pr.merged_by).login) ?? null,
        mergeCommitSha: str(pr.merge_commit_sha) ?? null,
        baseRef: str(obj(pr.base).ref),
        defaultBranch: str(repository.default_branch) ?? repo.defaultBranch,
      });
      log.info(`GitHub webhook ${label}: PR #${pr.number} ${closed.status === "merged" ? `merged, task ${closed.taskId} done` : closed.status.replace("_", " ")}`);
      if (pr.merged === true && str(obj(pr.base).ref) === (str(repository.default_branch) ?? repo.defaultBranch)) {
        const verdict = await checkMerge(db, deps.repoGitHub(), {
          repo,
          prNumber: Number(pr.number),
          mergedBy: str(obj(pr.merged_by).login) ?? null,
          mergeCommitSha: str(pr.merge_commit_sha) ?? null,
        });
        if (verdict === "alert") log.info(`GitHub webhook ${label}: PR #${pr.number} merged by someone other than the task owner or a repo admin; alert raised`);
      }
      return;
    }

    // A linked PR opening renews the adopter's lock (the whole milestone's, for a milestone adoption).
    if (outcome?.status === "linked" && ["opened", "reopened", "ready_for_review"].includes(job.action ?? "")) {
      await renewLock(db, outcome.taskId, new Date());
    }

    const headSha = str(obj(pr.head).sha);
    const named = outcome?.status === "unlinked" && parseTaskLine(str(pr.body)) !== null;
    if (job.action && CHECKED_ACTIONS.has(job.action) && headSha && (outcome?.status === "linked" || named)) {
      await queueChecks(db, { repoId: repo.id, prNumber: Number(pr.number) }, headSha);
      log.info(`GitHub webhook ${label}: checks queued for PR #${pr.number} at ${headSha.slice(0, 7)}`);
    }
    return;
  }

  // The repo's own CI finished: check its PRs again. Our own check run never triggers this.
  if ((job.event === "check_suite" || job.event === "check_run") && repo) {
    const thing = obj(job.event === "check_suite" ? body.check_suite : body.check_run);
    // Our own check suite or run finishing never triggers this. The App can be renamed, so its id decides.
    const ourId = deps.appId?.() ?? null;
    const fromUs = ourId !== null ? Number(obj(thing.app).id) === ourId : Boolean(str(obj(thing.app).name)?.startsWith("Pitch In"));
    if (job.action !== "completed" || str(thing.name) === SITE_CHECK_NAME || fromUs) {
      log.info(`GitHub webhook ${label}: nothing to check again`);
      return;
    }
    const headSha = str(thing.head_sha);
    const prs = Array.isArray(thing.pull_requests) ? thing.pull_requests.map(obj) : [];
    for (const pr of prs) {
      if (!headSha || !Number(pr.number)) continue;
      await queueChecks(db, { repoId: repo.id, prNumber: Number(pr.number) }, headSha);
    }
    log.info(`GitHub webhook ${label}: checks queued again for ${prs.length} PR(s)`);
    return;
  }

  // A comment on a PR: a contributor's agent may have left a question for the owner.
  if (job.event === "issue_comment" && repo) {
    const issue = obj(body.issue);
    const comment = obj(body.comment);
    if (job.action !== "created" || !issue.pull_request) {
      log.info(`GitHub webhook ${label}: not a new PR comment; ignored`);
      return;
    }
    const out = await recordQuestion(db, {
      repoId: repo.id,
      prNumber: Number(issue.number),
      commentId: Number(comment.id),
      body: str(comment.body) ?? "",
      commenter: str(obj(comment.user).login) ?? "",
    });
    log.info(
      out.status === "asked"
        ? `GitHub webhook ${label}: question for the owner on PR #${issue.number} (task ${out.taskId})`
        : `GitHub webhook ${label}: ${out.why}`,
    );
    return;
  }

  log.info(`GitHub webhook ${label} received (delivery ${job.deliveryId}); no action needed`);
}

export async function handleChecksJob(db: Db, job: ChecksJob, log: Logger, deps: HandlerDeps): Promise<void> {
  const outcome = await runChecks(
    db,
    { gh: deps.repoGitHub(), scanner: (deps.scanner ?? gitleaksScanner)(), appUrl: deps.appUrl?.() },
    job,
  );
  const what = `PR #${job.prNumber} in repo ${job.repoId}`;
  if (outcome.status === "skipped") log.info(`Checks for ${what} skipped: ${outcome.why}`);
  else if (outcome.status === "unlinked") log.info(`Checks for ${what}: not linked (${outcome.reason})`);
  else
    log.info(
      `Checks for ${what}: ${outcome.passed} passed, ${outcome.failed} failed${outcome.ciPending ? ", waiting for CI" : ""}`,
    );
}

export async function handlePushAlertJob(db: Db, job: PushAlertJob, log: Logger, deps: HandlerDeps): Promise<void> {
  const verdict = await checkPush(db, deps.repoGitHub(), job);
  log.info(`Push to repo ${job.repoId} at ${job.after.slice(0, 7)}: ${verdict === "alert" ? "no owner-merged PR, alert raised" : verdict.replace(/_/g, " ")}`);
}

export async function handleSweepJob(db: Db, log: Logger, deps: HandlerDeps): Promise<void> {
  try {
    const r = await runSweep(db, deps.repoGitHub());
    if (r.queued || r.questions) log.info(`Catch-up sweep: looked at ${r.looked} PR(s), queued checks for ${r.queued}, picked up ${r.questions} question(s)`);
  } finally {
    // Always schedule the next one, even if GitHub couldn't be reached this time.
    await queueSweep(db, new Date());
  }
}

export function createHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  return {
    [SWEEP_JOB]: (db, _payload, log) => handleSweepJob(db, log, deps),
    [PUSH_ALERT_JOB]: (db, payload, log) => handlePushAlertJob(db, payload as PushAlertJob, log, deps),
    [WEBHOOK_JOB]: (db, payload, log) => handleGitHubWebhook(db, payload as GitHubWebhookJob, log, deps),
    [CHECKS_JOB]: (db, payload, log) => handleChecksJob(db, payload as ChecksJob, log, deps),
  };
}

export const handlers = createHandlers({
  repoGitHub: () => createRepoGitHub(getConfig()),
  appUrl: () => getConfig().appUrl,
  appId: () => {
    const id = Number(getConfig().githubApp?.appId);
    return Number.isFinite(id) && id > 0 ? id : null;
  },
  scanner: () => gitleaksScanner(),
});
