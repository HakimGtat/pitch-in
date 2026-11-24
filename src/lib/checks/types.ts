// The seven automatic checks (plan.md, "Review-friendly PRs"). Plain code with
// fixed rules and no AI: the worker reads the PR body, the changed files and
// the CI results through the GitHub API, and the same PR always gets the same
// result. They prove the PR's shape, not whether the code is right.

export type CheckName = "Template" | "Size" | "Scope" | "Secrets" | "CI" | "Criteria" | "Evidence";

/** The order the check run lists them in, as in plan.md's example. */
export const CHECK_ORDER: CheckName[] = ["Template", "Size", "Scope", "Secrets", "CI", "Criteria", "Evidence"];

/** One line of the check run: `✓ Size       142 of 300 lines`. */
export type CheckResult = { name: CheckName; passed: boolean; detail: string };

/** The name of the one check run Pitch In posts per PR. The CI check ignores it. */
export const SITE_CHECK_NAME = "Pitch In checks";

export const passed = (name: CheckName, detail: string): CheckResult => ({ name, passed: true, detail });
export const failed = (name: CheckName, detail: string): CheckResult => ({ name, passed: false, detail });

/** "a, b and 3 more": keeps a detail line short when many things are wrong. */
export function listSome(items: string[], max = 3): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}
