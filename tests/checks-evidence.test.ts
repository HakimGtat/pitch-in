import { describe, expect, it } from "vitest";
import { addedLines, changedLineMap, deletionEdges, patchLines } from "@/lib/checks/diff";
import { aboutTestsPassing, checkEvidence } from "@/lib/checks/evidence";
import { parsePointer } from "@/lib/checks/pr-body";

// New-side lines 6, 7, 8 and 10 are added; 5, 9 and 11 are unchanged context.
const PATCH = [
  "@@ -5,4 +5,7 @@ export function slugify(text) {",
  " function check() {",
  '+  if (typeof text !== "string") {',
  '+    throw new TypeError("not a string");',
  "+  }",
  "   return x;",
  "-  old();",
  "+  renamed();",
  " }",
].join("\n");

const TEST_PATCH = ["@@ -0,0 +1,3 @@", "+it('rejects null', () => {", "+  expect(() => slugify(null)).toThrow(TypeError);", "+});"].join("\n");

const changed = changedLineMap([
  { path: "src/slugify.js", additions: 4, deletions: 1, patch: PATCH },
  { path: "tests/slugify.test.js", additions: 3, deletions: 0, patch: TEST_PATCH },
  { path: "assets/logo.png", additions: 0, deletions: 0 },
]);

const CRITERIA = ["slugify(null) throws a TypeError", "A new test covers non-string input", "All existing tests pass"];
const body = (lines: string[]) => `Task: PI-12\n\n## Summary\n- x\n\n## Acceptance criteria\n${lines.join("\n")}\n\n## Agent\nClaude`;

describe("reading a patch", () => {
  it("finds the new-side numbers of added lines only", () => {
    expect(addedLines(PATCH)).toEqual([6, 7, 8, 10]);
    expect(addedLines(TEST_PATCH)).toEqual([1, 2, 3]);
  });

  it("skips the no-newline marker and handles several hunks", () => {
    const patch = ["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file", "@@ -10,2 +10,3 @@", " c", "+d", " e"].join("\n");
    expect(addedLines(patch)).toEqual([1, 11]);
  });

  it("keeps each line's text and kind for the review packet", () => {
    expect(patchLines(PATCH).slice(0, 2)).toEqual([
      { line: 5, kind: " ", text: "function check() {" },
      { line: 6, kind: "+", text: '  if (typeof text !== "string") {' },
    ]);
  });
});

describe("pointers", () => {
  it("read file:line, file:start-end and CI", () => {
    expect(parsePointer("src/slugify.js:8")).toEqual({ kind: "lines", path: "src/slugify.js", start: 8, end: 8 });
    expect(parsePointer("`src/slugify.js:6-8`")).toEqual({ kind: "lines", path: "src/slugify.js", start: 6, end: 8 });
    expect(parsePointer("./src/app/tasks/[id]/page.tsx:214-232 (the form)")).toEqual({
      kind: "lines",
      path: "src/app/tasks/[id]/page.tsx",
      start: 214,
      end: 232,
    });
    expect(parsePointer("CI")).toEqual({ kind: "ci" });
    expect(parsePointer("ci (all green)")).toEqual({ kind: "ci" });
  });

  it("read nothing from a file name without a line", () => {
    expect(parsePointer("tests/pr-link.test.ts, tests/webhook.test.ts (CI)")).toBeNull();
    expect(parsePointer(null)).toBeNull();
    expect(parsePointer("")).toBeNull();
  });
});

describe("the Evidence check", () => {
  it("passes pointers inside added or changed lines, and CI", () => {
    const r = checkEvidence(
      body([
        "- [x] slugify(null) throws a TypeError -> src/slugify.js:7",
        "- [x] A new test covers non-string input -> tests/slugify.test.js:1-3",
        "- [x] All existing tests pass -> CI",
      ]),
      CRITERIA,
      changed,
    );
    expect(r).toEqual({ name: "Evidence", passed: true, detail: "3 of 3 pointers found in the diff" });
  });

  it("fails a pointer to an unchanged line and names the criterion", () => {
    const r = checkEvidence(
      body([
        "- [x] slugify(null) throws a TypeError -> src/slugify.js:9",
        "- [x] A new test covers non-string input -> tests/slugify.test.js:2",
        "- [x] All existing tests pass -> CI",
      ]),
      CRITERIA,
      changed,
    );
    expect(r).toEqual({
      name: "Evidence",
      passed: false,
      detail: '2 of 3 pointers found in the diff; "slugify(null) throws a TypeError" points to src/slugify.js:9, an unchanged line',
    });
  });

  it("fails a pointer to a file not in the diff", () => {
    const r = checkEvidence(body(["- [x] slugify(null) throws a TypeError -> src/other.js:3"]), [CRITERIA[0]], changed);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('"slugify(null) throws a TypeError" points to src/other.js, which this PR doesn\'t change');
  });

  it("fails a criterion with no pointer, or one that isn't listed", () => {
    const r = checkEvidence(body(["- [x] slugify(null) throws a TypeError", "- [x] All existing tests pass -> CI"]), CRITERIA, changed);
    expect(r.passed).toBe(false);
    expect(r.detail).toBe(
      '1 of 3 pointers found in the diff; "slugify(null) throws a TypeError" has no pointer, "A new test covers non-string input" has no pointer',
    );
  });

  it("passes a range that overlaps a changed line, and fails one that doesn't", () => {
    expect(checkEvidence(body(["- [x] slugify(null) throws a TypeError -> src/slugify.js:3-6"]), [CRITERIA[0]], changed).passed).toBe(true);
    const r = checkEvidence(body(["- [x] slugify(null) throws a TypeError -> src/slugify.js:1-5"]), [CRITERIA[0]], changed);
    expect(r.detail).toContain("points to src/slugify.js:1-5, an unchanged line");
  });

  it("accepts any line of a changed file GitHub shows no patch for", () => {
    const r = checkEvidence(body(["- [x] slugify(null) throws a TypeError -> assets/logo.png:1"]), [CRITERIA[0]], changed);
    expect(r.passed).toBe(true);
  });
});

describe("pointers that start like CI", () => {
  it("are paths when they're paths", () => {
    expect(parsePointer("ci/deploy.sh:12")).toEqual({ kind: "lines", path: "ci/deploy.sh", start: 12, end: 12 });
    expect(parsePointer("CI.md:3")).toEqual({ kind: "lines", path: "CI.md", start: 3, end: 3 });
    expect(parsePointer("CI (green)")).toEqual({ kind: "ci" });
    expect(parsePointer("CI")).toEqual({ kind: "ci" });
  });
});

describe("pointers to deleted code", () => {
  // Lines 3-4 are deleted outright; new-side line 2 and 3 sit either side.
  const DELETE = ["@@ -1,6 +1,4 @@", " a", " b", "-old1", "-old2", " c", " d"].join("\n");

  it("count when they sit next to a pure deletion, not next to a change", () => {
    expect(deletionEdges(DELETE)).toEqual([2, 3]);
    expect(deletionEdges(PATCH)).toEqual([]);
  });

  it("pass the Evidence check, and so does any line of a removed file", () => {
    const map = changedLineMap([
      { path: "src/a.js", additions: 0, deletions: 2, patch: DELETE },
      { path: "scripts/old.ts", additions: 0, deletions: 40, status: "removed", patch: "@@ -1,40 +0,0 @@\n-x" },
    ]);
    const r = checkEvidence(
      body(["- [x] The old helper is gone -> src/a.js:2-3", "- [x] The script is removed -> scripts/old.ts:1"]),
      ["The old helper is gone", "The script is removed"],
      map,
    );
    expect(r.passed).toBe(true);
  });
});

describe("criteria typeset differently", () => {
  it("still match word for word", () => {
    const b = body([
      "- [x] `slugify(null)` throws a TypeError. -> src/slugify.js:7",
      "- [x] a new test covers non-string input -> tests/slugify.test.js:1",
      "- [x] All existing tests pass -> CI",
    ]);
    expect(checkEvidence(b, CRITERIA, changed).passed).toBe(true);
  });

  it("still fail when the words differ", () => {
    expect(checkEvidence(body(["- [x] slugify(null) throws an error -> src/slugify.js:7"]), [CRITERIA[0]], changed).passed).toBe(false);
  });
});

describe("CI as a pointer", () => {
  it("is only for a criterion about tests or CI passing", () => {
    const r = checkEvidence(body(["- [x] slugify(null) throws a TypeError -> CI", "- [x] All existing tests pass -> CI"]), [CRITERIA[0], CRITERIA[2]], changed);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('"slugify(null) throws a TypeError" points to CI, but CI only proves tests pass');
    expect(r.detail).toMatch(/^1 of 2 pointers/);
  });
  it("recognises the usual wordings", () => {
    for (const c of ["All existing tests pass", "All tests pass", "CI is green", "The build succeeds", "npm test passes", "Markdown lint passes", "markdownlint passes"]) {
      expect(aboutTestsPassing(c)).toBe(true);
    }
    expect(aboutTestsPassing("A new test covers non-string input")).toBe(false);
  });
});
