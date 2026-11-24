import { parsePrBody } from "./checks/pr-body";
import { resultLine, type StoredChecks } from "./checks/run";
import type { TaskKind } from "./db/schema";

// The review packet (plan.md, "Review with the owner's agent"): what the
// owner's agent reads instead of the repo. Built for free from what the checks
// already stored: the PR's Summary, each criterion with its pointer and the
// changed lines around it, Where to look, Not done or assumed and the check
// results. Nothing GitHub already shows (the file list, line counts) goes in.

/** Shown only for a PR that passed all seven checks, with CI finished. */
export function packetReady(checks: StoredChecks | null | undefined): checks is StoredChecks {
  return Boolean(checks && !checks.ciPending && checks.failed === 0 && checks.results.length === 7);
}

/** The file a non-code task produces, from its Output field ("research/pricing.md with a table"). */
export function outputPath(output: string): string | null {
  const m = /(?:^|\s)`?((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)`?(?=\s|$|[,;:])/.exec(output.trim());
  return m ? m[1] : null;
}

export type PacketInput = {
  ref: string;
  title: string;
  kind: TaskKind;
  output: string;
  repoFullName: string;
  prNumber: number;
  checks: StoredChecks;
};

const numbered = (lines: StoredChecks["excerpts"][number]["lines"]) =>
  lines.map((l) => `${l.kind}${String(l.line).padStart(4)} | ${l.text}`).join("\n");

export function buildReviewPacket(input: PacketInput): string {
  const { checks } = input;
  const body = parsePrBody(checks.pr.body);
  const parts: string[] = [
    `# Review packet: ${input.ref}, ${input.title}`,
    `PR #${input.prNumber}: ${checks.pr.title} (${checks.pr.url})`,
  ];
  if (checks.pr.draft) {
    parts.push("This PR is a draft: mark it Ready for review on GitHub first, because GitHub won't merge a draft.");
  }
  if (input.kind === "other") {
    const path = outputPath(input.output);
    parts.push(
      path
        ? `Read the output as GitHub renders it: https://github.com/${input.repoFullName}/blob/${checks.headSha}/${path}`
        : `The output (${input.output}) is in the PR's files.`,
    );
  }
  parts.push(`## Summary\n${body.sections.Summary || "(none given)"}`);

  const criteria = checks.excerpts.map((e, i) => {
    const head = `### ${i + 1}. ${e.criterion}`;
    if (!e.pointer) return `${head}\nPointer: none`;
    if (e.pointer === "CI") return `${head}\nPointer: \`CI\` (the CI check passed)`;
    const lines = e.lines.length ? `\n\`\`\`diff\n${numbered(e.lines)}\n\`\`\`` : "\n(no diff lines near this pointer)";
    return `${head}\nPointer: \`${e.pointer}\`${lines}`;
  });
  parts.push(`## Acceptance criteria and evidence\n\n${criteria.join("\n\n")}`);
  parts.push(`## Where to look\n${body.sections["Where to look"] || "(none given)"}`);
  parts.push(`## Not done or assumed\n${body.sections["Not done or assumed"] || "(none given)"}`);
  parts.push(
    `## Checks\nPitch In checks: ${checks.passed} passed, ${checks.failed} failed\n\`\`\`\n${checks.results.map(resultLine).join("\n")}\n\`\`\``,
  );
  return parts.join("\n\n") + "\n";
}
