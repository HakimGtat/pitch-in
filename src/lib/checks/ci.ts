import type { CiRun } from "./files";
import { failed, listSome, passed, SITE_CHECK_NAME, type CheckResult } from "./types";

const OK = new Set(["success", "neutral", "skipped"]);

/** A legacy commit status (some CI services still use them) read as a check run. */
export function fromCommitStatus(s: { context: string; state: string }): CiRun {
  if (s.state === "pending") return { name: s.context, status: "in_progress", conclusion: null };
  return { name: s.context, status: "completed", conclusion: s.state === "success" ? "success" : "failure" };
}

/**
 * CI: the repo's own checks on the PR's head commit. The site's own check run
 * is ignored. A run that hasn't finished counts as failing, "still running";
 * the worker checks again once it finishes.
 */
export function checkCi(runs: CiRun[]): CheckResult {
  const theirs = runs.filter((r) => r.name !== SITE_CHECK_NAME);
  if (theirs.length === 0) return failed("CI", "no CI results yet");
  const bad = theirs
    .filter((r) => r.status !== "completed" || !OK.has(r.conclusion ?? ""))
    .map((r) => `${r.name}: ${r.status !== "completed" ? "still running" : r.conclusion}`);
  if (bad.length) return failed("CI", bad.join("; "));
  return passed("CI", `${listSome(theirs.map((r) => r.name))}: success`);
}
