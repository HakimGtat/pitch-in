import { describe, expect, it } from "vitest";
import { buildExcerpts } from "@/lib/checks/excerpts";
import type { StoredChecks } from "@/lib/checks/run";
import type { CheckResult } from "@/lib/checks/types";
import { buildReviewPacket, outputPath, packetReady } from "@/lib/review-packet";

// Lines 1-30 of src/upload.py are shown as context, with 14-16 added.
const PATCH = [
  "@@ -1,27 +1,30 @@",
  ...Array.from({ length: 13 }, (_, i) => ` line ${i + 1}`),
  "+    if f.size == 0:",
  "+        raise BadRequest()",
  "+    # done",
  ...Array.from({ length: 14 }, (_, i) => ` line ${i + 17}`),
].join("\n");

const CRITERIA = ["Empty files get a 400 error", "All existing tests pass"];
const BODY = [
  "Task: PI-12",
  "",
  "## Summary",
  "- Empty uploads are rejected with a 400",
  "",
  "## Acceptance criteria",
  "- [x] Empty files get a 400 error -> src/upload.py:15",
  "- [x] All existing tests pass -> CI",
  "",
  "## Where to look",
  "- src/upload.py:14-16: the new check",
  "",
  "## How it was tested",
  "`pytest` -> 12 passed",
  "",
  "## Not done or assumed",
  "- Files of exactly 0 bytes only; whitespace-only files still upload",
  "",
  "## Agent",
  "Claude Code, Claude Sonnet 5.5",
].join("\n");

const results: CheckResult[] = [
  { name: "Template", passed: true, detail: "all sections filled" },
  { name: "Size", passed: true, detail: "3 of 300 lines" },
  { name: "Scope", passed: true, detail: "1 file, all inside the allowed paths" },
  { name: "Secrets", passed: true, detail: "nothing found" },
  { name: "CI", passed: true, detail: "test: success" },
  { name: "Criteria", passed: true, detail: "2 of 2 listed and ticked" },
  { name: "Evidence", passed: true, detail: "2 of 2 pointers found in the diff" },
];

const checks = (over: Partial<StoredChecks> = {}): StoredChecks => ({
  headSha: "abc123",
  ranAt: "2026-11-24T12:00:00Z",
  results,
  passed: 7,
  failed: 0,
  ciPending: false,
  ciPendingSince: null,
  pr: { title: "Reject empty uploads", url: "https://github.com/acme/uploader/pull/7", draft: false, body: BODY, headRef: "claude/empty", author: "alice" },
  excerpts: buildExcerpts(BODY, CRITERIA, [{ path: "src/upload.py", additions: 3, deletions: 0, patch: PATCH }]),
  ...over,
});

const input = (over: Partial<Parameters<typeof buildReviewPacket>[0]> = {}) => ({
  ref: "PI-12",
  title: "Reject empty uploads",
  kind: "code" as const,
  output: "",
  repoFullName: "acme/uploader",
  prNumber: 7,
  checks: checks(),
  ...over,
});

describe("the review packet", () => {
  it("lists every criterion with its pointer and the changed lines around it", () => {
    const p = buildReviewPacket(input());
    expect(p).toContain("### 1. Empty files get a 400 error");
    expect(p).toContain("Pointer: `src/upload.py:15`");
    expect(p).toContain("+  14 |     if f.size == 0:");
    expect(p).toContain("   10 | line 10");
    expect(p).toContain("### 2. All existing tests pass");
    expect(p).toContain("Pointer: `CI` (the CI check passed)");
  });

  it("includes only lines near pointers, not whole files", () => {
    const p = buildReviewPacket(input());
    expect(p).not.toContain("| line 9\n");
    expect(p).not.toContain("| line 21");
    expect(p).toContain("| line 20");
  });

  it("includes the summary, where to look, the check results and Not done or assumed", () => {
    const p = buildReviewPacket(input());
    expect(p).toContain("PR #7: Reject empty uploads (https://github.com/acme/uploader/pull/7)");
    expect(p).toContain("## Summary\n- Empty uploads are rejected with a 400");
    expect(p).toContain("## Where to look\n- src/upload.py:14-16: the new check");
    expect(p).toContain("## Not done or assumed\n- Files of exactly 0 bytes only; whitespace-only files still upload");
    expect(p).toContain("Pitch In checks: 7 passed, 0 failed");
    expect(p).toContain("✓ Evidence   2 of 2 pointers found in the diff");
  });

  it("leaves out what GitHub already shows", () => {
    const p = buildReviewPacket(input());
    expect(p).not.toMatch(/files changed/i);
    expect(p).not.toContain("How it was tested");
  });

  it("tells the owner to mark a draft Ready for review on GitHub first", () => {
    expect(buildReviewPacket(input())).not.toContain("draft");
    const p = buildReviewPacket(input({ checks: checks({ pr: { ...checks().pr, draft: true } }) }));
    expect(p).toContain("This PR is a draft: mark it Ready for review on GitHub first, because GitHub won't merge a draft.");
  });

  it("links a non-code task's output file on GitHub at the PR's commit", () => {
    expect(outputPath("research/pricing.md with a comparison table and sources")).toBe("research/pricing.md");
    expect(outputPath("A short note")).toBeNull();
    const p = buildReviewPacket(input({ kind: "other", output: "research/pricing.md with a comparison table" }));
    expect(p).toContain("Read the output as GitHub renders it: https://github.com/acme/uploader/blob/abc123/research/pricing.md");
  });

  it("says when a criterion has no pointer", () => {
    const p = buildReviewPacket(input({ checks: checks({ excerpts: [{ criterion: "Empty files get a 400 error", pointer: null, lines: [] }] }) }));
    expect(p).toContain("Pointer: none");
  });

  it("is only ready once all seven checks passed and CI finished", () => {
    expect(packetReady(checks())).toBe(true);
    expect(packetReady(checks({ failed: 1, passed: 6 }))).toBe(false);
    expect(packetReady(checks({ ciPending: true }))).toBe(false);
    expect(packetReady(null)).toBe(false);
  });
});
