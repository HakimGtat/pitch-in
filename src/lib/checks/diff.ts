import type { ChangedFile } from "./files";

// Reading the unified-diff patch text GitHub returns for each changed file.

export type PatchLine = {
  /** The line's number in the new version of the file. */
  line: number;
  /** "+" for an added line, " " for unchanged context. Removed lines aren't in the new file, so they're left out. */
  kind: "+" | " ";
  text: string;
};

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Every line of the new file the patch shows, added or context, with its number. */
export function patchLines(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let next = 0;
  let inHunk = false;
  for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
    const h = HUNK.exec(raw);
    if (h) {
      next = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) out.push({ line: next++, kind: "+", text: raw.slice(1) });
    else if (raw.startsWith(" ")) out.push({ line: next++, kind: " ", text: raw.slice(1) });
    // "-" lines are gone from the new file; "\ No newline at end of file" is a marker.
  }
  return out;
}

/** New-side numbers of the lines the patch adds or changes. */
export function addedLines(patch: string): number[] {
  return patchLines(patch)
    .filter((l) => l.kind === "+")
    .map((l) => l.line);
}

/**
 * Changed lines per file. `"any"` marks a changed file GitHub shows no patch
 * for (binary or too large), where any line counts.
 */
export type ChangedLineMap = Map<string, Set<number> | "any">;

export function changedLineMap(files: ChangedFile[]): ChangedLineMap {
  const map: ChangedLineMap = new Map();
  for (const f of files) {
    if (f.status === "removed") continue;
    map.set(f.path, f.patch === undefined ? "any" : new Set(addedLines(f.patch)));
  }
  return map;
}
