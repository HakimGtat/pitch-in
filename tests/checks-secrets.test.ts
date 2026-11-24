import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addedText, checkSecrets, ScannerUnavailableError, type SecretScanner } from "@/lib/checks/secrets";
import { gitleaksArgs, parseGitleaksReport } from "@/lib/checks/gitleaks";

// A fake key, built at run time so this file never holds one whole.
const FAKE_KEY = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

const files = [
  { path: "src/config.ts", additions: 2, deletions: 0, patch: `@@ -1,1 +1,3 @@\n import x;\n+const a = 1;\n+const token = "${FAKE_KEY}";` },
  { path: "README.md", additions: 1, deletions: 1, patch: "@@ -4 +4 @@\n-old\n+new line" },
  { path: "logo.png", additions: 0, deletions: 0 },
];

/** Finds the fake key the way gitleaks would, by line number in the scanned text. */
const fakeScanner = (): SecretScanner & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    async scan(text) {
      seen.push(text);
      return text
        .split("\n")
        .flatMap((line, i) => (line.includes(FAKE_KEY) ? [{ rule: "github-pat", line: i + 1 }] : []));
    },
  };
};

describe("the text that gets scanned", () => {
  it("is only the added lines, mapped back to their file and line", () => {
    const { text, origin } = addedText(files);
    expect(text).toBe(`const a = 1;\nconst token = "${FAKE_KEY}";\nnew line`);
    expect(origin).toEqual([
      { file: "src/config.ts", line: 2 },
      { file: "src/config.ts", line: 3 },
      { file: "README.md", line: 4 },
    ]);
  });
});

describe("the Secrets check", () => {
  it("passes a diff with no findings", async () => {
    const clean = [files[1]];
    expect(await checkSecrets(clean, fakeScanner())).toEqual({ name: "Secrets", passed: true, detail: "nothing found" });
  });

  it("fails on a fake key, naming the file and the rule but never the secret", async () => {
    const scanner = fakeScanner();
    const r = await checkSecrets(files, scanner);
    expect(r).toEqual({ name: "Secrets", passed: false, detail: "possible secret in src/config.ts:3 (github-pat)" });
    expect(r.detail).not.toContain(FAKE_KEY);
    expect(scanner.seen).toHaveLength(1);
  });

  it("gives a failed check with a clear detail, not a crash, when gitleaks is missing", async () => {
    const missing: SecretScanner = {
      scan: async () => {
        throw new ScannerUnavailableError("gitleaks isn't installed in this image");
      },
    };
    expect(await checkSecrets(files, missing)).toEqual({
      name: "Secrets",
      passed: false,
      detail: "couldn't scan: gitleaks isn't installed in this image",
    });
  });

  it("doesn't call the scanner when nothing was added", async () => {
    const scanner = fakeScanner();
    expect(await checkSecrets([{ path: "a.ts", additions: 0, deletions: 3, patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c" }], scanner)).toEqual({
      name: "Secrets",
      passed: true,
      detail: "nothing found",
    });
    expect(scanner.seen).toHaveLength(0);
  });
});

describe("gitleaks itself", () => {
  it("runs on stdin, redacted, with a JSON report and no banner", () => {
    expect(gitleaksArgs("/tmp/r.json")).toEqual([
      "stdin",
      "--no-banner",
      "--redact",
      "--log-level",
      "error",
      "--exit-code",
      "0",
      "--report-format",
      "json",
      "--report-path",
      "/tmp/r.json",
    ]);
  });

  it("reads rule and line from the report, and never the secret", () => {
    const report = JSON.stringify([{ RuleID: "github-pat", StartLine: 2, Secret: "REDACTED", Match: "REDACTED" }]);
    expect(parseGitleaksReport(report)).toEqual([{ rule: "github-pat", line: 2 }]);
    expect(parseGitleaksReport("")).toEqual([]);
    expect(parseGitleaksReport("null")).toEqual([]);
  });
});

describe("the Dockerfile", () => {
  it("installs a pinned gitleaks release, checked against its published sha256", () => {
    const docker = readFileSync("Dockerfile", "utf8");
    expect(docker).toMatch(/GITLEAKS_VERSION=8\.\d+\.\d+/);
    expect(docker).toMatch(/sha256sum -c/);
    expect(docker).toContain("/usr/local/bin/gitleaks");
  });
});
