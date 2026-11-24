import type { ChangedLineMap } from "./diff";
import { findCriterion, formatPointer, parsePointer, parsePrBody } from "./pr-body";
import { failed, listSome, passed, type CheckResult } from "./types";

/**
 * Evidence: each criterion's pointer lands inside a changed part of the diff,
 * so the owner's agent checks lines instead of searching. `CI` is valid for any
 * criterion. A range passes when it overlaps any changed line. Pure: reads the
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
    if (pointer.kind === "ci") continue;
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
