// The adoption lock (plan.md, "Adoption and task lifecycle"). Adopting locks a
// task for 48 hours. Expiry is computed when the task is read: there is no
// expiry job. The lock also holds while one of the adopter's PRs is open.

export const LOCK_HOURS = 48;
const LOCK_MS = LOCK_HOURS * 3600_000;

export type TaskStatus = "open" | "adopted" | "in_review" | "changes_requested" | "merged" | "closed";
export type MilestoneStatus = "open" | "in_progress" | "done";
export type AdoptionLike = { status: "active" | "released" | "expired" | "completed"; expiresAt: Date };

export function lockExpiry(from: Date): Date {
  return new Date(from.getTime() + LOCK_MS);
}

/** Whether an adoption still holds its task at `now`. */
export function isHeld(adoption: AdoptionLike, now: Date, hasOpenPr = false): boolean {
  if (adoption.status !== "active") return false;
  return hasOpenPr || adoption.expiresAt.getTime() > now.getTime();
}

/** The status people see: an adopted task whose lock has lapsed reads as open. */
export function effectiveTaskStatus(
  stored: TaskStatus,
  adoption: AdoptionLike | null,
  now: Date,
  hasOpenPr = false,
): TaskStatus {
  if (stored === "adopted" && !(adoption && isHeld(adoption, now, hasOpenPr))) return "open";
  return stored;
}

const STARTED = new Set<TaskStatus>(["adopted", "in_review", "changes_requested", "merged"]);

/** open -> in_progress (any task adopted or merged) -> done (every task merged; closed ones don't count). */
export function milestoneStatus(tasks: { status: TaskStatus }[]): MilestoneStatus {
  const live = tasks.filter((t) => t.status !== "closed");
  if (live.length > 0 && live.every((t) => t.status === "merged")) return "done";
  return tasks.some((t) => STARTED.has(t.status)) ? "in_progress" : "open";
}

/** "41 hours", "35 minutes": how long until a lock lapses. */
export function timeLeft(expiresAt: Date, now: Date): string {
  const ms = Math.max(0, expiresAt.getTime() - now.getTime());
  // Nearest hour once there's more than 90 minutes left, so a fresh lock reads "48 hours".
  if (ms > 90 * 60_000) {
    const hours = Math.round(ms / 3600_000);
    return `${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
