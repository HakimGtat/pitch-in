import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  GUIDED_STEPS,
  parseTaskRef,
  prTemplate,
  startInClaudeUrl,
  taskRef,
  type PromptInput,
} from "@/lib/prompt";

const input = (over: Partial<PromptInput> = {}): PromptInput => ({
  task: {
    id: 12,
    kind: "code",
    sizeTier: "medium",
    briefMd: "# Task: Reject empty uploads\n\n**Goal:** Empty files are rejected.\n",
    acceptance: ["Empty files are rejected with a 400 error", "All existing tests pass"],
    testCommand: "pytest tests/test_upload.py",
  },
  repo: { fullName: "acme/uploader", hasProjectBrief: true, offLimitsPaths: [".github/**", "infra/**"] },
  project: null,
  milestone: null,
  ...over,
});

describe("task references", () => {
  it("are PI-<number> and parse back", () => {
    expect(taskRef(12)).toBe("PI-12");
    expect(parseTaskRef("pi-12")).toBe(12);
    expect(parseTaskRef(" PI-7 ")).toBe(7);
    expect(parseTaskRef("PI-x")).toBeNull();
  });
});

describe("the PR template", () => {
  it("starts with Task: <id> and has the six sections, with the brief's criteria to tick", () => {
    const t = prTemplate("PI-12", ["Empty files are rejected with a 400 error"]);
    expect(t.split("\n")[0]).toBe("Task: PI-12");
    for (const s of ["Summary", "Files changed", "Acceptance criteria", "How it was tested", "Risks or notes", "Agent"]) {
      expect(t).toContain(`## ${s}`);
    }
    expect(t).toContain("- [ ] Empty files are rejected with a 400 error");
  });
});

describe("buildPrompt", () => {
  it("has the brief, PROJECT_BRIEF.md, off-limits paths, the cap and the template", () => {
    const p = buildPrompt(input());
    expect(p).toContain("acme/uploader");
    expect(p).toContain("Read PROJECT_BRIEF.md first");
    expect(p).toContain("# Task: Reject empty uploads");
    expect(p).toContain("Off-limits paths (never change these): .github/**, infra/**");
    expect(p).toContain("under 1,000 lines changed");
    expect(p).toContain("starting with the line `Task: PI-12`");
    expect(p).toContain("## Agent");
  });

  it("talks about picking up part of a coworker's project, never sharing usage", () => {
    const p = buildPrompt(input()).toLowerCase();
    expect(p).toContain("part of a coworker's project");
    for (const word of ["donate", "share usage", "token", "transfer"]) expect(p).not.toContain(word);
  });

  it("adds the project and milestone goals and what earlier tasks did", () => {
    const p = buildPrompt(
      input({
        project: { title: "Uploader v2", goal: "Make uploads safe and fast." },
        milestone: {
          position: 1,
          title: "Validation",
          goal: "Bad files never reach storage.",
          earlier: [
            { position: 1, title: "Add a size check", status: "merged" },
            { position: 2, title: "Old idea", status: "closed" },
          ],
        },
      }),
    );
    expect(p).toContain("Project: Uploader v2. Make uploads safe and fast.");
    expect(p).toContain("Milestone 1: Validation. Bad files never reach storage.");
    expect(p).toContain("Task 1, Add a size check (merged)");
    expect(p).not.toContain("Old idea");
  });

  it("says when the repo has no PROJECT_BRIEF.md yet", () => {
    const p = buildPrompt(input({ repo: { fullName: "acme/uploader", hasProjectBrief: false, offLimitsPaths: [] } }));
    expect(p).toContain("has no PROJECT_BRIEF.md yet");
    expect(p).toContain("Off-limits paths (never change these): none");
  });

  it("tells non-code tasks where the output goes, and handles no test command", () => {
    const p = buildPrompt(
      input({ task: { ...input().task, kind: "other", sizeTier: "small", testCommand: "none" } }),
    );
    expect(p).toContain("Deliver the work as files in this repo");
    expect(p).toContain("There's no test command for this task");
  });
});

describe("startInClaudeUrl", () => {
  it("opens Claude Code on the web with the prompt and repo filled in", () => {
    const url = new URL(startInClaudeUrl("Hello (world) & more", "acme/uploader"));
    expect(url.origin + url.pathname).toBe("https://claude.ai/code");
    expect(url.searchParams.get("prompt")).toBe("Hello (world) & more");
    expect(url.searchParams.get("repositories")).toBe("acme/uploader");
  });
});

describe("the guided walkthrough", () => {
  it("has no Create PR step, ends with the owner, and never mentions merging", () => {
    const text = GUIDED_STEPS.join(" ").toLowerCase();
    expect(text).toContain("check for my pr");
    expect(text).not.toContain("create pr");
    expect(text).not.toMatch(/merg/);
    expect(GUIDED_STEPS.at(-1)).toMatch(/the owner takes it from here/);
  });
});
