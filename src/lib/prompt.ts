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

/**
 * The PR body from plan.md ("Review-friendly PRs"). Every criterion word for
 * word with a pointer to where it's met, so the owner's agent checks lines
 * instead of searching. Files changed, line counts and CI results are left
 * out: GitHub shows them for free.
 */
export function prTemplate(ref: string, acceptance: string[]): string {
  const criteria = (acceptance.length ? acceptance : ["<each acceptance criterion>"])
    .map((c) => `- [ ] ${c} -> <file:line>`)
    .join("\n");
  return `Task: ${ref}

## Summary
- <what changed, three bullets at most>

## Acceptance criteria
${criteria}

## Where to look
- <file:lines>: <what to read first, and why>

## How it was tested
<each command you ran and its result, then one line on what your second review pass found>

## Not done or assumed
- <what you left out and every assumption you made, or "Nothing">

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

  // Contributor rules (plan.md, "How the brief reaches the agent"): only the
  // owner's usage is kept low, so the contributor's agent is asked to be
  // thorough and to review its own work twice. The contributor's part ends
  // when the PR opens: nothing here ever asks them to wait or come back.
  const rules = [
    "- Be thorough: getting this right matters more than finishing fast. Read as much of the repo as you need, write thorough tests, and run the full test suite (for docs, every lint and link check), not only the brief's test command.",
    `- Off-limits paths (never change these): ${repo.offLimitsPaths.join(", ") || "none"}`,
    "- Touch only the allowed paths in the brief. No unrelated reformatting or renaming.",
    `- Stay under ${formatLines(LINE_CAP[task.sizeTier])} lines changed (lines added plus lines removed, tests included).`,
  ];
  if (task.kind === "other") {
    rules.push("- Deliver the work as files in this repo (Markdown for writing and research), at the path named under Output.");
  }
  rules.push(
    noTest
      ? "- There's no test command for this task, so check the result against every acceptance criterion yourself."
      : "- The test command and the full suite must pass before you finish.",
    "- Don't run commands other than the repo's own setup and test commands.",
    '- If something is unclear, take the likeliest reading, note it under "Not done or assumed" and carry on. Only when a wrong guess would waste the whole run: open the PR as a draft with what you have, add a comment starting "Question for owner:" with one question, the options you see and the one you would take, and end the run there. Don\'t wait for an answer: the owner takes it from there.',
    "- Before you open the PR, review your own diff a second time, independently, against every acceptance criterion, for example with a fresh subagent asked to find problems. Fix what it finds and run the tests again.",
    "- Then check its shape yourself, the way Pitch In will: under the line cap, only allowed paths touched, every template section filled, every criterion copied word for word with one pointer that lands on lines your diff changed.",
  );
  lines.push(`How to work:\n${rules.join("\n")}`);

  lines.push(
    `When you're done, open a pull request from a branch in this repo (not a fork), with this template as its body, starting with the line \`Task: ${ref}\`. Copy every acceptance criterion word for word, tick it, and give it exactly one pointer to where it's met: file:line or file:start-end, with the full path, on lines your diff changed. Write "CI" instead only for a criterion that says all tests pass. Put anything else worth reading under "Where to look". Leave out the files changed, commits, line counts and CI results: GitHub shows those.\n\n${prTemplate(ref, task.acceptance)}\n\nOnce the PR is open, your part is done: the owner reviews it and handles any fixes, so don't wait for a reply.`,
  );

  return lines.join("\n\n") + "\n";
}

/**
 * The longest Start in Claude link we've seen fill in the whole prompt. Past it
 * the task page points to Copy brief as well. The prototype proved about 3,600
 * characters; on 2026-11-24 a 6,636-character link (a real Milestone 4 task)
 * and an 8,858-character one (a 529-word sample brief, over the word limit)
 * both filled in completely. Raise it only after checking a longer link by hand.
 */
export const LONGEST_TESTED_LINK = 8_858;

export const isLongLink = (url: string) => url.length > LONGEST_TESTED_LINK;

// Spaces as %20, not "+": the same encoding the prototype proved works.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Claude Code on the web, with the repo and prompt filled in. */
export function startInClaudeUrl(prompt: string, repoFullName: string): string {
  return `https://claude.ai/code?prompt=${enc(prompt)}&repositories=${enc(repoFullName)}`;
}

/**
 * The Guided walkthrough. It never mentions merging, and never asks the person
 * to come back: once the PR is open, the owner takes it from there.
 */
export const GUIDED_STEPS = [
  "Click Start in Claude. Claude Code opens with this repo and the task already filled in.",
  "Press Enter. Claude works on its own, so you don't need to watch. It can take a while.",
  "When Claude is done, it opens a pull request on GitHub by itself. You don't need to click anything there.",
  "That's it: your part is done. The automatic checks run, and the owner takes it from here.",
];
