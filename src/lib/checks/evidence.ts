import type { ChangedLineMap } from "./diff";
import { findCriterion, formatPointer, parsePointer, parsePrBody } from "./pr-body";
import { failed, listSome, passed, type CheckResult } from "./types";

/** A criterion like "All existing tests pass" or "CI is green": the only kind `CI` can point to. */
export const aboutTestsPassing = (criterion: string) =>
  /\b(tests?|ci|checks?|builds?|\w*lint|suite)\b/i.test(criterion) && /\b(pass|passes|passing|green|succeeds?)\b/i.test(criterion);

/**
 * Evidence: each criterion's pointer lands inside a changed part of the diff,
 * so the owner's agent checks lines instead of searching. `CI` is valid only
 * for a criterion about tests or CI passing. A range passes when it overlaps any changed line. Pure: reads the
 * PR body and the changed lines per file.
 */
export function checkEvidence(body: string | null | undefined, acceptance: string[], changed: ChangedLineMap): CheckResult {
  const parsed = parsePrBody(body);
  const problems: string[] = [];
  for (const c of acceptance) {
    const pointer = parsePointer(findCriterion(parsed, c)?.pointer);
    const name = `"${c}"`;
    if (!pointer) {
      problems.push(`${name} has no pointer`);
      continue;
    }
    if (pointer.kind === "ci") {
      if (!aboutTestsPassing(c)) problems.push(`${name} points to CI, but CI only proves tests pass; point to the lines instead`);
      continue;
    }
    const lines = changed.get(pointer.path);
    if (!lines) {
      problems.push(`${name} points to ${pointer.path}, which this PR doesn't change`);
      continue;
    }
    if (lines === "any") continue;
    let hit = false;
    for (let n = pointer.start; n <= pointer.end && !hit; n++) hit = lines.has(n);
    if (!hit) problems.push(`${name} points to ${formatPointer(pointer)}, an unchanged line`);
  }
  const head = `${acceptance.length - problems.length} of ${acceptance.length} pointers found in the diff`;
  return problems.length ? failed("Evidence", `${head}; ${listSome(problems)}`) : passed("Evidence", head);
}
