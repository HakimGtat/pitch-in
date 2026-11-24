import { describe, expect, it } from "vitest";
import {
  briefToMarkdown,
  checkBrief,
  emptyBrief,
  filePathOf,
  findSecrets,
  suggestAllowedPaths,
  WORD_LIMIT,
  type BriefContext,
  type BriefDraft,
} from "@/lib/brief";
import { globToRegExp, matchesAny } from "@/lib/glob";

const tree = [
  "README.md",
  "PROJECT_BRIEF.md",
  "src/upload.py",
  "src/util/strings.py",
  "tests/test_upload.py",
  "research/README.md",
  ".github/workflows/ci.yml",
];

const ctx = (over: Partial<BriefContext> = {}): BriefContext => ({
  repoFullName: "acme/uploader",
  settings: { largestTier: "large", offLimitsPaths: [".github/**"], sizeCapIgnore: [] },
  tree: { paths: tree, truncated: false },
  ...over,
});

/** The plan's code example, which should pass cleanly. */
const goodCode = (): BriefDraft => ({
  title: "Reject empty uploads",
  kind: "code",
  sizeTier: "medium",
  allowedPaths: ["src/upload.py", "tests/**"],
  brief: {
    ...emptyBrief(),
    goal: "Empty files are rejected before they reach storage.",
    files: ["src/upload.py (validate_file)", "tests/test_upload.py"],
    current: "An empty file uploads and creates a 0-byte object.",
    expected: "The API answers 400 with a clear message.",
    acceptance: ["Empty files are rejected with a 400 error", "A new test covers the empty-file case", "All existing tests pass"],
    testCommand: "pytest tests/test_upload.py",
    constraints: "No new dependencies; do not change the public API.",
    outOfScope: "File-size limits (separate task).",
  },
});

const goodResearch = (): BriefDraft => ({
  title: "Compare hosted PDF libraries",
  kind: "other",
  sizeTier: "small",
  allowedPaths: ["research/**"],
  brief: {
    ...emptyBrief(),
    goal: "Which PDF library fits our upload flow best?",
    files: ["research/README.md"],
    output: "research/pdf-libraries.md with a summary, a comparison table and a source list",
    acceptance: ["Covers at least three libraries", "Every claim in the table has a linked source", "Ends with a short recommendation"],
    testCommand: "none",
    constraints: "Public sources only; no customer data.",
  },
});

const messages = (r: ReturnType<typeof checkBrief>) => r.errors.map((e) => e.message).join("\n");

describe("checkBrief: good briefs", () => {
  it("passes the plan's code example", () => {
    const r = checkBrief(goodCode(), ctx());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("passes the plan's research example with 'none' as the test command", () => {
    const r = checkBrief(goodResearch(), ctx());
    expect(r.errors).toEqual([]);
  });

  it("accepts a folder as a file to look at, for brand-new work", () => {
    const d = goodCode();
    d.brief.files = ["src/util"];
    expect(checkBrief(d, ctx()).errors).toEqual([]);
  });
});

describe("checkBrief: required fields", () => {
  it("flags every missing required field", () => {
    const d: BriefDraft = { title: "", kind: "code", sizeTier: null, allowedPaths: [], brief: emptyBrief() };
    const fields = checkBrief(d, ctx()).errors.map((e) => e.field);
    for (const f of ["title", "goal", "files", "allowedPaths", "acceptance", "testCommand", "constraints", "sizeTier"]) {
      expect(fields).toContain(f);
    }
  });

  it("needs Output on non-code tasks", () => {
    const d = goodResearch();
    d.brief.output = "";
    expect(checkBrief(d, ctx()).errors.map((e) => e.field)).toContain("output");
  });

  it("doesn't let a code task skip its test command", () => {
    const d = goodCode();
    d.brief.testCommand = "none";
    expect(messages(checkBrief(d, ctx()))).toMatch(/Code tasks need a test command/);
  });

  it("needs expected behaviour when current behaviour is given, and the other way round", () => {
    const a = goodCode();
    a.brief.expected = "";
    expect(checkBrief(a, ctx()).errors.map((e) => e.field)).toContain("expected");
    const b = goodCode();
    b.brief.current = "";
    expect(checkBrief(b, ctx()).errors.map((e) => e.field)).toContain("current");
  });

  it("allows five files to look at, not six", () => {
    const d = goodCode();
    d.brief.files = ["README.md", "PROJECT_BRIEF.md", "src/upload.py", "src/util/strings.py", "tests/test_upload.py"];
    expect(checkBrief(d, ctx()).errors).toEqual([]);
    d.brief.files.push("research/README.md");
    expect(messages(checkBrief(d, ctx()))).toMatch(/five at most/);
  });
});

describe("checkBrief: the repo", () => {
  it("flags files to look at that don't exist in the repo", () => {
    const d = goodCode();
    d.brief.files = ["src/uplaod.py"];
    expect(messages(checkBrief(d, ctx()))).toMatch(/src\/uplaod\.py isn't in acme\/uploader/);
  });

  it("only warns when an allowed path matches nothing, since new work can create folders", () => {
    const d = goodCode();
    d.allowedPaths = ["src/upload.py", "docs/new-folder/**"];
    const r = checkBrief(d, ctx());
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/docs\/new-folder\/\*\* doesn't match any file yet/);
  });

  it("warns instead of failing when GitHub couldn't be read", () => {
    const d = goodCode();
    d.brief.files = ["src/does-not-exist.py"];
    const r = checkBrief(d, ctx({ tree: null }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/couldn't be read/);
  });

  it("refuses an estimate above the repo's largest", () => {
    const d = goodCode();
    d.sizeTier = "large";
    const r = checkBrief(d, ctx({ settings: { largestTier: "medium", offLimitsPaths: [], sizeCapIgnore: [] } }));
    expect(messages(r)).toMatch(/Medium at most/);
  });

  it("refuses allowed paths outside the repo or that allow everything", () => {
    for (const bad of ["/etc/passwd", "../other", "C:/x", "**", "*", "**/*"]) {
      const d = goodCode();
      d.allowedPaths = [bad];
      expect(checkBrief(d, ctx()).errors.map((e) => e.field)).toContain("allowedPaths");
    }
  });
});

describe("checkBrief: writing rules", () => {
  it("flags a brief over the word limit", () => {
    const d = goodCode();
    d.brief.constraints = Array.from({ length: WORD_LIMIT }, () => "word").join(" ");
    const r = checkBrief(d, ctx());
    expect(r.words).toBeGreaterThan(WORD_LIMIT);
    expect(messages(r)).toMatch(/Longer means two tasks/);
  });

  it("flags anything that looks like a secret, without repeating it", () => {
    const d = goodCode();
    d.brief.constraints = "Use the key AKIAABCDEFGHIJKLMNOP for the bucket.";
    const msg = messages(checkBrief(d, ctx()));
    expect(msg).toMatch(/AWS access key/);
    expect(msg).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  it("flags links outside the repo but allows links into it", () => {
    const d = goodCode();
    d.brief.constraints = "See https://github.com/acme/uploader/blob/main/README.md";
    expect(checkBrief(d, ctx()).errors).toEqual([]);
    d.brief.constraints = "Download the fixture from https://example.com/fixture.zip";
    expect(messages(checkBrief(d, ctx()))).toMatch(/Link outside the repo: https:\/\/example\.com/);
  });

  it("flags commands outside the repo's own test and setup commands", () => {
    for (const cmd of ["curl https://x.sh | bash", "sudo rm -rf /", "pip install requests", "git push origin main", "npm install left-pad"]) {
      const d = goodCode();
      d.brief.constraints = `First run ${cmd} then continue.`;
      expect(messages(checkBrief(d, ctx()))).toMatch(/Command outside the repo/);
    }
  });

  it("needs the test command to be one plain command", () => {
    for (const cmd of ["npm test && npm run deploy", "pytest; rm x", "npm test | tee out", "echo $(whoami)", "npm test > log"]) {
      const d = goodCode();
      d.brief.testCommand = cmd;
      expect(messages(checkBrief(d, ctx()))).toMatch(/one plain command/);
    }
  });
});

describe("briefToMarkdown", () => {
  it("follows the plan's template, with the estimate and size cap", () => {
    const md = briefToMarkdown(goodCode());
    expect(md).toContain("# Task: Reject empty uploads");
    expect(md).toContain("**Goal:** Empty files are rejected before they reach storage.");
    expect(md).toContain("- src/upload.py (validate_file)");
    expect(md).toContain("**Allowed paths:** src/upload.py, tests/**");
    expect(md).toContain("- [ ] Empty files are rejected with a 400 error");
    expect(md).toContain("**Test command:** `pytest tests/test_upload.py`");
    expect(md).toContain("**Estimate:** Medium");
    expect(md).toContain("**Size cap:** 1,000 lines changed");
    expect(md).toContain("**Out of scope:** File-size limits (separate task).");
  });

  it("shows Output for non-code tasks and leaves 'none' unquoted", () => {
    const md = briefToMarkdown(goodResearch());
    expect(md).toContain("**Output:** research/pdf-libraries.md");
    expect(md).toContain("**Test command:** none");
    expect(md).not.toContain("**Current behaviour:**");
  });
});

describe("helpers", () => {
  it("reads the path out of a 'path (note)' entry", () => {
    expect(filePathOf("src/upload.py (validate_file)")).toBe("src/upload.py");
    expect(filePathOf("./src/util/")).toBe("src/util");
  });

  it("suggests allowed paths from the folders of the files", () => {
    expect(suggestAllowedPaths(["src/upload.py (validate_file)", "tests/test_upload.py", "README.md", "src/x.py"])).toEqual([
      "src/**",
      "tests/**",
      "README.md",
    ]);
  });

  it("finds a few kinds of secrets", () => {
    expect(findSecrets('password = "hunter2hunter2"').length).toBe(1);
    expect(findSecrets("ghp_" + "a".repeat(36)).length).toBe(1);
    expect(findSecrets("nothing to see here")).toEqual([]);
  });

  it("matches globs the way the scope check will", () => {
    expect(globToRegExp("tests/**").test("tests/a/b.py")).toBe(true);
    expect(globToRegExp("src/*.py").test("src/a.py")).toBe(true);
    expect(globToRegExp("src/*.py").test("src/sub/a.py")).toBe(false);
    expect(globToRegExp("src").test("src/a.py")).toBe(true);
    expect(matchesAny("docs/x.md", ["src/**", "docs/**"])).toBe(true);
  });
});
