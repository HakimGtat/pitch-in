import { findCriterion, parsePrBody } from "./pr-body";
import { failed, listSome, passed, type CheckResult } from "./types";

const quote = (items: string[]) => listSome(items.map((c) => `"${c}"`));

/**
 * Criteria: every acceptance criterion from the brief appears word for word in
 * the PR's Acceptance criteria section and is ticked. Pure: reads only the PR
 * body and the brief's criteria.
 */
export function checkCriteria(body: string | null | undefined, acceptance: string[]): CheckResult {
  const parsed = parsePrBody(body);
  const missing: string[] = [];
  const unticked: string[] = [];
  for (const c of acceptance) {
    const line = findCriterion(parsed, c);
    if (!line) missing.push(c);
    else if (!line.ticked) unticked.push(c);
  }
  const ok = acceptance.length - missing.length - unticked.length;
  const head = `${ok} of ${acceptance.length} listed and ticked`;
  if (!missing.length && !unticked.length) return passed("Criteria", head);
  const parts = [head];
  if (missing.length) parts.push(`missing or reworded: ${quote(missing)}`);
  if (unticked.length) parts.push(`not ticked: ${quote(unticked)}`);
  return failed("Criteria", parts.join("; "));
}
