import { patchLines } from "./diff";
import type { ChangedFile } from "./files";
import { failed, listSome, passed, type CheckResult } from "./types";

// Secrets: a key, token or password pattern in the lines the PR adds. The
// scanning itself is gitleaks (lib/checks/gitleaks.ts) behind this small
// interface, so tests use a fake. Only diff text is scanned: the worker never
// runs contributor code.

/** A finding by line number in the scanned text (1-based). Never the secret itself. */
export type ScanFinding = { rule: string; line: number };

export interface SecretScanner {
  scan(text: string): Promise<ScanFinding[]>;
}

/** The scanner couldn't run at all, e.g. the gitleaks binary is missing. */
export class ScannerUnavailableError extends Error {}

/**
 * The PR's added lines as one text, with each line's file and line number. A
 * changed file GitHub sent no patch for (a very large diff) is scanned whole,
 * when the worker could fetch it as text.
 */
export function addedText(files: ChangedFile[]): { text: string; origin: { file: string; line: number }[] } {
  const lines: string[] = [];
  const origin: { file: string; line: number }[] = [];
  for (const f of files) {
    if (!f.patch) {
      if (f.content !== undefined) {
        f.content.split(/\r?\n/).forEach((text, i) => {
          lines.push(text);
          origin.push({ file: f.path, line: i + 1 });
        });
      }
      continue;
    }
    for (const l of patchLines(f.patch)) {
      if (l.kind !== "+") continue;
      lines.push(l.text);
      origin.push({ file: f.path, line: l.line });
    }
  }
  return { text: lines.join("\n"), origin };
}

/** Changed files there was no text for: binary, or too large to fetch. */
export const unscannedFiles = (files: ChangedFile[]) =>
  files.filter((f) => f.status !== "removed" && f.patch === undefined && f.content === undefined).map((f) => f.path);

export async function checkSecrets(files: ChangedFile[], scanner: SecretScanner): Promise<CheckResult> {
  const { text, origin } = addedText(files);
  const unscanned = unscannedFiles(files);
  const clean = unscanned.length ? `nothing found; not scanned (binary or too large): ${listSome(unscanned)}` : "nothing found";
  if (origin.length === 0) return passed("Secrets", clean);
  let findings: ScanFinding[];
  try {
    findings = await scanner.scan(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return failed("Secrets", `couldn't scan: ${why}`);
  }
  if (findings.length === 0) return passed("Secrets", clean);
  const places = findings.map((f) => {
    const at = origin[f.line - 1];
    return at ? `${at.file}:${at.line} (${f.rule})` : `the diff (${f.rule})`;
  });
  const unique = [...new Set(places)];
  return failed("Secrets", `possible secret${unique.length === 1 ? "" : "s"} in ${listSome(unique)}`);
}
