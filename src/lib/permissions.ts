// Permission rules. Pure functions so they are easy to test.
// GitHub is the source of truth: org owners are admins, ai-team members with
// write access post and review. The site itself only adds the main admin and
// the block list, and never grants more than GitHub does.

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

/** What GitHub says about one person and one repo, fetched fresh for each check. */
export type RepoAccess = { inAiTeam: boolean; hasWriteAccess: boolean };

export function canPostTask(actor: Actor, access: RepoAccess): Decision {
  if (actor.blocked) return deny("Blocked people can't post tasks.");
  if (!access.inAiTeam)
    return deny("Posting tasks needs membership in the ai-team GitHub team.");
  if (!access.hasWriteAccess)
    return deny("Posting tasks needs write access to this repo on GitHub.");
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
  if (!access.inAiTeam || !access.hasWriteAccess)
    return deny(
      "Reviewing needs ai-team membership and write access to this repo on GitHub.",
    );
  return allow;
}
