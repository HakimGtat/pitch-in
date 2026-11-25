import { and, asc, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  canAdoptMilestone,
  canAdoptTask,
  waitsItsTurn,
  type AdoptActor,
  type Holder,
  type TaskView,
} from "./adoption-rules";
import type { Db } from "./db/client";
import {
  adoptions,
  auditLog,
  milestones,
  projects,
  repos,
  submissions,
  tasks,
  users,
  type Milestone,
  type Project,
  type Repo,
  type Submission,
  type Task,
} from "./db/schema";
import { effectiveTaskStatus, isHeld, milestoneStatus, type MilestoneStatus, type TaskStatus } from "./lock";
import type { CheckResult } from "./checks/types";
import type { Decision } from "./permissions";

// Read-side views. The adoption lock is applied here, on read: an adoption
// whose 48 hours have run out (and has no open PR) no longer holds its task.

/** Submission states that mean the PR is still open on GitHub. */
export const OPEN_SUBMISSION = ["checking", "checks_failed", "in_review", "changes_requested"] as const;

export type FullTaskView = TaskView & {
  kind: Task["kind"];
  repoId: number;
  repoFullName: string;
  ownerHandle: string;
  projectId: number | null;
  storedStatus: TaskStatus;
  /** The active adoption row, held or lapsed. */
  adoptionId: number | null;
  task: Task;
};

export async function loadTaskViews(db: Db, where: SQL | undefined, now: Date): Promise<FullTaskView[]> {
  const rows = await db
    .select({ task: tasks, repoFullName: repos.fullName, ownerHandle: users.handle })
    .from(tasks)
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .innerJoin(users, eq(tasks.ownerId, users.id))
    .where(where)
    .orderBy(asc(tasks.position), asc(tasks.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.task.id);

  const active = await db
    .select({ adoption: adoptions, handle: users.handle })
    .from(adoptions)
    .innerJoin(users, eq(adoptions.userId, users.id))
    .where(and(inArray(adoptions.taskId, ids), eq(adoptions.status, "active")));
  const adoptionFor = new Map(active.map((a) => [a.adoption.taskId, a]));

  const open = await db
    .select({ taskId: submissions.taskId })
    .from(submissions)
    .where(and(inArray(submissions.taskId, ids), inArray(submissions.status, [...OPEN_SUBMISSION])));
  const withOpenPr = new Set(open.map((s) => s.taskId));

  return rows.map(({ task, repoFullName, ownerHandle }) => {
    const a = adoptionFor.get(task.id) ?? null;
    const hasOpenPr = withOpenPr.has(task.id);
    const held = a !== null && isHeld(a.adoption, now, hasOpenPr);
    const holder: Holder | null = held
      ? { userId: a.adoption.userId, handle: a.handle, milestoneId: a.adoption.milestoneId, expiresAt: a.adoption.expiresAt }
      : null;
    return {
      id: task.id,
      title: task.title,
      ownerId: task.ownerId,
      sizeTier: task.sizeTier,
      status: effectiveTaskStatus(task.status, a?.adoption ?? null, now, hasOpenPr),
      milestoneId: task.milestoneId,
      position: task.position,
      developersOnly: task.developersOnly,
      holder,
      hasOpenPr,
      kind: task.kind,
      repoId: task.repoId,
      repoFullName,
      ownerHandle,
      projectId: task.projectId,
      storedStatus: task.status,
      adoptionId: a?.adoption.id ?? null,
      task,
    };
  });
}

export async function loadTaskView(db: Db, taskId: number, now: Date): Promise<FullTaskView | null> {
  const [view] = await loadTaskViews(db, eq(tasks.id, taskId), now);
  return view ?? null;
}

export type MilestoneView = Milestone & {
  derivedStatus: MilestoneStatus;
  tasks: (FullTaskView & { adopt: Decision; waiting: boolean })[];
  adoptWhole: Decision;
};

export type ProjectView = Project & {
  repo: Repo;
  ownerHandle: string;
  milestones: MilestoneView[];
};

function milestoneViews(
  project: Project,
  ms: Milestone[],
  taskViews: FullTaskView[],
  viewer: AdoptActor,
): MilestoneView[] {
  const projectOpen = project.status === "open";
  return ms
    .sort((a, b) => a.position - b.position)
    .map((m) => {
      const mine = taskViews.filter((t) => t.milestoneId === m.id);
      const decision = canAdoptMilestone(viewer, { ownerId: project.ownerId, projectOpen, tasks: mine });
      return {
        ...m,
        derivedStatus: milestoneStatus(mine),
        tasks: mine.map((t) => ({
          ...t,
          adopt: canAdoptTask(viewer, t, { projectOpen, milestoneTasks: mine }),
          waiting: waitsItsTurn(t, mine),
        })),
        adoptWhole: decision.ok ? { ok: true as const } : decision,
      };
    });
}

export async function loadProjectView(db: Db, projectId: number, viewer: AdoptActor, now: Date): Promise<ProjectView | null> {
  const [row] = await db
    .select({ project: projects, repo: repos, ownerHandle: users.handle })
    .from(projects)
    .innerJoin(repos, eq(projects.repoId, repos.id))
    .innerJoin(users, eq(projects.ownerId, users.id))
    .where(eq(projects.id, projectId));
  if (!row) return null;
  const ms = await db.select().from(milestones).where(eq(milestones.projectId, projectId));
  const taskViews = await loadTaskViews(db, eq(tasks.projectId, projectId), now);
  return {
    ...row.project,
    repo: row.repo,
    ownerHandle: row.ownerHandle,
    milestones: milestoneViews(row.project, ms, taskViews, viewer),
  };
}

export type BoardTask = FullTaskView & { adopt: Decision };
export type Board = {
  projects: ProjectView[];
  singles: BoardTask[];
};

/** Everything open on the board: open projects on connected repos, and single tasks. */
export async function loadBoard(db: Db, viewer: AdoptActor, now: Date): Promise<Board> {
  const projectRows = await db
    .select({ project: projects, repo: repos, ownerHandle: users.handle })
    .from(projects)
    .innerJoin(repos, eq(projects.repoId, repos.id))
    .innerJoin(users, eq(projects.ownerId, users.id))
    .where(and(eq(projects.status, "open"), isNull(repos.removedAt)))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  const projectIds = projectRows.map((p) => p.project.id);

  const ms = projectIds.length
    ? await db.select().from(milestones).where(inArray(milestones.projectId, projectIds))
    : [];

  const taskViews = await loadTaskViews(
    db,
    and(
      isNull(repos.removedAt),
      or(
        projectIds.length ? inArray(tasks.projectId, projectIds) : undefined,
        and(isNull(tasks.projectId), notInArray(tasks.status, ["merged", "closed"])),
      ),
    ),
    now,
  );

  return {
    projects: projectRows.map((row) => ({
      ...row.project,
      repo: row.repo,
      ownerHandle: row.ownerHandle,
      milestones: milestoneViews(
        row.project,
        ms.filter((m) => m.projectId === row.project.id),
        taskViews.filter((t) => t.projectId === row.project.id),
        viewer,
      ),
    })),
    singles: taskViews
      .filter((t) => t.projectId === null)
      .sort((a, b) => b.id - a.id)
      .map((t) => ({ ...t, adopt: canAdoptTask(viewer, t, { projectOpen: true }) })),
  };
}

/** Tasks someone currently holds, newest first. */
export async function loadHeldBy(db: Db, userId: number, now: Date): Promise<FullTaskView[]> {
  const mine = await db
    .select({ taskId: adoptions.taskId })
    .from(adoptions)
    .where(and(eq(adoptions.userId, userId), eq(adoptions.status, "active")));
  if (mine.length === 0) return [];
  const views = await loadTaskViews(
    db,
    and(inArray(tasks.id, mine.map((m) => m.taskId)), ne(tasks.status, "closed")),
    now,
  );
  return views.filter((t) => t.holder?.userId === userId).sort((a, b) => b.id - a.id);
}

// ---------- the PR side of a task (plan.md, "Review-friendly PRs") ----------

/** The task's open PR on GitHub, newest first, or null. */
export async function openSubmissionFor(db: Db, taskId: number): Promise<Submission | null> {
  const [row] = await db
    .select()
    .from(submissions)
    .where(and(eq(submissions.taskId, taskId), inArray(submissions.status, [...OPEN_SUBMISSION])))
    .orderBy(desc(submissions.id))
    .limit(1);
  return row ?? null;
}

type StoredResults = { results?: CheckResult[]; ciPending?: boolean } | null;

const failingLines = (checks: StoredResults) =>
  (checks?.results ?? []).filter((r) => !r.passed).map((r) => `${r.name}: ${r.detail}`);

export type PrViewer = "owner" | "adopter" | "admin" | "other";
export type PrAction = "open_pr" | "review" | "reopen";

/**
 * What one viewer sees about a task's open PR. The contributor's part ended
 * when the PR opened, so the adopter gets no action, ever: failed checks and
 * fixes are the owner's. Nothing here has a deadline.
 */
export function prStatusFor(
  viewer: PrViewer,
  submission: { status: Submission["status"]; checkResults: unknown },
): { headline: string; failing: string[]; actions: PrAction[] } {
  const checks = submission.checkResults as StoredResults;
  const failing = failingLines(checks);
  const running = submission.status === "checking";
  const failed = submission.status === "checks_failed";
  const ready = submission.status === "in_review";

  if (viewer === "adopter") {
    return {
      headline: failed
        ? "Your part is done. Some checks failed, and the owner handles that from here; nothing is needed from you."
        : "Your part is done. The owner reviews the PR and handles anything that needs fixing; nothing is needed from you.",
      failing,
      actions: [],
    };
  }
  if (viewer === "other") {
    return { headline: ready ? "A PR for this task is in review." : "A PR for this task is open.", failing: [], actions: [] };
  }
  const headline = running
    ? checks?.ciPending
      ? "Checks are running: waiting for the repo's CI to finish."
      : "Checks are running."
    : failed
      ? "Some checks failed. You can fix what's free to fix on GitHub (a PR description edit, say) and the checks run again, or reopen the task with a short reason. Nothing expires while you decide."
      : failing.length
        ? "It passed every gate and is ready for your review. The PR description has format warnings (below); the review packet flags them."
        : "All seven checks passed. It's ready for your review.";
  const actions: PrAction[] = ["open_pr"];
  if (ready && viewer === "owner") actions.push("review");
  actions.push("reopen");
  return { headline, failing, actions };
}

export type OwnerQueueItem = {
  taskId: number;
  title: string;
  prNumber: number;
  repoFullName: string;
  status: Submission["status"];
  failing: string[];
};

/** The owner's tasks whose PRs need them: failed checks first, then ones ready for review. */
export async function loadOwnerQueue(db: Db, ownerId: number): Promise<OwnerQueueItem[]> {
  const rows = await db
    .select({ submission: submissions, task: tasks, repoFullName: repos.fullName })
    .from(submissions)
    .innerJoin(tasks, eq(submissions.taskId, tasks.id))
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(
      and(
        eq(tasks.ownerId, ownerId),
        inArray(submissions.status, ["checks_failed", "in_review"]),
        notInArray(tasks.status, ["merged", "closed"]),
        isNull(repos.removedAt),
      ),
    )
    .orderBy(asc(submissions.id));
  const rank = (s: Submission["status"]) => (s === "checks_failed" ? 0 : 1);
  return rows
    .map(({ submission, task, repoFullName }) => ({
      taskId: task.id,
      title: task.title,
      prNumber: submission.prNumber,
      repoFullName,
      status: submission.status,
      failing: failingLines(submission.checkResults as StoredResults),
    }))
    .sort((a, b) => rank(a.status) - rank(b.status));
}

export type UnlinkedPr = { taskId: number; title: string; prNumber: number; repoFullName: string; reason: string };

/**
 * PRs from the last two weeks that name one of the owner's open tasks but
 * didn't link, with the reason. The owner can paste one to link it.
 */
export async function loadUnlinkedForOwner(db: Db, ownerId: number, now: Date): Promise<UnlinkedPr[]> {
  const since = new Date(now.getTime() - 14 * 24 * 3600_000);
  const rows = await db
    .select({ target: auditLog.target, details: auditLog.details, task: tasks, repoFullName: repos.fullName })
    .from(auditLog)
    .innerJoin(tasks, eq(sql`(${auditLog.details}->>'taskId')::int`, tasks.id))
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(
      and(
        eq(auditLog.action, "pr.unlinked"),
        gte(auditLog.createdAt, since),
        eq(tasks.ownerId, ownerId),
        notInArray(tasks.status, ["merged", "closed"]),
        isNull(repos.removedAt),
      ),
    )
    .orderBy(desc(auditLog.id));
  const seen = new Set<string>();
  const out: UnlinkedPr[] = [];
  for (const r of rows) {
    const prNumber = Number(/#(\d+)$/.exec(r.target ?? "")?.[1]);
    if (!prNumber || seen.has(r.target!)) continue;
    seen.add(r.target!);
    const [linked] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(eq(submissions.taskId, r.task.id), eq(submissions.prNumber, prNumber), ne(submissions.status, "closed")));
    if (linked) continue;
    out.push({
      taskId: r.task.id,
      title: r.task.title,
      prNumber,
      repoFullName: r.repoFullName,
      reason: String((r.details as { reason?: string } | null)?.reason ?? ""),
    });
  }
  return out;
}
