import { and, eq, inArray, lte } from "drizzle-orm";
import { getUser, PermissionError } from "./admin";
import { canAdoptMilestone, canAdoptTask, canHandBack } from "./adoption-rules";
import { writeAudit } from "./audit";
import type { Db } from "./db/client";
import { adoptions, milestones, projects, repos, tasks } from "./db/schema";
import { lockExpiry, milestoneStatus } from "./lock";
import { canCloseOrRelease, type Decision } from "./permissions";
import { taskRef } from "./prompt";
import { loadTaskView, loadTaskViews } from "./views";

// Adopting, handing back and releasing (plan.md, "Adoption and task lifecycle").
// The database's one-active-adoption-per-task index is the final guard against
// two people taking the same work at the same moment.

function enforce(decision: Decision): void {
  if (!decision.ok) throw new PermissionError(decision.reason);
}

const isUniqueViolation = (err: unknown): boolean => {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
};

async function guardRace<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new PermissionError("Someone else took this on a moment ago.");
    throw err;
  }
}

/** Is the work's project (if any) open, and its repo still connected? */
async function workIsOpen(db: Db, task: { repoId: number; projectId: number | null }): Promise<boolean> {
  const [repo] = await db.select({ removedAt: repos.removedAt }).from(repos).where(eq(repos.id, task.repoId));
  if (!repo || repo.removedAt) return false;
  if (task.projectId === null) return true;
  const [project] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, task.projectId));
  return project?.status === "open";
}

/**
 * Marks adoptions whose lock ran out as expired, so a new one can take their
 * place. Only called after the rules said the task is free, so none of these
 * has an open PR keeping its lock.
 */
async function lapseExpired(db: Db, taskIds: number[], now: Date): Promise<void> {
  if (taskIds.length === 0) return;
  const lapsed = await db
    .select({ id: adoptions.id, expiresAt: adoptions.expiresAt })
    .from(adoptions)
    .where(and(inArray(adoptions.taskId, taskIds), eq(adoptions.status, "active"), lte(adoptions.expiresAt, now)));
  for (const a of lapsed) {
    await db.update(adoptions).set({ status: "expired", endedAt: a.expiresAt }).where(eq(adoptions.id, a.id));
  }
}

/** Stores the milestone's status after its tasks changed. */
export async function syncMilestoneStatus(db: Db, milestoneId: number | null, now: Date): Promise<void> {
  if (milestoneId === null) return;
  const views = await loadTaskViews(db, eq(tasks.milestoneId, milestoneId), now);
  await db
    .update(milestones)
    .set({ status: milestoneStatus(views), updatedAt: now })
    .where(eq(milestones.id, milestoneId));
}

/** Ends adoptions and puts their adopted tasks back on the board. */
export async function endAdoptions(
  db: Db,
  rows: { id: number; taskId: number }[],
  status: "released" | "completed",
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  await db.update(adoptions).set({ status, endedAt: now }).where(inArray(adoptions.id, rows.map((r) => r.id)));
  await db
    .update(tasks)
    .set({ status: "open", updatedAt: now })
    .where(and(inArray(tasks.id, rows.map((r) => r.taskId)), eq(tasks.status, "adopted")));
}

export async function adoptTask(db: Db, actorId: number, taskId: number, now: Date = new Date()): Promise<void> {
  await guardRace(() =>
    db.transaction(async (tx) => {
      const actor = await getUser(tx, actorId);
      const task = await loadTaskView(tx, taskId, now);
      if (!task) throw new PermissionError("That task doesn't exist.");
      const milestoneTasks =
        task.milestoneId === null ? undefined : await loadTaskViews(tx, eq(tasks.milestoneId, task.milestoneId), now);
      enforce(canAdoptTask(actor, task, { projectOpen: await workIsOpen(tx, task), milestoneTasks }));

      await lapseExpired(tx, [task.id], now);
      await tx.insert(adoptions).values({
        taskId: task.id,
        userId: actor.id,
        adoptedAt: now,
        expiresAt: lockExpiry(now),
        status: "active",
      });
      await tx.update(tasks).set({ status: "adopted", updatedAt: now }).where(eq(tasks.id, task.id));
      await syncMilestoneStatus(tx, task.milestoneId, now);
      await writeAudit(tx, {
        actorId: actor.id,
        action: "task.adopted",
        target: taskRef(task.id),
        details: { expiresAt: lockExpiry(now).toISOString() },
      });
    }),
  );
}

/** Takes every open task in a milestone, each with its own adoption row and the same 48-hour lock. */
export async function adoptMilestone(db: Db, actorId: number, milestoneId: number, now: Date = new Date()): Promise<number[]> {
  return guardRace(() =>
    db.transaction(async (tx) => {
      const actor = await getUser(tx, actorId);
      const [row] = await tx
        .select({ milestone: milestones, project: projects, removedAt: repos.removedAt })
        .from(milestones)
        .innerJoin(projects, eq(milestones.projectId, projects.id))
        .innerJoin(repos, eq(projects.repoId, repos.id))
        .where(eq(milestones.id, milestoneId));
      if (!row) throw new PermissionError("That milestone doesn't exist.");
      const views = await loadTaskViews(tx, eq(tasks.milestoneId, milestoneId), now);
      const decision = canAdoptMilestone(actor, {
        ownerId: row.project.ownerId,
        projectOpen: row.project.status === "open" && !row.removedAt,
        tasks: views,
      });
      if (!decision.ok) throw new PermissionError(decision.reason);

      await lapseExpired(tx, decision.taskIds, now);
      const expiresAt = lockExpiry(now);
      await tx.insert(adoptions).values(
        decision.taskIds.map((taskId) => ({
          taskId,
          userId: actor.id,
          milestoneId,
          adoptedAt: now,
          expiresAt,
          status: "active" as const,
        })),
      );
      await tx.update(tasks).set({ status: "adopted", updatedAt: now }).where(inArray(tasks.id, decision.taskIds));
      await syncMilestoneStatus(tx, milestoneId, now);
      await writeAudit(tx, {
        actorId: actor.id,
        action: "milestone.adopted",
        target: `milestone ${row.milestone.position} of project ${row.project.id}`,
        details: { tasks: decision.taskIds.map(taskRef), expiresAt: expiresAt.toISOString() },
      });
      return decision.taskIds;
    }),
  );
}

/** The adoptions that go together with one task's: all of a whole-milestone adoption, or just its own. */
async function holdingFor(db: Db, taskId: number, now: Date) {
  const task = await loadTaskView(db, taskId, now);
  if (!task) throw new PermissionError("That task doesn't exist.");
  if (!task.holder) throw new PermissionError("Nobody holds this task right now.");
  const holder = task.holder;
  const group =
    holder.milestoneId === null
      ? [task]
      : (await loadTaskViews(db, eq(tasks.milestoneId, holder.milestoneId), now)).filter(
          (t) => t.holder?.userId === holder.userId && t.holder.milestoneId === holder.milestoneId,
        );
  return { task, holder, group };
}

/**
 * Puts the holder's work back on the board: for a whole-milestone adoption,
 * every task they still hold in it; otherwise just this one. Also ends a lapsed
 * adoption still marked active. Returns the task ids that went back. Shared by
 * hand-back, release and reopen.
 */
export async function releaseHolding(db: Db, taskId: number, now: Date): Promise<number[]> {
  const task = await loadTaskView(db, taskId, now);
  if (!task) throw new PermissionError("That task doesn't exist.");
  if (!task.holder) {
    if (task.adoptionId) await endAdoptions(db, [{ id: task.adoptionId, taskId: task.id }], "released", now);
    return task.adoptionId ? [task.id] : [];
  }
  const { group } = await holdingFor(db, taskId, now);
  await endAdoptions(
    db,
    group.map((t) => ({ id: t.adoptionId!, taskId: t.id })),
    "released",
    now,
  );
  return group.map((t) => t.id);
}

/**
 * The contributor stops. For a whole-milestone adoption that hands back every
 * task they still hold in it; merged tasks stay done and the rest reopen.
 */
export async function handBack(db: Db, actorId: number, taskId: number, now: Date = new Date()): Promise<number[]> {
  return db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    const { task, holder, group } = await holdingFor(tx, taskId, now);
    enforce(canHandBack(actor, { holderId: holder.userId, hasOpenPr: group.some((t) => t.hasOpenPr) }));
    await releaseHolding(tx, taskId, now);
    await syncMilestoneStatus(tx, task.milestoneId, now);
    await writeAudit(tx, {
      actorId: actor.id,
      action: "adoption.handed_back",
      target: taskRef(task.id),
      details: { tasks: group.map((t) => taskRef(t.id)), wholeMilestone: holder.milestoneId !== null },
    });
    return group.map((t) => t.id);
  });
}

/** The owner or an admin frees stuck work early. */
export async function releaseAdoption(db: Db, actorId: number, taskId: number, now: Date = new Date()): Promise<number[]> {
  return db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    const { task, holder, group } = await holdingFor(tx, taskId, now);
    enforce(canCloseOrRelease(actor, task));
    await releaseHolding(tx, taskId, now);
    await syncMilestoneStatus(tx, task.milestoneId, now);
    await writeAudit(tx, {
      actorId: actor.id,
      action: "adoption.released",
      target: taskRef(task.id),
      details: { holder: holder.handle, tasks: group.map((t) => taskRef(t.id)) },
    });
    return group.map((t) => t.id);
  });
}
