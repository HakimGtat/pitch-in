import type { SizeTier } from "./db/schema";
import type { TaskStatus } from "./lock";
import type { Actor, Decision } from "./permissions";

// Who can take on what (plan.md, "Projects and milestones" and "Adoption and
// task lifecycle"). Pure functions over a read-time view of the tasks, so the
// lock's expiry is already applied to `status` and `holder`.

export type AdoptActor = Actor & { profile: "developer" | "guided" | null };

/** Whoever holds a task right now (an active adoption whose lock hasn't lapsed). */
export type Holder = {
  userId: number;
  handle: string;
  /** Set when the task was taken as part of a whole milestone. */
  milestoneId: number | null;
  expiresAt: Date;
};

export type TaskView = {
  id: number;
  title: string;
  ownerId: number;
  sizeTier: SizeTier;
  status: TaskStatus;
  milestoneId: number | null;
  position: number | null;
  developersOnly: boolean;
  holder: Holder | null;
  hasOpenPr: boolean;
};

const allow: Decision = { ok: true };
const deny = (reason: string): Decision => ({ ok: false, reason });

const FINISHED = new Set<TaskStatus>(["merged", "closed"]);
const IN_REVIEW = new Set<TaskStatus>(["in_review", "changes_requested"]);

/** The first task in the milestone that isn't merged or closed. */
export function nextTaskInMilestone<T extends { status: TaskStatus; position: number | null }>(tasks: T[]): T | null {
  return [...tasks].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).find((t) => !FINISHED.has(t.status)) ?? null;
}

// Rules run in this order so the reason shown is the most useful one: who
// holds the work comes before "this is your own work", so an owner sees it's taken.
/** A milestone task that isn't finished and isn't the milestone's next one: it waits its turn. */
export function waitsItsTurn<T extends { id: number; status: TaskStatus; position: number | null }>(
  task: T,
  milestoneTasks: T[] | undefined,
): boolean {
  if (!milestoneTasks || FINISHED.has(task.status)) return false;
  const next = nextTaskInMilestone(milestoneTasks);
  return Boolean(next && next.id !== task.id);
}

function basics(actor: AdoptActor, projectOpen: boolean): Decision | null {
  if (actor.blocked) return deny("Blocked people can't take on work.");
  if (!actor.profile) return deny("Answer the welcome question first.");
  if (!projectOpen) return deny("This project is closed or done.");
  return null;
}

const ownWork = (actor: AdoptActor, ownerId: number): Decision | null =>
  actor.id === ownerId ? deny("This is your own work. You review it, so someone else takes it on.") : null;

function holderReason(actor: AdoptActor, holder: Holder, hasOpenPr = false): Decision {
  if (holder.userId === actor.id) return deny("You've already taken this on.");
  // While their PR is open the task stays theirs: no lock runs out, and only the owner can reopen it.
  if (hasOpenPr) return deny(`@${holder.handle} has taken this on, and their PR is open.`);
  return deny(`@${holder.handle} has taken this on. It frees up if they hand it back or the lock runs out.`);
}

export function canAdoptTask(
  actor: AdoptActor,
  task: TaskView,
  ctx: { projectOpen: boolean; milestoneTasks?: TaskView[] },
): Decision {
  const basic = basics(actor, ctx.projectOpen);
  if (basic) return basic;
  if (task.status === "merged") return deny("This task is done.");
  if (task.status === "closed") return deny("The owner closed this task.");
  if (IN_REVIEW.has(task.status)) return deny("A PR for this task is in review.");
  if (task.holder) return holderReason(actor, task.holder, task.hasOpenPr);
  // Nobody holds it but a PR is open: the owner is doing it themself.
  if (task.hasOpenPr) return deny("The owner has a PR open for this task.");
  const own = ownWork(actor, task.ownerId);
  if (own) return own;

  if (task.milestoneId !== null && ctx.milestoneTasks) {
    const next = nextTaskInMilestone(ctx.milestoneTasks);
    if (next && next.id !== task.id) {
      return deny(`This milestone's tasks go in order. Task ${next.position} (${next.title}) comes first.`);
    }
  }

  if (task.developersOnly && actor.profile === "guided") {
    return deny("After an earlier guided try, the owner marked this task for developers.");
  }
  return allow;
}

export function canAdoptMilestone(
  actor: AdoptActor,
  milestone: { ownerId: number; projectOpen: boolean; tasks: TaskView[] },
): { ok: true; taskIds: number[] } | { ok: false; reason: string } {
  const basic = basics(actor, milestone.projectOpen);
  if (basic && !basic.ok) return basic;

  const live = [...milestone.tasks]
    .filter((t) => !FINISHED.has(t.status))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const held = live.find((t) => t.holder);
  if (held?.holder) {
    return held.holder.userId === actor.id
      ? { ok: false, reason: "You're already working on this milestone." }
      : { ok: false, reason: `@${held.holder.handle} is already working on this milestone.` };
  }
  if (live.some((t) => IN_REVIEW.has(t.status) || t.hasOpenPr)) {
    return { ok: false, reason: "Part of this milestone is in review. Take on its next task once that's merged." };
  }
  const own = ownWork(actor, milestone.ownerId);
  if (own && !own.ok) return own;
  const open = live.filter((t) => t.status === "open");
  if (open.length === 0) return { ok: false, reason: "Nothing is left to take on in this milestone." };
  if (actor.profile === "guided" && open.some((t) => t.developersOnly)) {
    return { ok: false, reason: "A task in this milestone is marked for developers, so it can't be taken as a whole." };
  }
  return { ok: true, taskIds: open.map((t) => t.id) };
}

export function canHandBack(actor: AdoptActor | Actor, held: { holderId: number; hasOpenPr: boolean }): Decision {
  if (actor.blocked) return deny("Blocked people can't change adoptions.");
  if (held.holderId !== actor.id) return deny("Only the person who took this on can hand it back.");
  if (held.hasOpenPr) {
    return deny("One of your PRs for this is still open. Wait for the owner's review or close the PR on GitHub, then hand back.");
  }
  return allow;
}
