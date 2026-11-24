import type { RepoSettings, SizeTier, TaskBrief, TaskKind } from "./db/schema";
import { globToRegExp } from "./glob";
import { formatLines, LINE_CAP, TIER_LABEL, tierAllowed } from "./sizing";

// The brief checker (plan.md, "Brief guideline"). No AI: plain rules that flag
// missing fields, paths that aren't in the repo, briefs over the word limit,
// secrets, and commands or links outside the repo. Every flag blocks posting
// except allowed paths that match nothing yet, which only warn.

export const WORD_LIMIT = 500;
export const MAX_FILES = 5;

export type BriefDraft = {
  title: string;
  kind: TaskKind;
  sizeTier: SizeTier | null;
  allowedPaths: string[];
  brief: TaskBrief;
};

export type BriefField =
  | "title"
  | "goal"
  | "files"
  | "output"
  | "allowedPaths"
  | "current"
  | "expected"
  | "acceptance"
  | "testCommand"
  | "constraints"
  | "sizeTier"
  | "brief";

export type BriefFlag = { field: BriefField; message: string };

export type RepoTree = { paths: string[]; truncated: boolean };

export type BriefContext = {
  repoFullName: string;
  settings: RepoSettings;
  /** Every file on the default branch. Null when GitHub couldn't be read. */
  tree: RepoTree | null;
};

export type BriefCheck = {
  errors: BriefFlag[];
  warnings: BriefFlag[];
  words: number;
  markdown: string;
};

export const emptyBrief = (): TaskBrief => ({
  goal: "",
  files: [],
  output: "",
  current: "",
  expected: "",
  acceptance: [],
  testCommand: "",
  constraints: "",
  outOfScope: "",
  example: "",
});

/** "src/upload.py (validate_file)" -> "src/upload.py". */
export function filePathOf(entry: string): string {
  return entry
    .trim()
    .replace(/\s+\(.*\)\s*$/, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/** Allowed paths prefilled from the folders of the files to look at. */
export function suggestAllowedPaths(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const path = filePathOf(f);
    if (!path) continue;
    const slash = path.lastIndexOf("/");
    const suggestion = slash === -1 ? path : `${path.slice(0, slash).split("/")[0]}/**`;
    if (!out.includes(suggestion)) out.push(suggestion);
  }
  return out;
}

const isNone = (cmd: string) => cmd.trim().toLowerCase() === "none";

export function briefToMarkdown(d: BriefDraft): string {
  const b = d.brief;
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const parts: string[] = [`# Task: ${d.title}`, `**Goal:** ${b.goal}`, `**Files to look at:**\n${list(b.files)}`];
  if (b.output) parts.push(`**Output:** ${b.output}`);
  parts.push(`**Allowed paths:** ${d.allowedPaths.join(", ")}`);
  if (b.current || b.expected) {
    parts.push(
      [b.current && `**Current behaviour:** ${b.current}`, b.expected && `**Expected behaviour:** ${b.expected}`]
        .filter(Boolean)
        .join("\n"),
    );
  }
  parts.push(`**Acceptance criteria:**\n${b.acceptance.map((x) => `- [ ] ${x}`).join("\n")}`);
  parts.push(`**Test command:** ${isNone(b.testCommand) ? "none" : `\`${b.testCommand}\``}`);
  parts.push(
    [
      `**Constraints:** ${b.constraints}`,
      d.sizeTier && `**Estimate:** ${TIER_LABEL[d.sizeTier]}`,
      d.sizeTier && `**Size cap:** ${formatLines(LINE_CAP[d.sizeTier])} lines changed`,
      b.outOfScope && `**Out of scope:** ${b.outOfScope}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (b.example) parts.push(`**Example input and output:** ${b.example}`);
  return parts.join("\n\n") + "\n";
}

// ---------- secrets (the PR checks use gitleaks from Milestone 3) ----------

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "API key (sk-...)", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  {
    name: "key, secret or password assignment",
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)\b\s*[:=]\s*["']?[^"'\s]{8,}/i,
  },
  { name: "URL with a password in it", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/i },
];

const redact = (s: string) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…, ${s.length} characters`);

export function findSecrets(text: string): { name: string; sample: string }[] {
  const hits: { name: string; sample: string }[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ name, sample: redact(m[0]) });
  }
  return hits;
}

// ---------- text rules shared by briefs and project or milestone goals ----------

const OUTSIDE_COMMANDS = [
  /\b(?:curl|wget|ssh|scp|sudo|chmod|chown|nc|ncat)\s/i,
  /\brm\s+-[a-z]*r/i,
  /\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i,
  /\b(?:Invoke-WebRequest|Invoke-Expression|iex)\b/i,
  /\bnpm\s+(?:install|i|add)\s+[@\w]/i,
  /\bpip3?\s+install\b/i,
  /\bgit\s+(?:push|remote|config)\b/i,
];

/** Secrets, links outside the repo and commands outside it. Used for briefs and for goals. */
export function checkText(text: string, repoFullName: string): string[] {
  const problems: string[] = [];
  for (const h of findSecrets(text)) {
    problems.push(`Looks like a secret: ${h.name} (${h.sample}). Never put secrets in a brief; use .env.example instead.`);
  }
  const repo = repoFullName.toLowerCase();
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]`"']+/gi)) {
    let inside = false;
    try {
      const u = new URL(m[0]);
      inside = u.hostname.toLowerCase() === "github.com" && `${u.pathname.toLowerCase()}/`.startsWith(`/${repo}/`);
    } catch {
      // Not a URL after all: treat it as outside.
    }
    if (!inside) problems.push(`Link outside the repo: ${m[0]}. Briefs only link inside ${repoFullName}.`);
  }
  for (const re of OUTSIDE_COMMANDS) {
    const m = re.exec(text);
    if (m) {
      problems.push(`Command outside the repo's own test and setup commands: "${m[0].trim()}".`);
    }
  }
  return problems;
}

// ---------- the checker ----------

const CATCH_ALL = /^(?:\*\*|\*|\*\*\/\*|\.|\.\/)$/;
const CHAINING = /[;&|`<>]|\$\(/;

export function checkBrief(d: BriefDraft, ctx: BriefContext): BriefCheck {
  const errors: BriefFlag[] = [];
  const warnings: BriefFlag[] = [];
  const err = (field: BriefField, message: string) => errors.push({ field, message });
  const warn = (field: BriefField, message: string) => warnings.push({ field, message });
  const b = d.brief;

  if (!d.title.trim()) err("title", "Title is required.");
  else if (d.title.length > 100) err("title", "Keep the title under 100 characters.");
  if (!b.goal.trim()) err("goal", "Goal is required: one sentence on the outcome, not the method.");

  if (b.files.length === 0) {
    err("files", "Files to look at is required. List exact paths; for brand-new work, the closest files or the folder it goes in.");
  } else if (b.files.length > MAX_FILES) {
    err("files", `Files to look at lists ${b.files.length} paths; five at most.`);
  }

  if (d.kind === "other" && !b.output.trim()) {
    err("output", "Output is required for non-code tasks: the file to produce and its format, e.g. research/pricing.md with a comparison table.");
  }

  if (d.allowedPaths.length === 0) err("allowedPaths", "Allowed paths is required: glob patterns the PR may touch.");
  for (const p of d.allowedPaths) {
    if (/^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)/.test(p)) {
      err("allowedPaths", `"${p}" must be a path inside the repo (no leading / and no "..").`);
    } else if (CATCH_ALL.test(p.trim())) {
      err("allowedPaths", `"${p}" allows every file. Name the folders or files instead.`);
    }
  }

  if (b.current.trim() && !b.expected.trim()) err("expected", "Current behaviour is filled in, so Expected behaviour is needed too.");
  if (b.expected.trim() && !b.current.trim()) err("current", "Expected behaviour is filled in, so Current behaviour is needed too.");

  if (b.acceptance.length === 0) err("acceptance", "Acceptance criteria is required: at least one yes/no item the reviewer can tick.");

  const cmd = b.testCommand.trim();
  if (!cmd) {
    err("testCommand", 'Test command is required. For docs or research, use the repo\'s lint or link-check command, or "none".');
  } else if (isNone(cmd)) {
    if (d.kind === "code") err("testCommand", "Code tasks need a test command that proves the work is done.");
  } else if (CHAINING.test(cmd)) {
    err("testCommand", "The test command must be one plain command (no ; && | ` $( > <).");
  }

  if (!b.constraints.trim()) err("constraints", "Constraints is required, e.g. no new dependencies, keep the public API, cite every source.");

  if (!d.sizeTier) err("sizeTier", "Estimate is required: Small, Medium or Large.");
  else if (!tierAllowed(d.sizeTier, ctx.settings.largestTier)) {
    err("sizeTier", `This repo allows ${TIER_LABEL[ctx.settings.largestTier]} at most. Split bigger work into a project with milestones.`);
  }

  // Paths against the repo.
  if (ctx.tree) {
    const files = new Set(ctx.tree.paths);
    const isFolder = (p: string) => ctx.tree!.paths.some((f) => f.startsWith(`${p}/`));
    for (const entry of b.files) {
      const p = filePathOf(entry);
      if (!p || files.has(p) || isFolder(p)) continue;
      const message = `${p} isn't in ${ctx.repoFullName}. Check the spelling, or name the folder it goes in.`;
      if (ctx.tree.truncated) warn("files", message);
      else err("files", message);
    }
    for (const glob of d.allowedPaths) {
      if (CATCH_ALL.test(glob.trim())) continue;
      const re = globToRegExp(glob);
      if (!ctx.tree.paths.some((f) => re.test(f))) {
        warn("allowedPaths", `${glob} doesn't match any file yet. That's fine if the task creates it.`);
      }
    }
  } else {
    warn("files", "The repo couldn't be read from GitHub just now, so file paths weren't checked.");
  }

  const markdown = briefToMarkdown(d);
  const words = markdown.split(/\s+/).filter(Boolean).length;
  if (words > WORD_LIMIT) err("brief", `The brief is ${words} words; the limit is ${WORD_LIMIT}. Longer means two tasks.`);
  for (const problem of checkText(markdown, ctx.repoFullName)) err("brief", problem);

  return { errors, warnings, words, markdown };
}
