import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScannerUnavailableError, type ScanFinding, type SecretScanner } from "./secrets";

// The real secret scanner: the gitleaks binary from the Docker image
// (Dockerfile pins the release). It reads diff text on stdin; nothing from the
// PR is ever run. Findings come back redacted, and only the rule and line are
// kept.

export function gitleaksArgs(reportPath: string): string[] {
  return [
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
    reportPath,
  ];
}

export function parseGitleaksReport(json: string): ScanFinding[] {
  if (!json.trim()) return [];
  const data = JSON.parse(json) as unknown;
  if (!Array.isArray(data)) return [];
  return data.map((f: { RuleID?: unknown; StartLine?: unknown }) => ({
    rule: typeof f.RuleID === "string" ? f.RuleID : "unknown-rule",
    line: typeof f.StartLine === "number" ? f.StartLine : 0,
  }));
}

const TIMEOUT_MS = 60_000;

export function gitleaksScanner(bin = process.env.GITLEAKS_BIN || "gitleaks"): SecretScanner {
  return {
    async scan(text) {
      const dir = await mkdtemp(join(tmpdir(), "pitchin-gitleaks-"));
      const report = join(dir, "report.json");
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(bin, gitleaksArgs(report), { stdio: ["pipe", "ignore", "pipe"] });
          let stderr = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new ScannerUnavailableError("gitleaks took too long"));
          }, TIMEOUT_MS);
          child.stderr.on("data", (d) => (stderr += String(d)));
          child.on("error", (err: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            reject(
              err.code === "ENOENT"
                ? new ScannerUnavailableError("gitleaks isn't installed in this image")
                : new ScannerUnavailableError(`gitleaks didn't start (${err.code ?? err.message})`),
            );
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new ScannerUnavailableError(`gitleaks exited with code ${code}: ${stderr.trim().slice(0, 200)}`));
          });
          child.stdin.on("error", () => {});
          child.stdin.end(text);
        });
        return parseGitleaksReport(await readFile(report, "utf8").catch(() => ""));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
