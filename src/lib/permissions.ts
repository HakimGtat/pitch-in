// Permission rules. Pure functions so they are easy to test.
// GitHub is the source of truth: org owners are admins, people with write
// access to a repo post and review work on it, repo admins connect it. The site
// itself only adds the main admin and the block list, and never grants more
// than GitHub does.

export type Actor = {
  id: number;
  isMainAdmin: boolean;
  isOrgOwner: boolean;
  blocked: boolean;
};

export type Decision = { ok: true } | { ok: false; reason: string };

const allow: Decision = { ok: true };
const deny = (reason: string): Decision => ({ ok: false, reason });

export function isAdmin(actor: Actor): boolean {
  return !actor.blocked && (actor.isMainAdmin || actor.isOrgOwner);
}

export function canViewAdmin(actor: Actor): Decision {
  return isAdmin(actor) ? allow : deny("Only admins can open the admin screen.");
}

export function canBlock(actor: Actor, target: Actor): Decision {
  if (!isAdmin(actor)) return deny("Only admins can block people.");
  if (actor.id === target.id) return deny("You can't block yourself.");
  if (target.isMainAdmin)
    return deny("The main admin can't be blocked. Hand over the role first.");
  if (target.isOrgOwner && !actor.isMainAdmin)
    return deny("Only the main admin can block an org owner.");
  if (target.blocked) return deny("They're already blocked.");
  return allow;
}

export function canUnblock(actor: Actor, target: Actor): Decision {
  if (!isAdmin(actor)) return deny("Only admins can unblock people.");
  if (!target.blocked) return deny("They aren't blocked.");
  if (target.isOrgOwner && !actor.isMainAdmin)
    return deny("Only the main admin can unblock an org owner.");
  return allow;
}

export function canHandOverMainAdmin(actor: Actor, target: Actor): Decision {
  if (actor.blocked || !actor.isMainAdmin)
    return deny("Only the main admin can hand over the role.");
  if (actor.id === target.id) return deny("You already hold the role.");
  if (target.blocked) return deny("Unblock them before handing over the role.");
  return allow;
}

export function canChangeProfile(actor: Actor, target: Actor): Decision {
  if (actor.blocked) return deny("Blocked people can't change profiles.");
  if (actor.id === target.id) return allow;
  if (isAdmin(actor)) return allow;
  return deny("Only admins can change someone else's profile.");
}

/** GitHub's permission for one person on one repo, fetched fresh for each check. */
export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";
export type RepoAccess = { permission: RepoPermission };

export const hasWriteAccess = (access: RepoAccess) =>
  access.permission === "admin" || access.permission === "maintain" || access.permission === "write";
export const isRepoAdmin = (access: RepoAccess) => access.permission === "admin";

export function canPostTask(actor: Actor, access: RepoAccess): Decision {
  if (actor.blocked) return deny("Blocked people can't post work.");
  if (!hasWriteAccess(access))
    return deny("Posting work needs write access to this repo on GitHub.");
  return allow;
}

export function canReviewTask(
  actor: Actor,
  task: { ownerId: number },
  access: RepoAccess,
): Decision {
  if (actor.blocked) return deny("Blocked people can't review.");
  if (actor.id !== task.ownerId)
    return deny("Only the task owner reviews its PRs.");
  if (!hasWriteAccess(access))
    return deny("Reviewing needs write access to this repo on GitHub.");
  return allow;
}

export function canConnectRepo(actor: Actor, access: RepoAccess): Decision {
  if (actor.blocked) return deny("Blocked people can't connect repos.");
  if (!isRepoAdmin(access))
    return deny("Connecting a repo needs admin permission on it in GitHub.");
  return allow;
}

export function canChangeRepoSettings(actor: Actor, access: RepoAccess): Decision {
  if (isAdmin(actor) || (!actor.blocked && isRepoAdmin(access))) return allow;
  return deny("Repo settings are for the repo's admins on GitHub and Pitch In admins.");
}

export function canRemoveRepo(actor: Actor): Decision {
  return isAdmin(actor) ? allow : deny("Only admins can remove a repo.");
}

/** Editing a task, adding milestones or tasks to a project, marking it done. */
export function canManageOwnWork(
  actor: Actor,
  work: { ownerId: number },
  access: RepoAccess,
): Decision {
  if (actor.blocked) return deny("Blocked people can't change work.");
  if (actor.id !== work.ownerId) return deny("Only the owner can change this.");
  if (!hasWriteAccess(access))
    return deny("Changing work needs write access to this repo on GitHub.");
  return allow;
}

/**
 * Reopening a task whose PR isn't worth fixing: the task owner or an admin,
 * with write access to the repo fresh from GitHub (the App closes the PR).
 */
export function canReopen(actor: Actor, task: { ownerId: number }, access: RepoAccess): Decision {
  if (actor.blocked) return deny("Blocked people can't reopen work.");
  if (actor.id !== task.ownerId && !isAdmin(actor)) return deny("Only the task owner or an admin can reopen a task.");
  if (!hasWriteAccess(access)) return deny("Reopening needs write access to this repo on GitHub.");
  return allow;
}

/** Closing a task or project, and releasing someone's adoption early. */
export function canCloseOrRelease(actor: Actor, work: { ownerId: number }): Decision {
  if (actor.blocked) return deny("Blocked people can't change work.");
  if (actor.id === work.ownerId || isAdmin(actor)) return allow;
  return deny("Only the owner or an admin can do this.");
}
