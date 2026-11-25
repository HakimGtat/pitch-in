import { and, desc, eq } from "drizzle-orm";
import { nextTaskInMilestone } from "./adoption-rules";
import { syncMilestoneStatus } from "./adoption";
import { writeAudit } from "./audit";
import type { Db } from "./db/client";
import { adoptions, milestones, projects, repos, submissions, tasks } from "./db/schema";
import { lockExpiry } from "./lock";
import { taskRef } from "./prompt";
import { answerQuestionsFor } from "./questions";
import { loadTaskViews } from "./views";
import { finishProject } from "./work";

// Merges (plan.md, "Adoption and task lifecycle"). The site never merges: it
// learns about a merge from GitHub's pull_request "closed" webhook with
// merged true, then closes the task, moves the milestone on and gives the
// contributor a "helped ship" entry. Delivering the same webhook again
// changes nothing.

export type ClosedPr = {
  repoId: number;
  prNumber: number;
  merged: boolean;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  /** Where the PR was merged. A merge into any branch but the default one doesn't finish the task. */
  baseRef?: string;
  defaultBranch?: string;
};

export type CloseOutcome =
  | { status: "not_linked" }
  | { status: "already_done" }
  | { status: "closed"; taskId: number }
  | { status: "merged"; taskId: number; nextTaskId: number | null; milestoneDone: boolean; projectDone: boolean };

const FINISHED_SUBMISSION = new Set(["merged", "closed", "rejected"]);

/**
 * Renews the 48-hour lock when one of the adopter's PRs is opened or merged:
 * every task they hold in the milestone for a whole-milestone adoption,
 * otherwise just this task's.
 */
export async function renewLock(db: Db, taskId: number, now: Date, onlyFor?: number): Promise<number> {
  const [a] = await db
    .select()
    .from(adoptions)
    .where(and(eq(adoptions.taskId, taskId), eq(adoptions.status, "active")));
  // Only the adopter's own PR renews their lock (not, say, the owner's own PR on the same task).
  if (!a || (onlyFor !== undefined && a.userId !== onlyFor)) return 0;
  const rows = await db
    .update(adoptions)
    .set({ expiresAt: lockExpiry(now) })
    .where(
      a.milestoneId === null
        ? eq(adoptions.id, a.id)
        : and(eq(adoptions.userId, a.userId), eq(adoptions.milestoneId, a.milestoneId), eq(adoptions.status, "active")),
    )
    .returning({ id: adoptions.id });
  return rows.length;
}

export async function handlePrClosed(db: Db, pr: ClosedPr, now: Date = new Date()): Promise<CloseOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ submission: submissions, task: tasks })
      .from(submissions)
      .innerJoin(tasks, eq(submissions.taskId, tasks.id))
      .where(and(eq(tasks.repoId, pr.repoId), eq(submissions.prNumber, pr.prNumber)))
      .orderBy(desc(submissions.id))
      .limit(1);
    if (!row) return { status: "not_linked" as const };
    const { submission, task } = row;
    if (FINISHED_SUBMISSION.has(submission.status)) return { status: "already_done" as const };
    await answerQuestionsFor(tx, [submission.id], now);

    const [adoption] = await tx
      .select()
      .from(adoptions)
      .where(and(eq(adoptions.taskId, task.id), eq(adoptions.status, "active")));

    const merged = pr.merged && (!pr.baseRef || !pr.defaultBranch || pr.baseRef === pr.defaultBranch);
    if (!merged) {
      // Closed without a merge: the task stays the adopter's (or open, if nobody holds it).
      await tx.update(submissions).set({ status: "closed", updatedAt: now }).where(eq(submissions.id, submission.id));
      if (task.status === "in_review") {
        await tx
          .update(tasks)
          .set({ status: adoption ? "adopted" : "open", updatedAt: now })
          .where(eq(tasks.id, task.id));
      }
      await writeAudit(tx, { actorId: null, action: "pr.closed_unmerged", target: taskRef(task.id), details: { pr: pr.prNumber } });
      return { status: "closed" as const, taskId: task.id };
    }

    await tx.update(submissions).set({ status: "merged", updatedAt: now }).where(eq(submissions.id, submission.id));
    await tx.update(tasks).set({ status: "merged", closedAt: now, updatedAt: now }).where(eq(tasks.id, task.id));
    // Credit goes to the adopter only when the merged PR was theirs (not an owner's own PR on a lapsed hold).
    if (adoption && adoption.userId === submission.authorId) {
      // The milestone's other tasks stay the adopter's, with the lock renewed.
      await renewLock(tx, task.id, now);
      await tx.update(adoptions).set({ status: "completed", endedAt: now }).where(eq(adoptions.id, adoption.id));
    }

    let milestoneDone = false;
    let projectDone = false;
    let nextTaskId: number | null = null;
    if (task.milestoneId !== null) {
      await syncMilestoneStatus(tx, task.milestoneId, now);
      const views = await loadTaskViews(tx, eq(tasks.milestoneId, task.milestoneId), now);
      nextTaskId = nextTaskInMilestone(views)?.id ?? null;
      const [m] = await tx.select().from(milestones).where(eq(milestones.id, task.milestoneId));
      milestoneDone = m?.status === "done";
      if (milestoneDone && task.projectId !== null) {
        const all = await tx.select({ status: milestones.status }).from(milestones).where(eq(milestones.projectId, task.projectId));
        const [project] = await tx.select().from(projects).where(eq(projects.id, task.projectId));
        if (project?.status === "open" && all.every((x) => x.status === "done")) {
          await finishProject(tx, task.projectId, "done", now);
          projectDone = true;
        }
      }
    }

    await writeAudit(tx, {
      actorId: submission.authorId,
      action: "task.merged",
      target: taskRef(task.id),
      details: { pr: pr.prNumber, mergedBy: pr.mergedBy, mergeCommitSha: pr.mergeCommitSha, milestoneDone, projectDone },
    });
    return { status: "merged" as const, taskId: task.id, nextTaskId, milestoneDone, projectDone };
  });
}

export type HelpedShip = { count: number; tasks: { id: number; title: string; repoFullName: string; mergedAt: Date | null }[] };

/** "Helped ship": the tasks someone took on that were merged, newest first. */
export async function helpedShip(db: Db, userId: number): Promise<HelpedShip> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, repoFullName: repos.fullName, mergedAt: adoptions.endedAt })
    .from(adoptions)
    .innerJoin(tasks, eq(adoptions.taskId, tasks.id))
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(and(eq(adoptions.userId, userId), eq(adoptions.status, "completed"), eq(tasks.status, "merged")))
    .orderBy(desc(adoptions.endedAt), desc(tasks.id));
  return { count: rows.length, tasks: rows };
}
