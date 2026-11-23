import { writeAudit } from "@/lib/audit";
import type { Db } from "@/lib/db/client";
import type { JobHandler, Logger } from "@/lib/jobs";
import { WEBHOOK_JOB, type GitHubWebhookJob } from "@/lib/github/webhook";

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

  // Repos, pull requests and checks are handled from Milestone 2 on.
  log.info(`GitHub webhook ${label} received (delivery ${job.deliveryId}); no action needed yet`);
}

export const handlers: Record<string, JobHandler> = {
  [WEBHOOK_JOB]: (db, payload, log) =>
    handleGitHubWebhook(db, payload as GitHubWebhookJob, log),
};
