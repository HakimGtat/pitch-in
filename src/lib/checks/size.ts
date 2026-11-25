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

/**
 * Patterns marked `linguist-generated` in a .gitattributes file, as globs the
 * size cap understands. GitHub collapses these in diffs for the same reason.
 */
export function generatedFromGitattributes(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    const on = attrs.some((a) => a === "linguist-generated" || a === "linguist-generated=true");
    const off = attrs.some((a) => a === "-linguist-generated" || a === "linguist-generated=false");
    if (!on || off || !pattern) continue;
    // A pattern without a slash matches at any depth; a leading slash anchors it to the repo root.
    const glob = pattern.startsWith("/") ? pattern.slice(1) : pattern.includes("/") ? pattern : `**/${pattern}`;
    out.push(glob.endsWith("/") ? `${glob}**` : glob);
  }
  return out;
}
