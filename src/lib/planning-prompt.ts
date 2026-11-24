import type { SizeTier } from "./db/schema";
import { startInClaudeUrl } from "./prompt";

// Plan in Claude (plan.md, "Planning a project with the owner's agent"). The
// owner's own agent splits a plan they already have into milestones and task
// briefs, once, and answers in the import format. The prompt is the same for
// every project, apart from the repo's settings and the plan file and section,
// so the link stays inside the length the prototype proved.

/** The longest planning link we accept: the prototype's links ran 3,200 to 3,600 characters and worked. */
export const PLANNING_LINK_LIMIT = 3_500;

/** Plan file and section are one short line each. */
export const PLAN_FIELD_MAX = 120;

/** The import format, empty. The owner's agent fills it in; parseImport reads it. */
export const IMPORT_SKELETON =
  '{"project":{"title":"","goal":""},"milestones":[{"title":"","goal":"","tasks":[{"title":"","kind":"code","estimate":"small","goal":"","files":[],"allowedPaths":[],"acceptance":[],"testCommand":"","constraints":""}]}]}';

export type PlanningInput = {
  repo: { fullName: string; largestTier: SizeTier; offLimitsPaths: string[]; hasProjectBrief: boolean };
  /** The plan file in the repo, e.g. plan.md. Empty when the owner has no plan yet. */
  planFile: string;
  /** The part of it to split, e.g. "Milestone 4". Empty means the whole file. */
  section: string;
};

/** One line, trimmed and capped, so a field can't add instructions of its own. */
export function cleanPlanField(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PLAN_FIELD_MAX);
}

export function buildPlanningPrompt({ repo, planFile, section }: PlanningInput): string {
  const file = cleanPlanField(planFile);
  const part = cleanPlanField(section);
  const brief = repo.hasProjectBrief ? "PROJECT_BRIEF.md, with its repo map" : "the README";

  const what = !file
    ? "There's no plan file. First ask me what the project should do, then split my answer."
    : part
      ? `What to split: the section "${part}" of ${file}.`
      : `What to split: all of ${file}.`;
  const reading =
    (file ? `Read only that section and ${brief}.` : `Read only ${brief}.`) +
    (repo.hasProjectBrief ? "" : " This repo has no PROJECT_BRIEF.md yet.");

  const rules = [
    "- One task is one PR and one session, written so someone new to the repo can finish it in one pass.",
    `- estimate: small (up to 300 lines changed), medium (1,000) or large (2,000), tests included. This repo allows ${repo.largestTier} at most.`,
    "- files: real paths that exist now, not ones an earlier task creates; five at most. For new work, the closest file or folder.",
    `- allowedPaths: globs the PR may touch, like "src/upload/**"${repo.offLimitsPaths.length ? `; never these off-limits paths: ${repo.offLimitsPaths.join(", ")}` : ""}.`,
    "- acceptance: yes/no checks a reviewer can tick in seconds. Every review checks against them.",
    '- testCommand: one plain command (no ; && | $( ), from the repo\'s own commands. Docs or research: the lint or link check, or "none".',
    '- kind "other" is for research, writing and design, and needs output: the file to write and its format.',
    "- Optional: current and expected (bugs, with steps to reproduce), outOfScope, example.",
    "- Each brief stays under 500 words; longer means two tasks. Tasks go in dependency order. Each milestone ends at something usable.",
    "- No secrets, customer data, outside links, or commands beyond the repo's own setup and test commands.",
  ];

  return [
    `Plan a project for Pitch In, our board where coworkers each take on one task in their own Claude session, in the GitHub repo ${repo.fullName}. Split the plan into milestones and tasks. Don't change, commit or push anything, and don't open a pull request.`,
    what,
    `Keep it cheap: reformat the plan, don't redesign it. ${reading} Open another file only to confirm a path or a name (git ls-files lists them). Never read the whole codebase; contributors do that. Where the plan is unclear, take the simplest reading and say so in that task's constraints, so contributors never need to ask.`,
    `Splitting rules:\n${rules.join("\n")}`,
    `Answer with only one \`\`\`json block in this format, every field filled in, testCommand included:\n\`\`\`json\n${IMPORT_SKELETON}\n\`\`\``,
  ].join("\n\n") + "\n";
}

/** Claude Code on the web on the repo, with the planning prompt filled in. */
export function planInClaudeUrl(input: PlanningInput): string {
  return startInClaudeUrl(buildPlanningPrompt(input), input.repo.fullName);
}
