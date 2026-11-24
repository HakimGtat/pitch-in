import type { SizeTier, TakeOn } from "./db/schema";

// Sizing has two sides (plan.md, "Sizing"): the owner estimates each task, and
// the contributor chooses how much they want to take on. The choice is only a
// filter for the board, never a permission.

export const TIERS: SizeTier[] = ["small", "medium", "large"];

export const TIER_LABEL: Record<SizeTier, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/** Lines added plus lines removed per PR. Placeholders until usage notes calibrate them. */
export const LINE_CAP: Record<SizeTier, number> = {
  small: 300,
  medium: 1000,
  large: 2000,
};

export const TIER_EFFORT: Record<SizeTier, string> = {
  small: "A quick run",
  medium: "A solid chunk of one session",
  large: "Most of a session or more",
};

export const TAKE_ON: TakeOn[] = ["quick", "session", "big"];

export const TAKE_ON_LABEL: Record<TakeOn, string> = {
  quick: "A quick run",
  session: "A session",
  big: "A big chunk",
};

export const TAKE_ON_SHOWS: Record<TakeOn, string> = {
  quick: "Small tasks",
  session: "Small and Medium tasks",
  big: "Everything, including whole milestones",
};

const LARGEST_FOR: Record<TakeOn, SizeTier> = {
  quick: "small",
  session: "medium",
  big: "large",
};

export const tierRank = (tier: SizeTier) => TIERS.indexOf(tier);

/** Whether an estimate is within a repo's "largest estimate allowed". */
export function tierAllowed(tier: SizeTier, largest: SizeTier): boolean {
  return tierRank(tier) <= tierRank(largest);
}

/** The "work that fits" rule: does a task of this estimate fit what the person wants to take on? */
export function fitsTakeOn(takeOn: TakeOn, tier: SizeTier): boolean {
  return tierRank(tier) <= tierRank(LARGEST_FOR[takeOn]);
}

/** Whole milestones are offered in the "big chunk" view. */
export function offersWholeMilestones(takeOn: TakeOn): boolean {
  return takeOn === "big";
}

export function parseTakeOn(value: unknown): TakeOn | null {
  return typeof value === "string" && (TAKE_ON as string[]).includes(value) ? (value as TakeOn) : null;
}

export function parseTier(value: unknown): SizeTier | null {
  return typeof value === "string" && (TIERS as string[]).includes(value) ? (value as SizeTier) : null;
}

export const formatLines = (n: number) => n.toLocaleString("en-US");
