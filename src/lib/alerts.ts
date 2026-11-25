import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getUser, PermissionError } from "./admin";
import { writeAudit } from "./audit";
import type { Db } from "./db/client";
import { alerts, jobs, repos, submissions, tasks, users, type Repo } from "./db/schema";
import type { RepoGitHub } from "./github/repos";
import { taskRef } from "./prompt";

// The unreviewed-merge alert (plan.md, "Unreviewed-merge alert"). Free GitHub
// orgs can't protect branches on private repos, so the site watches merges and
// pushes to the default branch. A merge by anyone other than the task owner or
// a repo admin, or a push that didn't come through an owner-merged PR, raises
// an alert on the admin page and a warning on the task page. Repo admin status
// comes from GitHub's collaborator permission API, checked fresh.

export const PUSH_ALERT_JOB = "push_alert_check";
export type PushAlertJob = { repoId: number; after: string; before: string; pusher: string | null; forced: boolean };

/** Waits a moment, so GitHub has the merged PR on record before a push is judged. */
export const PUSH_CHECK_DELAY_MS = 30_000;

const isZeroSha = (sha: string) => /^0+$/.test(sha);

async function isRepoAdmin(gh: RepoGitHub, fullName: string, login: string | null): Promise<boolean> {
  if (!login) return false;
  return (await gh.permission(fullName, login)) === "admin";
}

/** The task a PR is linked to, with its owner's handle, or null. */
async function linkedTask(db: Db, repoId: number, prNumber: number) {
  const [row] = await db
    .select({ taskId: tasks.id, ownerHandle: users.handle })
    .from(submissions)
    .innerJoin(tasks, eq(submissions.taskId, tasks.id))
    .innerJoin(users, eq(tasks.ownerId, users.id))
    .where(and(eq(tasks.repoId, repoId), eq(submissions.prNumber, prNumber)))
    .orderBy(desc(submissions.id))
    .limit(1);
  return row ?? null;
}

/** Did the task owner or a repo admin merge it? An unlinked PR needs a repo admin. */
async function reviewedMerge(db: Db, gh: RepoGitHub, repo: Repo, prNumber: number, mergedBy: string | null) {
  const linked = await linkedTask(db, repo.id, prNumber);
  if (linked && mergedBy && linked.ownerHandle.toLowerCase() === mergedBy.toLowerCase()) return { ok: true, linked };
  return { ok: await isRepoAdmin(gh, repo.fullName, mergedBy), linked };
}

async function raise(
  db: Db,
  repo: Repo,
  kind: "unreviewed_merge" | "direct_push",
  key: { field: "pr" | "sha"; value: string | number },
  details: Record<string, unknown>,
  now: Date,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.repoId, repo.id),
        eq(alerts.kind, kind),
        isNull(alerts.resolvedAt),
        sql`${alerts.details}->>${key.field} = ${String(key.value)}`,
      ),
    );
  if (existing) return false;
  await db.insert(alerts).values({ repoId: repo.id, kind, details: { ...details, [key.field]: key.value }, createdAt: now });
  await writeAudit(db, {
    actorId: null,
    action: `alert.${kind}`,
    target: typeof details.taskId === "number" ? taskRef(details.taskId) : repo.fullName,
    details: { repo: repo.fullName, ...details, [key.field]: key.value },
  });
  return true;
}

/** A linked PR was merged: alert unless the task owner or a repo admin merged it. */
export async function checkMerge(
  db: Db,
  gh: RepoGitHub,
  input: { repo: Repo; prNumber: number; mergedBy: string | null; mergeCommitSha: string | null },
  now: Date = new Date(),
): Promise<"reviewed" | "alert" | "not_linked"> {
  const { ok, linked } = await reviewedMerge(db, gh, input.repo, input.prNumber, input.mergedBy);
  if (!linked) return "not_linked";
  if (ok) return "reviewed";
  await raise(
    db,
    input.repo,
    "unreviewed_merge",
    { field: "pr", value: input.prNumber },
    { taskId: linked.taskId, mergedBy: input.mergedBy, owner: linked.ownerHandle, mergeCommitSha: input.mergeCommitSha },
    now,
  );
  return "alert";
}

/** Queues the check for a push to the default branch. */
export async function queuePushCheck(db: Db, job: PushAlertJob, now: Date = new Date()): Promise<void> {
  if (isZeroSha(job.after)) return; // the branch was deleted
  await db
    .insert(jobs)
    .values({
      type: PUSH_ALERT_JOB,
      payload: job,
      dedupeKey: `push:${job.repoId}@${job.after}`,
      runAfter: new Date(now.getTime() + PUSH_CHECK_DELAY_MS),
    })
    .onConflictDoNothing({ target: jobs.dedupeKey });
}

/**
 * A push to the default branch: fine when its head commit is the merge commit
 * of a PR the task owner or a repo admin merged. A linked PR merged by someone
 * else already raised an unreviewed_merge alert. Anything else is a direct push.
 */
export async function checkPush(
  db: Db,
  gh: RepoGitHub,
  job: PushAlertJob,
  now: Date = new Date(),
): Promise<"reviewed" | "alerted_on_merge" | "alert" | "admin_push" | "skipped"> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, job.repoId));
  if (!repo || repo.removedAt || isZeroSha(job.after)) return "skipped";
  // A forced push rewrites history, even when it lands on an owner-merged commit.
  if (job.forced) {
    await raise(db, repo, "direct_push", { field: "sha", value: job.after }, { pusher: job.pusher, forced: true, before: job.before }, now);
    return "alert";
  }
  for (const number of await gh.pullsForCommit(repo.fullName, job.after)) {
    const pr = await gh.getPullRequest(repo.fullName, number);
    if (!pr?.merged || pr.mergeCommitSha !== job.after || pr.baseRef !== repo.defaultBranch) continue;
    const { ok, linked } = await reviewedMerge(db, gh, repo, pr.number, pr.mergedBy);
    if (ok) return "reviewed";
    if (linked) {
      await checkMerge(db, gh, { repo, prNumber: pr.number, mergedBy: pr.mergedBy, mergeCommitSha: pr.mergeCommitSha }, now);
      return "alerted_on_merge";
    }
    await raise(db, repo, "direct_push", { field: "sha", value: job.after }, { pr: pr.number, mergedBy: pr.mergedBy, pusher: job.pusher }, now);
    return "alert";
  }
  // Repo admins push their own work to the default branch; that's logged, not alerted (forced pushes alerted above).
  if (await isRepoAdmin(gh, repo.fullName, job.pusher)) {
    await writeAudit(db, { actorId: null, action: "push.by_admin", target: repo.fullName, details: { sha: job.after, pusher: job.pusher } });
    return "admin_push";
  }
  await raise(db, repo, "direct_push", { field: "sha", value: job.after }, { pusher: job.pusher, forced: job.forced, before: job.before }, now);
  return "alert";
}

// ---------- reading and resolving ----------

export type OpenAlert = {
  id: number;
  kind: "unreviewed_merge" | "direct_push";
  repoFullName: string;
  details: Record<string, unknown>;
  createdAt: Date;
};

export async function listOpenAlerts(db: Db): Promise<OpenAlert[]> {
  const rows = await db
    .select({ alert: alerts, repoFullName: repos.fullName })
    .from(alerts)
    .innerJoin(repos, eq(alerts.repoId, repos.id))
    .where(isNull(alerts.resolvedAt))
    .orderBy(desc(alerts.createdAt), desc(alerts.id));
  return rows.map((r) => ({
    id: r.alert.id,
    kind: r.alert.kind,
    repoFullName: r.repoFullName,
    details: r.alert.details as Record<string, unknown>,
    createdAt: r.alert.createdAt,
  }));
}

/** Open alerts about one task, for the warning on its page. */
export async function openAlertsForTask(db: Db, taskId: number): Promise<OpenAlert[]> {
  return (await listOpenAlerts(db)).filter((a) => a.details.taskId === taskId);
}

/** One line for an alert, e.g. "PR #7 (PI-12) merged by @bob, not the task owner or a repo admin". */
export function describeAlert(a: Pick<OpenAlert, "kind" | "details" | "repoFullName">): string {
  const d = a.details;
  if (a.kind === "unreviewed_merge") {
    return `PR #${d.pr} (${taskRef(Number(d.taskId))}) in ${a.repoFullName} was merged by @${d.mergedBy ?? "someone"}, not the task owner @${d.owner} or a repo admin.`;
  }
  const sha = String(d.sha ?? "").slice(0, 7);
  return d.pr
    ? `${a.repoFullName}'s default branch moved to ${sha} through PR #${d.pr}, merged by @${d.mergedBy ?? "someone"}, who isn't a repo admin.`
    : `${a.repoFullName}'s default branch moved to ${sha} without an owner-merged PR${d.pusher ? ` (pushed by @${d.pusher}${d.forced ? ", forced" : ""})` : ""}.`;
}

/** The main admin marks an alert as looked at. */
export async function resolveAlert(db: Db, actorId: number, alertId: number, now: Date = new Date()): Promise<void> {
  const actor = await getUser(db, actorId);
  if (!actor.isMainAdmin || actor.blocked) throw new PermissionError("Only the main admin can resolve alerts.");
  const [row] = await db
    .update(alerts)
    .set({ resolvedAt: now, resolvedById: actor.id })
    .where(and(eq(alerts.id, alertId), isNull(alerts.resolvedAt)))
    .returning();
  if (!row) throw new PermissionError("That alert is already resolved.");
  await writeAudit(db, { actorId: actor.id, action: "alert.resolved", target: `alert ${alertId}`, details: { kind: row.kind } });
}
