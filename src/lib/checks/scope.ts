import { matchesAny } from "../glob";
import type { ChangedFile } from "./files";
import { failed, listSome, passed, type CheckResult } from "./types";

const are = (paths: string[]) => (paths.length === 1 ? "is" : "are");

/**
 * Scope: every changed file is inside the brief's allowed paths, and none is
 * on the repo's off-limits list (off-limits wins even when an allowed path
 * matches). A renamed file's old path counts too.
 */
export function checkScope(files: ChangedFile[], allowedPaths: string[], offLimits: string[]): CheckResult {
  const forbidden: string[] = [];
  const outside: string[] = [];
  for (const f of files) {
    for (const path of [f.previousPath, f.path]) {
      if (!path) continue;
      if (matchesAny(path, offLimits)) {
        if (!forbidden.includes(path)) forbidden.push(path);
      } else if (!matchesAny(path, allowedPaths) && !outside.includes(path)) {
        outside.push(path);
      }
    }
  }
  const problems: string[] = [];
  if (forbidden.length) problems.push(`${listSome(forbidden)} ${are(forbidden)} off-limits`);
  if (outside.length) problems.push(`${listSome(outside)} ${are(outside)} outside the allowed paths`);
  if (problems.length) return failed("Scope", problems.join("; "));
  return passed("Scope", `${files.length} ${files.length === 1 ? "file" : "files"}, all inside the allowed paths`);
}
