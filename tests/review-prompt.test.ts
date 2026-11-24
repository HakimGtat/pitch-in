import { describe, expect, it } from "vitest";
import { LONGEST_TESTED_LINK, startInClaudeUrl } from "@/lib/prompt";
import { buildReviewPrompt, reviewInClaude } from "@/lib/review-prompt";

const input = (over: Partial<Parameters<typeof buildReviewPrompt>[0]> = {}) => ({
  prUrl: "https://github.com/acme/uploader/pull/7",
  repoFullName: "acme/uploader",
  ref: "PI-12",
  title: "Reject empty uploads",
  headRef: "claude/empty-uploads",
  draft: false,
  acceptance: ["Empty files get a 400 error", "All existing tests pass"],
  packet: "# Review packet: PI-12\n\n### 1. Empty files get a 400 error\nPointer: `src/upload.py:15`",
  ...over,
});

describe("the Review in Claude prompt", () => {
  const p = buildReviewPrompt(input());

  it("holds the PR link, the criteria and the packet", () => {
    expect(p).toContain("https://github.com/acme/uploader/pull/7");
    expect(p).toContain("- Empty files get a 400 error\n- All existing tests pass");
    expect(p).toContain("# Review packet: PI-12");
  });

  it("keeps the review cheap: packet first, only the PR's files, no browsing, no re-running", () => {
    expect(p).toContain("Start from the review packet below");
    expect(p).toContain("Open only the PR's own files, and only where a pointer needs more context");
    expect(p).toContain("Don't browse the rest of the repo");
    expect(p).toContain("Don't re-run the tests, and don't re-check what the checks already proved: size, scope, secrets, the template and CI");
  });

  it("asks for one of three outcomes", () => {
    expect(p).toContain("- Accept:");
    expect(p).toContain("- Fix, then accept:");
    expect(p).toContain("- Reopen:");
    expect(p).toContain("one short reason");
  });

  it("has the owner's agent fix small problems itself, on the PR's branch or as a PR into it", () => {
    expect(p).toContain("fix them yourself in this session");
    expect(p).toContain("on the PR's branch (claude/empty-uploads) if this session can push to it, otherwise as a small PR into that branch");
  });

  it("never asks the contributor for anything, and talks about taking on work", () => {
    expect(p).toContain("Don't ask the contributor to do anything");
    const lower = p.toLowerCase();
    for (const word of ["donate", "share usage", "token", "transfer"]) expect(lower).not.toContain(word);
  });

  it("reminds the owner about a draft", () => {
    expect(p).not.toContain("draft");
    expect(buildReviewPrompt(input({ draft: true }))).toContain("The PR is a draft: mark it Ready for review on GitHub before you merge it.");
  });
});

describe("the Review in Claude link", () => {
  it("is built the same way as the Start in Claude link", () => {
    const r = reviewInClaude(input());
    expect(r.long).toBe(false);
    expect(r.url).toBe(startInClaudeUrl(r.prompt, "acme/uploader"));
    expect(new URL(r.url).searchParams.get("repositories")).toBe("acme/uploader");
  });

  it("falls back to copy and download when the packet is too long for a link", () => {
    const r = reviewInClaude(input({ packet: "x ".repeat(LONGEST_TESTED_LINK) }));
    expect(r.long).toBe(true);
    expect(r.url.length).toBeGreaterThan(LONGEST_TESTED_LINK);
  });
});
