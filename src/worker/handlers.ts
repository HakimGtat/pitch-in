import { writeAudit } from "@/lib/audit";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { createRepoGitHub } from "@/lib/github/app";
import type { RepoGitHub } from "@/lib/github/repos";
import type { JobHandler, Logger } from "@/lib/jobs";
import { WEBHOOK_JOB, type GitHubWebhookJob } from "@/lib/github/webhook";
import { handlePullRequestEvent } from "@/lib/pr-link";
import { refreshRepo, reposForPush } from "@/lib/repos";

/** What the handlers need from outside. Tests pass a fake GitHub. */
export type HandlerDeps = { repoGitHub: () => RepoGitHub };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const INSTALLATION_ACTIONS: Record<string, string> = {
  created: "github.app_installed",
  deleted: "github.app_uninstalled",
  suspend: "github.app_suspended",
  unsuspend: "github.app_unsuspended",
};

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

  // A push to a connected repo's default branch: re-read PROJECT_BRIEF.md and CI.
  if (job.event === "push") {
    const repository = obj(body.repository);
    const githubRepoId = Number(repository.id);
    const branch = str(repository.default_branch);
    if (!githubRepoId || !branch || str(body.ref) !== `refs/heads/${branch}`) {
      log.info(`GitHub webhook push to a branch other than the default (delivery ${job.deliveryId}); nothing to refresh`);
      return;
    }
    const [repo] = await reposForPush(db, githubRepoId);
    if (!repo) {
      log.info(`GitHub webhook push to ${str(repository.full_name) ?? githubRepoId}, which isn't connected; ignored`);
      return;
    }
    const updated = await refreshRepo(db, deps.repoGitHub(), repo.id);
    log.info(
      `Refreshed ${updated.fullName} after a push: CI ${updated.hasCi ? "found" : "missing"}, PROJECT_BRIEF.md ${updated.projectBrief ? "found" : "missing"}`,
    );
    return;
  }

  // A PR event: link the PR to its task (or record why it didn't link).
  if (job.event === "pull_request") {
    const repository = obj(body.repository);
    const [repo] = await reposForPush(db, Number(repository.id));
    if (!repo) {
      log.info(`GitHub webhook ${label} on ${str(repository.full_name) ?? "a repo"} that isn't connected; ignored`);
      return;
    }
    const outcome = await handlePullRequestEvent(db, job.action, body, {
      id: repo.id,
      fullName: repo.fullName,
      defaultBranch: str(repository.default_branch) ?? repo.defaultBranch,
    });
    if (!outcome) log.info(`GitHub webhook ${label} needs no linking`);
    else if (outcome.status === "ignored") log.info(`GitHub webhook ${label}: PR isn't into the default branch; ignored`);
    else if (outcome.status === "linked") log.info(`GitHub webhook ${label}: PR linked to task ${outcome.taskId}`);
    else log.info(`GitHub webhook ${label}: PR not linked: ${outcome.reason}`);
    return;
  }

  // Checks and merges are handled from the next tasks on.
  log.info(`GitHub webhook ${label} received (delivery ${job.deliveryId}); no action needed yet`);
}

export function createHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  return {
    [WEBHOOK_JOB]: (db, payload, log) =>
      handleGitHubWebhook(db, payload as GitHubWebhookJob, log, deps),
  };
}

export const handlers = createHandlers({ repoGitHub: () => createRepoGitHub(getConfig()) });
