import { hasContent, parsePrBody, parseTaskLine, SECTIONS } from "./pr-body";
import { failed, passed, type CheckResult } from "./types";

/**
 * Template: the first line is `Task: <task id>` and every section of the PR
 * template is there and filled in. Pure: reads only the PR body.
 */
export function checkTemplate(body: string | null | undefined, ref: string): CheckResult {
  const parsed = parsePrBody(body);
  const problems: string[] = [];

  const named = parseTaskLine(body);
  const want = Number(/\d+$/.exec(ref)?.[0]);
  if (named === null) problems.push(`the first line isn't \`Task: ${ref}\``);
  else if (named !== want) problems.push(`the first line names PI-${named}, not ${ref}`);

  const missing = SECTIONS.filter((s) => parsed.sections[s] === undefined);
  const empty = SECTIONS.filter((s) => parsed.sections[s] !== undefined && !hasContent(parsed.sections[s]));
  if (missing.length) problems.push(`missing: ${missing.join(", ")}`);
  if (empty.length) problems.push(`empty: ${empty.join(", ")}`);

  return problems.length ? failed("Template", problems.join("; ")) : passed("Template", "all sections filled");
}
