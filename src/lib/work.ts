import { and, eq, inArray, max, notInArray } from "drizzle-orm";
import { getUser, PermissionError } from "./admin";
import { endAdoptions, syncMilestoneStatus } from "./adoption";
import { writeAudit } from "./audit";
import {
  checkBrief,
  checkMilestoneInput,
  checkProjectInput,
  type BriefCheck,
  type BriefDraft,
  type FormFlag,
  type MilestoneInput,
  type ProjectInput,
  type RepoTree,
} from "./brief";
import type { Db } from "./db/client";
import { adoptions, milestones, projects, repos, tasks, type Repo, type User } from "./db/schema";
import type { RepoGitHub } from "./github/repos";
import { canCloseOrRelease, canManageOwnWork, canPostTask, type Decision } from "./permissions";
import { checkImport, parseImport, type ImportPreview } from "./plan-import";
import { taskRef } from "./prompt";
import { loadTaskView, loadTaskViews } from "./views";

// Posting and managing work: single tasks, projects, milestones. Posting and
// changing work need write access to the repo, checked fresh on GitHub every
// time. Closing and releasing are for the owner or an admin.

function enforce(decision: Decision): void {
  if (!decision.ok) throw new PermissionError(decision.reason);
}

async function freshAccess(gh: RepoGitHub, repo: Repo, actor: User) {
  return { permission: await gh.permission(repo.fullName, actor.handle) };
}

async function connectedRepo(db: Db, repoId: number): Promise<Repo> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
  if (!repo || repo.removedAt) throw new PermissionError("That repo isn't connected to Pitch In.");
  return repo;
}

async function openProject(db: Db, projectId: number) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new PermissionError("That project doesn't exist.");
  if (project.status !== "open") throw new PermissionError("This project is closed or done.");
  return project;
}

/** Every file on the default branch, or null when GitHub can't be read just now. */
async function readTree(gh: RepoGitHub, repo: Repo): Promise<RepoTree | null> {
  try {
    return await gh.tree(repo.fullName, repo.defaultBranch);
  } catch (err) {
    console.error(`[brief] Couldn't read ${repo.fullName} from GitHub:`, err);
    return null;
  }
}

/** Runs the brief checker against the repo as it is on GitHub now. */
async function checkAgainstRepo(gh: RepoGitHub, repo: Repo, draft: BriefDraft): Promise<BriefCheck> {
  return checkBrief(draft, { repoFullName: repo.fullName, settings: repo.settings, tree: await readTree(gh, repo) });
}

export type BriefResult =
  | { ok: true; taskId: number }
  | { ok: false; check: BriefCheck; needsAck: boolean };

/** Errors block; warnings need a "Post anyway" before the task is saved. */
const verdict = (check: BriefCheck, acknowledged: boolean): BriefResult | null => {
  if (check.errors.length) return { ok: false, check, needsAck: false };
  if (check.warnings.length && !acknowledged) return { ok: false, check, needsAck: true };
  return null;
};

export type PostTarget = { repoId: number } | { milestoneId: number };

export async function postTask(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  target: PostTarget,
  draft: BriefDraft,
  acknowledged: boolean,
  now: Date = new Date(),
): Promise<BriefResult> {
  const actor = await getUser(db, actorId);
  let repo: Repo;
  let milestone: { id: number; projectId: number } | null = null;

  if ("milestoneId" in target) {
    const [m] = await db.select().from(milestones).where(eq(milestones.id, target.milestoneId));
    if (!m) throw new PermissionError("That milestone doesn't exist.");
    const project = await openProject(db, m.projectId);
    repo = await connectedRepo(db, project.repoId);
    enforce(canManageOwnWork(actor, project, await freshAccess(gh, repo, actor)));
    milestone = { id: m.id, projectId: project.id };
  } else {
    repo = await connectedRepo(db, target.repoId);
    enforce(canPostTask(actor, await freshAccess(gh, repo, actor)));
  }

  const check = await checkAgainstRepo(gh, repo, draft);
  const stop = verdict(check, acknowledged);
  if (stop) return stop;

  return db.transaction(async (tx) => {
    let position: number | null = null;
    if (milestone) {
      const [last] = await tx
        .select({ value: max(tasks.position) })
        .from(tasks)
        .where(eq(tasks.milestoneId, milestone.id));
      position = (last?.value ?? 0) + 1;
    }
    const [row] = await tx
      .insert(tasks)
      .values({
        repoId: repo.id,
        projectId: milestone?.projectId ?? null,
        milestoneId: milestone?.id ?? null,
        position,
        ownerId: actor.id,
        title: draft.title.trim(),
        kind: draft.kind,
        brief: draft.brief,
        briefMd: check.markdown,
        sizeTier: draft.sizeTier!,
        allowedPaths: draft.allowedPaths,
        status: "open",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });
    await syncMilestoneStatus(tx, milestone?.id ?? null, now);
    await writeAudit(tx, {
      actorId: actor.id,
      action: "task.posted",
      target: taskRef(row.id),
      details: {
        repo: repo.fullName,
        estimate: draft.sizeTier,
        kind: draft.kind,
        projectId: milestone?.projectId ?? null,
        milestoneId: milestone?.id ?? null,
        warnings: check.warnings.length,
      },
    });
    return { ok: true as const, taskId: row.id };
  });
}

/** The owner can edit a task while it's open and nobody has taken it on. */
export async function editTask(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  taskId: number,
  draft: BriefDraft,
  acknowledged: boolean,
  now: Date = new Date(),
): Promise<BriefResult> {
  const actor = await getUser(db, actorId);
  const task = await loadTaskView(db, taskId, now);
  if (!task) throw new PermissionError("That task doesn't exist.");
  if (task.status !== "open" || task.holder) throw new PermissionError("Only open tasks that nobody has taken on can be edited.");
  const repo = await connectedRepo(db, task.repoId);
  enforce(canManageOwnWork(actor, task, await freshAccess(gh, repo, actor)));

  const check = await checkAgainstRepo(gh, repo, draft);
  const stop = verdict(check, acknowledged);
  if (stop) return stop;

  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        title: draft.title.trim(),
        kind: draft.kind,
        brief: draft.brief,
        briefMd: check.markdown,
        sizeTier: draft.sizeTier!,
        allowedPaths: draft.allowedPaths,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));
    await writeAudit(tx, { actorId: actor.id, action: "task.edited", target: taskRef(task.id) });
  });
  return { ok: true, taskId: task.id };
}

/** The owner withdraws a task (or an admin closes it). Anyone working on it is released. */
export async function closeTask(db: Db, actorId: number, taskId: number, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    const task = await loadTaskView(tx, taskId, now);
    if (!task) throw new PermissionError("That task doesn't exist.");
    enforce(canCloseOrRelease(actor, task));
    if (task.status === "merged" || task.status === "closed") throw new PermissionError("This task is already finished.");
    if (task.adoptionId) await endAdoptions(tx, [{ id: task.adoptionId, taskId: task.id }], "released", now);
    await tx.update(tasks).set({ status: "closed", closedAt: now, updatedAt: now }).where(eq(tasks.id, task.id));
    await syncMilestoneStatus(tx, task.milestoneId, now);
    await writeAudit(tx, {
      actorId: actor.id,
      action: "task.closed",
      target: taskRef(task.id),
      details: { releasedHolder: task.holder?.handle ?? null },
    });
  });
}

// ---------- projects ----------

export { checkMilestoneInput, checkProjectInput };
export type { FormFlag, MilestoneInput, ProjectInput };

export type ProjectResult = { ok: true; projectId: number } | { ok: false; flags: FormFlag[] };

export async function createProject(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  repoId: number,
  input: ProjectInput,
  now: Date = new Date(),
): Promise<ProjectResult> {
  const actor = await getUser(db, actorId);
  const repo = await connectedRepo(db, repoId);
  enforce(canPostTask(actor, await freshAccess(gh, repo, actor)));
  const flags = checkProjectInput(input, repo.fullName);
  if (flags.length) return { ok: false, flags };

  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        repoId: repo.id,
        ownerId: actor.id,
        title: input.title.trim(),
        goal: input.goal.trim(),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: projects.id });
    await tx.insert(milestones).values(
      input.milestones.map((m, i) => ({
        projectId: project.id,
        position: i + 1,
        title: m.title.trim(),
        goal: m.goal.trim(),
        createdAt: now,
        updatedAt: now,
      })),
    );
    await writeAudit(tx, {
      actorId: actor.id,
      action: "project.posted",
      target: `project ${project.id}`,
      details: { repo: repo.fullName, title: input.title.trim(), milestones: input.milestones.length },
    });
    return { ok: true as const, projectId: project.id };
  });
}

// ---------- plan import ----------

export type ImportOutcome =
  | { kind: "posted"; projectId: number; taskIds: number[] }
  | { kind: "unparsed"; errors: string[] }
  | { kind: "preview"; preview: ImportPreview };

/**
 * Checks a pasted plan and, when `post` is set and nothing blocks, posts the
 * project, its milestones and tasks in one go. The preview is never trusted:
 * every post parses and checks the JSON again, against the repo as it is now.
 */
export async function importPlan(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  repoId: number,
  text: string,
  opts: { post: boolean; acknowledged: boolean },
  now: Date = new Date(),
): Promise<ImportOutcome> {
  const actor = await getUser(db, actorId);
  const repo = await connectedRepo(db, repoId);
  enforce(canPostTask(actor, await freshAccess(gh, repo, actor)));

  const parsed = parseImport(text);
  if (!parsed.ok) return { kind: "unparsed", errors: parsed.errors };
  const preview = checkImport(parsed.plan, { repoFullName: repo.fullName, settings: repo.settings, tree: await readTree(gh, repo) });
  if (!opts.post || preview.errors > 0 || (preview.warnings > 0 && !opts.acknowledged)) return { kind: "preview", preview };

  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ repoId: repo.id, ownerId: actor.id, title: preview.project.title, goal: preview.project.goal, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });

    const taskIds: number[] = [];
    for (const [i, m] of preview.milestones.entries()) {
      const [milestone] = await tx
        .insert(milestones)
        .values({ projectId: project.id, position: i + 1, title: m.title, goal: m.goal, createdAt: now, updatedAt: now })
        .returning({ id: milestones.id });
      for (const [j, t] of m.tasks.entries()) {
        const [row] = await tx
          .insert(tasks)
          .values({
            repoId: repo.id,
            projectId: project.id,
            milestoneId: milestone.id,
            position: j + 1,
            ownerId: actor.id,
            title: t.draft.title,
            kind: t.draft.kind,
            brief: t.draft.brief,
            briefMd: t.markdown,
            sizeTier: t.draft.sizeTier!,
            allowedPaths: t.draft.allowedPaths,
            status: "open",
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: tasks.id });
        taskIds.push(row.id);
      }
    }

    await writeAudit(tx, {
      actorId: actor.id,
      action: "project.imported",
      target: `project ${project.id}`,
      details: {
        repo: repo.fullName,
        title: preview.project.title,
        milestones: preview.milestones.length,
        tasks: taskIds.map(taskRef),
        warnings: preview.warnings,
      },
    });
    return { kind: "posted" as const, projectId: project.id, taskIds };
  });
}

export async function addMilestone(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  projectId: number,
  input: MilestoneInput,
  now: Date = new Date(),
): Promise<{ ok: true; milestoneId: number } | { ok: false; flags: FormFlag[] }> {
  const actor = await getUser(db, actorId);
  const project = await openProject(db, projectId);
  const repo = await connectedRepo(db, project.repoId);
  enforce(canManageOwnWork(actor, project, await freshAccess(gh, repo, actor)));
  const flags = checkMilestoneInput(input, repo.fullName);
  if (flags.length) return { ok: false, flags };

  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ value: max(milestones.position) })
      .from(milestones)
      .where(eq(milestones.projectId, project.id));
    const [row] = await tx
      .insert(milestones)
      .values({
        projectId: project.id,
        position: (last?.value ?? 0) + 1,
        title: input.title.trim(),
        goal: input.goal.trim(),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: milestones.id });
    await writeAudit(tx, {
      actorId: actor.id,
      action: "milestone.added",
      target: `project ${project.id}`,
      details: { title: input.title.trim() },
    });
    return { ok: true as const, milestoneId: row.id };
  });
}

/** The owner says the project is finished. Unfinished tasks close; nobody may be mid-run. */
export async function markProjectDone(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  projectId: number,
  now: Date = new Date(),
): Promise<void> {
  const actor = await getUser(db, actorId);
  const project = await openProject(db, projectId);
  const repo = await connectedRepo(db, project.repoId);
  enforce(canManageOwnWork(actor, project, await freshAccess(gh, repo, actor)));

  await db.transaction(async (tx) => {
    const views = await loadTaskViews(tx, eq(tasks.projectId, project.id), now);
    const busy = views.find((t) => t.holder || t.hasOpenPr);
    if (busy) {
      throw new PermissionError(
        `${taskRef(busy.id)} is still being worked on${busy.holder ? ` by @${busy.holder.handle}` : ""}. Release it or wait for it to finish first.`,
      );
    }
    await finishProject(tx, project.id, "done", now);
    await writeAudit(tx, { actorId: actor.id, action: "project.done", target: `project ${project.id}` });
  });
}

/** The owner withdraws a project, or an admin closes it. Everyone working on it is released. */
export async function closeProject(db: Db, actorId: number, projectId: number, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    const project = await openProject(tx, projectId);
    enforce(canCloseOrRelease(actor, project));
    await finishProject(tx, project.id, "closed", now);
    await writeAudit(tx, { actorId: actor.id, action: "project.closed", target: `project ${project.id}` });
  });
}

async function finishProject(db: Db, projectId: number, status: "done" | "closed", now: Date): Promise<void> {
  const open = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), notInArray(tasks.status, ["merged", "closed"])));
  const ids = open.map((t) => t.id);
  if (ids.length) {
    const active = await db
      .select({ id: adoptions.id, taskId: adoptions.taskId })
      .from(adoptions)
      .where(and(inArray(adoptions.taskId, ids), eq(adoptions.status, "active")));
    await endAdoptions(db, active, "released", now);
    await db.update(tasks).set({ status: "closed", closedAt: now, updatedAt: now }).where(inArray(tasks.id, ids));
  }
  await db.update(projects).set({ status, endedAt: now, updatedAt: now }).where(eq(projects.id, projectId));
}
