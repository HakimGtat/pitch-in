// Glob patterns for allowed paths and off-limits paths, e.g. `src/upload/**`.
// `**` crosses folders, `*` and `?` stay inside one. A plain name also matches
// everything under it, so `docs` means the docs folder.

export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/** Splits a textarea or comma-separated field into trimmed, non-empty entries. */
export function splitList(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(/[\r\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Splits a textarea into trimmed, non-empty lines, dropping "- " and "- [ ] " markers. */
export function splitLines(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((x) => x.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, "").trim())
    .filter(Boolean);
}
