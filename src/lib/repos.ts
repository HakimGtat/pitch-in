import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { getUser, PermissionError } from "./admin";
import { endAdoptions } from "./adoption";
import { writeAudit } from "./audit";
import type { Db } from "./db/client";
import { adoptions, projects, repos, tasks, type Repo, type RepoSettings } from "./db/schema";
import { hasWorkflowFile, PROJECT_BRIEF_PATH, type GitHubRepo, type RepoGitHub } from "./github/repos";
import { canChangeRepoSettings, canConnectRepo, canRemoveRepo, hasWriteAccess, type Decision } from "./permissions";
import { parseTier } from "./sizing";

// Connecting repos (plan.md, "Core flow" step 2). A repo needs CI to connect.
// PROJECT_BRIEF.md is read at connect and refreshed on every push to the
// default branch; a repo without one connects with a warning, so writing it
// can be its first task.

function enforce(decision: Decision): void {
  if (!decision.ok) throw new PermissionError(decision.reason);
}

export type ConnectResult =
  | { ok: true; repoId: number; briefMissing: boolean }
  | { ok: false; reason: "no_ci"; fullName: string };

export async function listConnectedRepos(db: Db): Promise<Repo[]> {
  return db.select().from(repos).where(isNull(repos.removedAt)).orderBy(asc(repos.fullName));
}

export async function getConnectedRepo(db: Db, id: number): Promise<Repo | null> {
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.id, id), isNull(repos.removedAt)));
  return repo ?? null;
}

/** Connected repos where the person has at least write access, checked fresh on GitHub. */
export async function reposWithWriteAccess(db: Db, gh: RepoGitHub, login: string): Promise<Repo[]> {
  const connected = await listConnectedRepos(db);
  const access = await Promise.all(connected.map((r) => gh.permission(r.fullName, login)));
  return connected.filter((_, i) => hasWriteAccess({ permission: access[i] }));
}

/** What GitHub currently says about a repo's CI and PROJECT_BRIEF.md. */
async function readRepoState(gh: RepoGitHub, repo: GitHubRepo) {
  const [workflows, brief] = await Promise.all([
    gh.listWorkflows(repo.fullName, repo.defaultBranch),
    gh.readFile(repo.fullName, PROJECT_BRIEF_PATH, repo.defaultBranch),
  ]);
  return { hasCi: hasWorkflowFile(workflows), brief };
}

export async function connectRepo(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  githubRepoId: number,
  now: Date = new Date(),
): Promise<ConnectResult> {
  const actor = await getUser(db, actorId);
  const repo = await gh.getRepo(githubRepoId);
  if (!repo) throw new PermissionError("The Pitch In GitHub App can't see that repo. Check the App's repository access on GitHub.");
  if (repo.archived) throw new PermissionError(`${repo.fullName} is archived on GitHub, so it can't take new work.`);

  const [existing] = await db.select().from(repos).where(eq(repos.githubRepoId, repo.id));
  if (existing && !existing.removedAt) throw new PermissionError(`${repo.fullName} is already connected.`);

  enforce(canConnectRepo(actor, { permission: await gh.permission(repo.fullName, actor.handle) }));

  const state = await readRepoState(gh, repo);
  if (!state.hasCi) {
    await writeAudit(db, {
      actorId: actor.id,
      action: "repo.connect_refused",
      target: repo.fullName,
      details: { reason: "no_ci" },
    });
    return { ok: false, reason: "no_ci", fullName: repo.fullName };
  }

  const installationId = await gh.installationId();
  const fields = {
    installationId,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    hasCi: true,
    projectBrief: state.brief?.text ?? null,
    projectBriefSha: state.brief?.sha ?? null,
    projectBriefUpdatedAt: state.brief ? now : null,
    refreshedAt: now,
    connectedById: actor.id,
    removedAt: null,
    updatedAt: now,
  };

  return db.transaction(async (tx) => {
    let repoId: number;
    if (existing) {
      await tx.update(repos).set(fields).where(eq(repos.id, existing.id));
      repoId = existing.id;
    } else {
      const [row] = await tx
        .insert(repos)
        .values({ githubRepoId: repo.id, createdAt: now, ...fields })
        .returning({ id: repos.id });
      repoId = row.id;
    }
    await writeAudit(tx, {
      actorId: actor.id,
      action: "repo.connected",
      target: repo.fullName,
      details: { briefMissing: !state.brief, reconnected: Boolean(existing) },
    });
    return { ok: true as const, repoId, briefMissing: !state.brief };
  });
}

/** Re-reads PROJECT_BRIEF.md, CI, the name and the default branch from GitHub. */
export async function refreshRepo(db: Db, gh: RepoGitHub, repoId: number, now: Date = new Date()): Promise<Repo> {
  const [current] = await db.select().from(repos).where(eq(repos.id, repoId));
  if (!current) throw new PermissionError("That repo isn't connected.");
  const repo = await gh.getRepo(current.githubRepoId);
  if (!repo) throw new PermissionError(`The Pitch In GitHub App can't see ${current.fullName} any more.`);

  const state = await readRepoState(gh, repo);
  const briefChanged = (state.brief?.sha ?? null) !== current.projectBriefSha;
  const [updated] = await db
    .update(repos)
    .set({
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      hasCi: state.hasCi,
      projectBrief: state.brief?.text ?? null,
      projectBriefSha: state.brief?.sha ?? null,
      ...(briefChanged ? { projectBriefUpdatedAt: state.brief ? now : null } : {}),
      refreshedAt: now,
      updatedAt: now,
    })
    .where(eq(repos.id, repoId))
    .returning();

  if (current.hasCi && !state.hasCi) {
    await writeAudit(db, { actorId: null, action: "repo.ci_missing", target: repo.fullName });
  }
  return updated;
}

const badPath = (p: string) => /^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)/.test(p);

export function parseRepoSettings(input: {
  largestTier: unknown;
  offLimitsPaths: string[];
  sizeCapIgnore: string[];
}): { ok: true; settings: RepoSettings } | { ok: false; error: string } {
  const largestTier = parseTier(input.largestTier);
  if (!largestTier) return { ok: false, error: "Pick the largest estimate allowed." };
  const bad = [...input.offLimitsPaths, ...input.sizeCapIgnore].find(badPath);
  if (bad) return { ok: false, error: `"${bad}" must be a path inside the repo (no leading / and no "..").` };
  return {
    ok: true,
    settings: {
      largestTier,
      offLimitsPaths: [...new Set(input.offLimitsPaths)],
      sizeCapIgnore: [...new Set(input.sizeCapIgnore)],
    },
  };
}

export async function updateRepoSettings(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  repoId: number,
  settings: RepoSettings,
  now: Date = new Date(),
): Promise<void> {
  const actor = await getUser(db, actorId);
  const repo = await getConnectedRepo(db, repoId);
  if (!repo) throw new PermissionError("That repo isn't connected.");
  enforce(canChangeRepoSettings(actor, { permission: await gh.permission(repo.fullName, actor.handle) }));
  await db.transaction(async (tx) => {
    await tx.update(repos).set({ settings, updatedAt: now }).where(eq(repos.id, repo.id));
    await writeAudit(tx, {
      actorId: actor.id,
      action: "repo.settings_changed",
      target: repo.fullName,
      details: { from: repo.settings, to: settings },
    });
  });
}

/** Admins only. Its open projects and tasks close, and anyone working on them is released. */
export async function removeRepo(db: Db, actorId: number, repoId: number, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const actor = await getUser(tx, actorId);
    enforce(canRemoveRepo(actor));
    const [repo] = await tx.select().from(repos).where(and(eq(repos.id, repoId), isNull(repos.removedAt)));
    if (!repo) throw new PermissionError("That repo isn't connected.");

    const openTasks = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.repoId, repo.id), notInArray(tasks.status, ["merged", "closed"])));
    const taskIds = openTasks.map((t) => t.id);
    if (taskIds.length) {
      const active = await tx
        .select({ id: adoptions.id, taskId: adoptions.taskId })
        .from(adoptions)
        .where(and(inArray(adoptions.taskId, taskIds), eq(adoptions.status, "active")));
      await endAdoptions(tx, active, "released", now);
      await tx.update(tasks).set({ status: "closed", closedAt: now, updatedAt: now }).where(inArray(tasks.id, taskIds));
    }
    await tx
      .update(projects)
      .set({ status: "closed", endedAt: now, updatedAt: now })
      .where(and(eq(projects.repoId, repo.id), eq(projects.status, "open")));
    await tx.update(repos).set({ removedAt: now, updatedAt: now }).where(eq(repos.id, repo.id));
    await writeAudit(tx, {
      actorId: actor.id,
      action: "repo.removed",
      target: repo.fullName,
      details: { closedTasks: taskIds.length },
    });
  });
}

/** The connected repo for a GitHub repo id, if any. */
export async function reposForPush(db: Db, githubRepoId: number): Promise<Repo[]> {
  return db
    .select()
    .from(repos)
    .where(and(eq(repos.githubRepoId, githubRepoId), isNull(repos.removedAt)));
}
