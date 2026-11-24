import { patchLines, type PatchLine } from "./diff";
import type { ChangedFile } from "./files";
import { findCriterion, formatPointer, parsePointer, parsePrBody } from "./pr-body";

/** Lines either side of a pointer that the review packet shows. */
export const EXCERPT_CONTEXT = 5;

/** One criterion with its pointer and the diff lines around it. */
export type Excerpt = { criterion: string; pointer: string | null; lines: PatchLine[] };

/**
 * For each criterion: its pointer and the lines of the diff within five lines
 * of it. Only lines the patch shows are included, never whole files.
 */
export function buildExcerpts(body: string | null, acceptance: string[], files: ChangedFile[]): Excerpt[] {
  const parsed = parsePrBody(body);
  const patches = new Map(files.filter((f) => f.patch).map((f) => [f.path, patchLines(f.patch!)]));
  return acceptance.map((criterion) => {
    const pointer = parsePointer(findCriterion(parsed, criterion)?.pointer);
    if (!pointer) return { criterion, pointer: null, lines: [] };
    if (pointer.kind === "ci") return { criterion, pointer: "CI", lines: [] };
    const lines = (patches.get(pointer.path) ?? []).filter(
      (l) => l.line >= pointer.start - EXCERPT_CONTEXT && l.line <= pointer.end + EXCERPT_CONTEXT,
    );
    return { criterion, pointer: formatPointer(pointer), lines };
  });
}
