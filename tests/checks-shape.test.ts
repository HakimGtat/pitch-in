import { describe, expect, it } from "vitest";
import { checkCi, fromCommitStatus } from "@/lib/checks/ci";
import { checkScope } from "@/lib/checks/scope";
import { checkSize, countedLines } from "@/lib/checks/size";
import { SITE_CHECK_NAME } from "@/lib/checks/types";
import type { ChangedFile } from "@/lib/checks/files";

const file = (path: string, additions: number, deletions = 0, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  additions,
  deletions,
  ...over,
});

describe("the Size check", () => {
  it("passes at the cap and fails one line over", () => {
    expect(checkSize([file("src/a.ts", 200), file("tests/a.test.ts", 50, 50)], "small", [])).toEqual({
      name: "Size",
      passed: true,
      detail: "300 of 300 lines",
    });
    expect(checkSize([file("src/a.ts", 201), file("tests/a.test.ts", 50, 50)], "small", [])).toEqual({
      name: "Size",
      passed: false,
      detail: "301 of 300 lines",
    });
  });

  it("counts lines added plus lines removed, tests included", () => {
    expect(countedLines([file("src/a.ts", 10, 5), file("tests/a.test.ts", 3, 2)], []).counted).toBe(20);
  });

  it("does not count lines in lockfiles", () => {
    const r = checkSize([file("src/a.ts", 100), file("package-lock.json", 5000, 3000), file("web/yarn.lock", 40)], "small", []);
    expect(r).toEqual({ name: "Size", passed: true, detail: "100 of 300 lines (8,040 in lockfiles and ignored files not counted)" });
  });

  it("does not count lines in the repo's ignore-listed files", () => {
    const files = [file("src/a.ts", 900), file("drizzle/meta/0002_snapshot.json", 2500), file("drizzle/0002_questions.sql", 20)];
    expect(checkSize(files, "medium", ["drizzle/meta/**"]).passed).toBe(true);
    expect(checkSize(files, "medium", []).passed).toBe(false);
  });

  it("uses the cap of the task's estimate", () => {
    expect(checkSize([file("a.md", 1500)], "large", []).detail).toBe("1,500 of 2,000 lines");
  });
});

describe("the Scope check", () => {
  const allowed = ["src/upload/**", "tests/**"];

  it("passes when every file is inside the allowed paths", () => {
    expect(checkScope([file("src/upload/a.ts", 1), file("tests/a.test.ts", 1)], allowed, [".github/**"])).toEqual({
      name: "Scope",
      passed: true,
      detail: "2 files, all inside the allowed paths",
    });
  });

  it("fails for a file outside allowedPaths and names it", () => {
    expect(checkScope([file("src/upload/a.ts", 1), file("README.md", 2)], allowed, [])).toEqual({
      name: "Scope",
      passed: false,
      detail: "README.md is outside the allowed paths",
    });
    expect(checkScope([file("README.md", 2), file("src/b.ts", 1)], allowed, []).detail).toBe(
      "README.md, src/b.ts are outside the allowed paths",
    );
  });

  it("fails for an off-limits path even when allowedPaths matches it", () => {
    expect(checkScope([file(".github/workflows/ci.yml", 1)], ["**"], [".github/**"])).toEqual({
      name: "Scope",
      passed: false,
      detail: ".github/workflows/ci.yml is off-limits",
    });
  });

  it("checks the old name of a renamed file too", () => {
    const moved = file("src/upload/a.ts", 0, 0, { previousPath: "src/core/a.ts" });
    expect(checkScope([moved], allowed, []).detail).toBe("src/core/a.ts is outside the allowed paths");
  });

  it("names both problems at once", () => {
    const r = checkScope([file("README.md", 1), file(".github/x.yml", 1)], allowed, [".github/**"]);
    expect(r.detail).toBe(".github/x.yml is off-limits; README.md is outside the allowed paths");
  });
});

describe("the CI check", () => {
  const run = (name: string, conclusion: string | null, status = "completed") => ({ name, status, conclusion });

  it("passes when all runs passed", () => {
    expect(checkCi([run("test", "success")])).toEqual({ name: "CI", passed: true, detail: "test: success" });
    expect(checkCi([run("lint", "success"), run("test", "success"), run("docs", "skipped")]).passed).toBe(true);
  });

  it("fails if any run failed, and names it", () => {
    expect(checkCi([run("lint", "success"), run("test", "failure")])).toEqual({
      name: "CI",
      passed: false,
      detail: "test: failure",
    });
    expect(checkCi([run("test", "timed_out"), run("e2e", "cancelled")]).detail).toBe("test: timed_out; e2e: cancelled");
  });

  it("counts a run that is still going as failing, with the detail 'still running'", () => {
    expect(checkCi([run("test", null, "in_progress")])).toEqual({ name: "CI", passed: false, detail: "test: still running" });
    expect(checkCi([run("test", null, "queued")]).detail).toBe("test: still running");
  });

  it("ignores the site's own check run", () => {
    expect(checkCi([run("test", "success"), run(SITE_CHECK_NAME, "failure")])).toEqual({
      name: "CI",
      passed: true,
      detail: "test: success",
    });
  });

  it("fails when there are no CI results yet", () => {
    expect(checkCi([run(SITE_CHECK_NAME, "success")])).toEqual({ name: "CI", passed: false, detail: "no CI results yet" });
  });

  it("reads commit statuses as well as check runs", () => {
    expect(fromCommitStatus({ context: "ci/jenkins", state: "pending" })).toEqual(run("ci/jenkins", null, "in_progress"));
    expect(fromCommitStatus({ context: "ci/jenkins", state: "error" })).toEqual(run("ci/jenkins", "failure"));
    expect(checkCi([fromCommitStatus({ context: "ci/jenkins", state: "success" })]).passed).toBe(true);
  });
});
