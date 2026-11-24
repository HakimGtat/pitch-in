import type { SizeTier, TaskKind } from "./db/schema";
import type { TaskStatus } from "./lock";
import { formatLines, LINE_CAP } from "./sizing";

// What reaches the contributor's agent (plan.md, "How the brief reaches the
// agent"). The site only builds a link: nothing runs until the person presses
// Enter in their own Claude session.

export const taskRef = (id: number) => `PI-${id}`;

export function parseTaskRef(value: string): number | null {
  const m = /^\s*PI-(\d+)\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

export function prTemplate(ref: string, acceptance: string[]): string {
  const criteria = acceptance.length ? acceptance.map((c) => `- [ ] ${c}`).join("\n") : "- [ ] <each acceptance criterion>";
  return `Task: ${ref}

## Summary
- <what changed, three bullets at most>

## Files changed
- <path>: <what changed>

## Acceptance criteria
${criteria}

## How it was tested
<the command you ran and its result>

## Risks or notes
<anything the reviewer should look at closely>

## Agent
<agent and model used>`;
}

export type PromptInput = {
  task: {
    id: number;
    kind: TaskKind;
    sizeTier: SizeTier;
    briefMd: string;
    acceptance: string[];
    testCommand: string;
  };
  repo: { fullName: string; hasProjectBrief: boolean; offLimitsPaths: string[] };
  project: { title: string; goal: string } | null;
  milestone: {
    position: number;
    title: string;
    goal: string;
    /** Earlier tasks in the same milestone, in order. */
    earlier: { position: number; title: string; status: TaskStatus }[];
  } | null;
};

export function buildPrompt({ task, repo, project, milestone }: PromptInput): string {
  const ref = taskRef(task.id);
  const noTest = task.testCommand.trim().toLowerCase() === "none";
  const lines: string[] = [
    `You're picking up part of a coworker's project in the GitHub repo ${repo.fullName}. Work only on the task below.`,
  ];

  if (project || milestone) {
    const context: string[] = [];
    if (project) context.push(`Project: ${project.title}. ${project.goal}`);
    if (milestone) {
      context.push(`Milestone ${milestone.position}: ${milestone.title}. ${milestone.goal}`);
      const done = milestone.earlier.filter((t) => t.status === "merged");
      if (done.length) {
        context.push(`Earlier tasks in this milestone, already merged: ${done.map((t) => `Task ${t.position}, ${t.title} (merged)`).join("; ")}.`);
      }
    }
    lines.push(context.join("\n"));
  }

  lines.push(
    repo.hasProjectBrief
      ? "Read PROJECT_BRIEF.md first. It has the setup and check commands, the repo map and the conventions."
      : "This repo has no PROJECT_BRIEF.md yet, so read the README and the files below to learn its setup and conventions.",
  );

  lines.push(task.briefMd.trim());

  const rules = [
    `- Off-limits paths (never change these): ${repo.offLimitsPaths.join(", ") || "none"}`,
    "- Touch only the allowed paths in the brief. No unrelated reformatting or renaming.",
    `- Stay under ${formatLines(LINE_CAP[task.sizeTier])} lines changed (lines added plus lines removed).`,
  ];
  if (task.kind === "other") {
    rules.push("- Deliver the work as files in this repo (Markdown for writing and research), at the path named under Output.");
  }
  rules.push(
    noTest
      ? "- There's no test command for this task. Check the result against every acceptance criterion before you finish."
      : "- Run the test command and make sure it passes before you finish.",
    "- Don't run commands other than the repo's own setup and test commands.",
  );
  lines.push(`Rules:\n${rules.join("\n")}`);

  lines.push(
    `When you're done, open a pull request from a branch in this repo (not a fork). The PR body must follow this template, starting with the line \`Task: ${ref}\`, with every section filled in:\n\n${prTemplate(ref, task.acceptance)}`,
  );

  return lines.join("\n\n") + "\n";
}

// Spaces as %20, not "+": the same encoding the prototype proved works.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Claude Code on the web, with the repo and prompt filled in. */
export function startInClaudeUrl(prompt: string, repoFullName: string): string {
  return `https://claude.ai/code?prompt=${enc(prompt)}&repositories=${enc(repoFullName)}`;
}

/** The Guided walkthrough. It never mentions merging: the owner takes it from there. */
export const GUIDED_STEPS = [
  "Click Start in Claude. Claude Code opens with this repo and the task already filled in.",
  "Press Enter. Claude works on its own, so you don't need to watch. It can take a while.",
  "When Claude is done, it opens a pull request on GitHub by itself. You don't need to click anything there.",
  "Come back to this page and click Check for my PR.",
  "The automatic checks run, and the owner takes it from here.",
];
