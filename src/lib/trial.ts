import { and, eq, inArray } from "drizzle-orm";
import type { StoredChecks } from "./checks/run";
import { CHECK_ORDER, type CheckName } from "./checks/types";
import type { Db } from "./db/client";
import { adoptions, alerts, auditLog, milestones, projects, questions, submissions, tasks, users } from "./db/schema";
import type { SizeTier, TaskKind } from "./db/schema";

// The Trial panel (plan.md, "Trial success targets" and Milestone 5): how the
// trial is going, worked out from what the site already records. It replaces
// the monthly admin report and is always current.

export type Target = { label: string; value: string; met: boolean };

export type TrialReport = {
  targets: Target[];
  merged: {
    total: number;
    byContributors: number;
    byOwners: number;
    byProfile: { developer: number; guided: number };
    byKind: Record<TaskKind, number>;
    byTier: Record<SizeTier, number>;
  };
  reopens: { developer: number; guided: number };
  /** Minutes from a PR first passing its gates to its merge. Null with no data yet. */
  medianReadyToMergedMinutes: number | null;
  /** Share of PRs whose first check run passed each check. */
  firstPass: { name: CheckName; passed: number; of: number }[];
  milestonesWithHelp: number;
  now: { prsWaitingOnOwner: number; openQuestions: number; openAlerts: number };
};

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export async function loadTrialReport(db: Db): Promise<TrialReport> {
  // Every merged task, with who (if anyone) took it on.
  const mergedTasks = await db
    .select({ task: tasks, adopterProfile: users.profile, adopterId: adoptions.userId })
    .from(tasks)
    .leftJoin(adoptions, and(eq(adoptions.taskId, tasks.id), eq(adoptions.status, "completed")))
    .leftJoin(users, eq(adoptions.userId, users.id))
    .where(eq(tasks.status, "merged"));
  const merged: TrialReport["merged"] = {
    total: mergedTasks.length,
    byContributors: 0,
    byOwners: 0,
    byProfile: { developer: 0, guided: 0 },
    byKind: { code: 0, other: 0 },
    byTier: { small: 0, medium: 0, large: 0 },
  };
  for (const m of mergedTasks) {
    if (m.adopterId && m.adopterId !== m.task.ownerId) {
      merged.byContributors++;
      if (m.adopterProfile === "guided") merged.byProfile.guided++;
      else merged.byProfile.developer++;
    } else merged.byOwners++;
    merged.byKind[m.task.kind]++;
    merged.byTier[m.task.sizeTier]++;
  }
  const helped = mergedTasks.filter((m) => m.adopterId && m.adopterId !== m.task.ownerId);

  // Reopens, by the profile of whoever held the task.
  const reopenRows = await db.select({ details: auditLog.details }).from(auditLog).where(eq(auditLog.action, "task.reopened"));
  const handles = reopenRows.map((r) => (r.details as { holder?: string | null } | null)?.holder).filter((h): h is string => Boolean(h));
  const profiles = handles.length
    ? new Map((await db.select({ handle: users.handle, profile: users.profile }).from(users).where(inArray(users.handle, handles))).map((u) => [u.handle, u.profile]))
    : new Map<string, string | null>();
  const reopens = { developer: 0, guided: 0 };
  for (const h of handles) {
    if (profiles.get(h) === "guided") reopens.guided++;
    else reopens.developer++;
  }

  // Review wait and first-pass rates come from what the checks stored.
  const subs = await db
    .select({
      status: submissions.status,
      checks: submissions.checkResults,
      updatedAt: submissions.updatedAt,
      authorId: submissions.authorId,
      ownerId: tasks.ownerId,
    })
    .from(submissions)
    .innerJoin(tasks, eq(submissions.taskId, tasks.id));
  const waits: number[] = [];
  const firstPass = new Map<CheckName, { passed: number; of: number }>(CHECK_ORDER.map((n) => [n, { passed: 0, of: 0 }]));
  for (const s of subs) {
    const c = s.checks as StoredChecks | null;
    // The review wait is about owners reviewing coworkers' PRs, so an owner's own PR doesn't count.
    if (s.status === "merged" && c?.readyAt && s.authorId !== s.ownerId) waits.push((s.updatedAt.getTime() - new Date(c.readyAt).getTime()) / 60_000);
    for (const r of c?.firstResults ?? []) {
      const f = firstPass.get(r.name);
      if (!f) continue;
      f.of++;
      if (r.passed) f.passed++;
    }
  }

  // Milestones finished with help from someone other than the project's owner.
  const doneMilestones = await db
    .select({ id: milestones.id, ownerId: projects.ownerId })
    .from(milestones)
    .innerJoin(projects, eq(milestones.projectId, projects.id))
    .where(eq(milestones.status, "done"));
  const helpedMilestones = new Set(helped.map((m) => m.task.milestoneId).filter((id): id is number => id !== null));
  const milestonesWithHelp = doneMilestones.filter((m) => helpedMilestones.has(m.id)).length;

  const prsWaitingOnOwner = subs.filter((s) => s.status === "in_review" || s.status === "checks_failed").length;
  const openQuestions = (await db.select({ answeredAt: questions.answeredAt }).from(questions)).filter((q) => !q.answeredAt).length;
  const openAlerts = (await db.select({ resolvedAt: alerts.resolvedAt }).from(alerts)).filter((a) => !a.resolvedAt).length;

  const wait = median(waits);
  const rate = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "no data yet");
  const devTotal = merged.byProfile.developer + reopens.developer;
  const guidedTotal = merged.byProfile.guided + reopens.guided;
  const targets: Target[] = [
    { label: "At least 5 tasks merged with a coworker's help", value: String(helped.length), met: helped.length >= 5 },
    { label: "At least 2 of them from Guided users", value: String(merged.byProfile.guided), met: merged.byProfile.guided >= 2 },
    {
      label: "At least 1 of them not code",
      value: String(helped.filter((m) => m.task.kind === "other").length),
      met: helped.some((m) => m.task.kind === "other"),
    },
    { label: "At least one milestone finished with outside help", value: String(milestonesWithHelp), met: milestonesWithHelp >= 1 },
    {
      label: "Median wait from ready for review to merged under 15 minutes",
      value: wait === null ? "no data yet" : `${Math.round(wait)} min`,
      met: wait !== null && wait < 15,
    },
    {
      label: "Fewer than half of Developer PRs reopened",
      value: rate(reopens.developer, devTotal),
      met: devTotal > 0 && reopens.developer / devTotal < 0.5,
    },
    {
      label: "Fewer than half of Guided PRs reopened",
      value: rate(reopens.guided, guidedTotal),
      met: guidedTotal > 0 && reopens.guided / guidedTotal < 0.5,
    },
  ];

  return {
    targets,
    merged,
    reopens,
    medianReadyToMergedMinutes: wait,
    firstPass: CHECK_ORDER.map((name) => ({ name, ...firstPass.get(name)! })),
    milestonesWithHelp,
    now: { prsWaitingOnOwner, openQuestions, openAlerts },
  };
}
