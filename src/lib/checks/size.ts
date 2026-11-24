import type { SizeTier } from "../db/schema";
import { matchesAny } from "../glob";
import { formatLines, LINE_CAP } from "../sizing";
import type { ChangedFile } from "./files";
import { failed, passed, type CheckResult } from "./types";

// plan.md, "Sizing": the cap counts lines added plus lines removed, tests
// included. It skips lockfiles and the generated files listed in repo settings.

export const LOCKFILES = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/uv.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/packages.lock.json",
  "**/Podfile.lock",
  "**/pubspec.lock",
  "**/mix.lock",
  "**/flake.lock",
];

export function countedLines(files: ChangedFile[], ignore: string[]): { counted: number; skipped: number } {
  const skip = [...LOCKFILES, ...ignore];
  let counted = 0;
  let skipped = 0;
  for (const f of files) {
    const lines = f.additions + f.deletions;
    if (matchesAny(f.path, skip)) skipped += lines;
    else counted += lines;
  }
  return { counted, skipped };
}

/** Size: lines changed against the task's cap. Passes at the cap, fails one line over. */
export function checkSize(files: ChangedFile[], tier: SizeTier, ignore: string[]): CheckResult {
  const cap = LINE_CAP[tier];
  const { counted, skipped } = countedLines(files, ignore);
  const detail =
    `${formatLines(counted)} of ${formatLines(cap)} lines` +
    (skipped ? ` (${formatLines(skipped)} in lockfiles and ignored files not counted)` : "");
  return counted <= cap ? passed("Size", detail) : failed("Size", detail);
}
