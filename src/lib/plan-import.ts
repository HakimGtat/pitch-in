import {
  checkBrief,
  checkProjectInput,
  type BriefContext,
  type BriefDraft,
  type BriefField,
  type BriefFlag,
} from "./brief";
import type { SizeTier, TaskBrief } from "./db/schema";
import { parseTier } from "./sizing";

// Plan import (plan.md, "Planning a project with the owner's agent"). The
// owner's agent answers Plan in Claude with one JSON block; the owner pastes
// it here. Parsing only checks the shape and never guesses content: missing
// fields stay empty so the brief checker flags them like it does on the form.

export const MAX_IMPORT_CHARS = 200_000;
export const MAX_MILESTONES = 12;
export const MAX_TASKS = 60;

export type ImportMilestone = { title: string; goal: string; tasks: BriefDraft[] };
export type ImportPlan = { project: { title: string; goal: string }; milestones: ImportMilestone[] };
export type ParseResult = { ok: true; plan: ImportPlan } | { ok: false; errors: string[] };

// ---------- finding the JSON ----------

/** The JSON object in what the owner pasted: bare, in a ``` fence, or with prose around it. */
export function extractJson(text: string): { ok: true; json: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste the JSON block your Claude session answered with." };
  for (const m of trimmed.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)) {
    const body = m[1].trim();
    if (body.startsWith("{")) return { ok: true, json: body };
  }
  // Bare JSON that isn't an object: let the parser say what's wrong with it.
  if (trimmed.startsWith("[")) return { ok: true, json: trimmed };
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end < start) {
    return { ok: false, error: "No JSON found. Paste the ```json block from your Claude session, braces and all." };
  }
  return { ok: true, json: trimmed.slice(start, end + 1) };
}

// ---------- parsing ----------

const TOP_KEYS = ["project", "milestones"];
const PROJECT_KEYS = ["title", "goal"];
const MILESTONE_KEYS = ["title", "goal", "tasks"];
const TASK_KEYS = [
  "title",
  "kind",
  "estimate",
  "goal",
  "files",
  "output",
  "allowedPaths",
  "current",
  "expected",
  "acceptance",
  "testCommand",
  "constraints",
  "outOfScope",
  "example",
];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads fields off one JSON object, collecting errors that name the place. */
class Reader {
  constructor(
    private readonly obj: Record<string, unknown>,
    private readonly where: string,
    private readonly errors: string[],
  ) {}

  private fail(message: string) {
    this.errors.push(`${this.where}: ${message}`);
  }

  unknownKeys(allowed: string[]) {
    for (const key of Object.keys(this.obj)) {
      if (!allowed.includes(key)) this.fail(`unknown field "${key}". The fields are: ${allowed.join(", ")}.`);
    }
  }

  text(key: string): string {
    const v = this.obj[key];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") {
      this.fail(`${key} must be text.`);
      return "";
    }
    return v.trim();
  }

  list(key: string, example: string): string[] {
    const v = this.obj[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      this.fail(`${key} must be a list of text, like ["${example}"].`);
      return [];
    }
    return (v as string[]).map((x) => x.trim()).filter(Boolean);
  }

  raw(key: string): unknown {
    return this.obj[key];
  }

  problem(message: string) {
    this.fail(message);
  }
}

function readTask(value: unknown, where: string, errors: string[]): BriefDraft | null {
  if (!isObject(value)) {
    errors.push(`${where}: must be an object with the Task Brief fields.`);
    return null;
  }
  const r = new Reader(value, where, errors);
  r.unknownKeys(TASK_KEYS);
  const title = r.text("title");

  const kindRaw = r.raw("kind");
  const kind = typeof kindRaw === "string" ? kindRaw.trim().toLowerCase() : null;
  if (kind !== "code" && kind !== "other") {
    r.problem('kind must be "code" or "other" (use "other" for research, writing and design).');
  }

  const estimateRaw = r.raw("estimate");
  let sizeTier: SizeTier | null = null;
  if (estimateRaw !== undefined && estimateRaw !== null && estimateRaw !== "") {
    sizeTier = parseTier(typeof estimateRaw === "string" ? estimateRaw.trim().toLowerCase() : estimateRaw);
    if (!sizeTier) r.problem("estimate must be small, medium or large.");
  }

  // Read in the format's order, so errors come out in the order the owner sees the fields.
  const goal = r.text("goal");
  const files = r.list("files", "src/app.ts");
  const output = r.text("output");
  const allowedPaths = r.list("allowedPaths", "src/**");
  const current = r.text("current");
  const expected = r.text("expected");
  const acceptance = r.list("acceptance", "slugify(null) throws a TypeError");
  const brief: TaskBrief = {
    goal,
    files,
    output,
    current,
    expected,
    acceptance,
    testCommand: r.text("testCommand"),
    constraints: r.text("constraints"),
    outOfScope: r.text("outOfScope"),
    example: r.text("example"),
  };
  return { title, kind: kind === "other" ? "other" : "code", sizeTier, allowedPaths, brief };
}

/** Parses the agent's answer into a project, its milestones and task drafts. */
export function parseImport(text: string): ParseResult {
  if (text.length > MAX_IMPORT_CHARS) {
    return {
      ok: false,
      errors: [`That's more than ${MAX_IMPORT_CHARS.toLocaleString("en-US")} characters, too long for one import. Split the plan into two projects.`],
    };
  }
  const found = extractJson(text);
  if (!found.ok) return { ok: false, errors: [found.error] };

  let data: unknown;
  try {
    data = JSON.parse(found.json);
  } catch (err) {
    return { ok: false, errors: [`The JSON doesn't parse: ${(err as Error).message}`] };
  }
  if (!isObject(data)) return { ok: false, errors: ['The JSON must be one object with "project" and "milestones".'] };

  const errors: string[] = [];
  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.includes(key)) errors.push(`Unknown field "${key}" at the top. The fields are: ${TOP_KEYS.join(", ")}.`);
  }

  const project = { title: "", goal: "" };
  if (isObject(data.project)) {
    const r = new Reader(data.project, "Project", errors);
    r.unknownKeys(PROJECT_KEYS);
    project.title = r.text("title");
    project.goal = r.text("goal");
  } else {
    errors.push('Project: must be an object with "title" and "goal".');
  }

  const milestones: ImportMilestone[] = [];
  const list = data.milestones ?? [];
  if (!Array.isArray(list)) {
    errors.push("milestones must be a list of milestones, in order.");
  } else {
    if (list.length > MAX_MILESTONES) {
      errors.push(`That's ${list.length} milestones; one import takes ${MAX_MILESTONES} at most.`);
    }
    let taskCount = 0;
    list.slice(0, MAX_MILESTONES).forEach((m, i) => {
      const where = `Milestone ${i + 1}`;
      if (!isObject(m)) {
        errors.push(`${where}: must be an object with "title", "goal" and "tasks".`);
        return;
      }
      const r = new Reader(m, where, errors);
      r.unknownKeys(MILESTONE_KEYS);
      const milestone: ImportMilestone = { title: r.text("title"), goal: r.text("goal"), tasks: [] };
      const tasks = m.tasks ?? [];
      if (!Array.isArray(tasks)) {
        r.problem("tasks must be a list of tasks, in order.");
      } else {
        taskCount += tasks.length;
        tasks.forEach((t, j) => {
          const draft = readTask(t, `${where}, task ${j + 1}`, errors);
          if (draft) milestone.tasks.push(draft);
        });
      }
      milestones.push(milestone);
    });
    if (taskCount > MAX_TASKS) {
      errors.push(`That's ${taskCount} tasks; one import takes ${MAX_TASKS} at most. Split the plan into two projects.`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, plan: { project, milestones } };
}

// ---------- checking ----------

export type TaskPreview = {
  draft: BriefDraft;
  errors: BriefFlag[];
  warnings: BriefFlag[];
  words: number;
  markdown: string;
};
export type MilestonePreview = { title: string; goal: string; flags: string[]; tasks: TaskPreview[] };
export type ImportPreview = {
  project: { title: string; goal: string; flags: string[] };
  milestones: MilestonePreview[];
  /** Flags that block posting. */
  errors: number;
  /** Flags that need a "Post anyway". */
  warnings: number;
  tasks: number;
};

/** Runs the brief checker on every task and the goal checks on the project and its milestones. */
export function checkImport(plan: ImportPlan, ctx: BriefContext): ImportPreview {
  const goalFlags = checkProjectInput(
    { title: plan.project.title, goal: plan.project.goal, milestones: plan.milestones },
    ctx.repoFullName,
  );
  const milestoneFlag = /^milestone(\d+)$/;
  const project = {
    ...plan.project,
    flags: goalFlags.filter((f) => !milestoneFlag.test(f.field)).map((f) => f.message),
  };

  let errors = project.flags.length;
  let warnings = 0;
  let tasks = 0;
  const milestones = plan.milestones.map((m, i): MilestonePreview => {
    const flags = goalFlags.filter((f) => f.field === `milestone${i}`).map((f) => f.message);
    if (m.tasks.length === 0) flags.push(`Milestone ${i + 1} has no tasks. Every milestone needs at least one.`);
    errors += flags.length;
    const checked = m.tasks.map((draft): TaskPreview => {
      const check = checkBrief(draft, ctx);
      errors += check.errors.length;
      warnings += check.warnings.length;
      tasks += 1;
      return { draft, errors: check.errors, warnings: check.warnings, words: check.words, markdown: check.markdown };
    });
    return { title: m.title, goal: m.goal, flags, tasks: checked };
  });

  return { project, milestones, errors, warnings, tasks };
}

// ---------- telling the owner's agent what to fix ----------

/** The import format's names for the checker's fields. */
const JSON_FIELD: Record<BriefField, string> = {
  title: "title",
  goal: "goal",
  files: "files",
  output: "output",
  allowedPaths: "allowedPaths",
  current: "current",
  expected: "expected",
  acceptance: "acceptance",
  testCommand: "testCommand",
  constraints: "constraints",
  sizeTier: "estimate",
  brief: "brief",
};

/** Every flag as one line that says where it is. */
export function previewFlagLines(preview: ImportPreview): { errors: string[]; warnings: string[] } {
  const errors = preview.project.flags.map((f) => `Project: ${f}`);
  const warnings: string[] = [];
  preview.milestones.forEach((m, i) => {
    errors.push(...m.flags);
    m.tasks.forEach((t, j) => {
      const where = `Milestone ${i + 1}, task ${j + 1}${t.draft.title ? ` ("${t.draft.title}")` : ""}`;
      for (const f of t.errors) errors.push(`${where}, ${JSON_FIELD[f.field]}: ${f.message}`);
      for (const f of t.warnings) warnings.push(`${where}, ${JSON_FIELD[f.field]}: ${f.message}`);
    });
  });
  return { errors, warnings };
}

/** What the owner pastes back into their Claude session to get a fixed plan. */
export function fixRequest(errors: string[], warnings: string[]): string {
  const parts: string[] = [];
  if (errors.length) {
    parts.push(
      `Pitch In checked the plan and found ${errors.length} ${errors.length === 1 ? "problem" : "problems"}. Fix ${errors.length === 1 ? "it" : "them"}, keep everything else the same, and answer with the whole JSON block again.`,
      errors.map((e) => `- ${e}`).join("\n"),
    );
  } else {
    parts.push("Pitch In checked the plan and found no problems, only warnings. Answer with the whole JSON block again if you change anything.");
  }
  if (warnings.length) {
    parts.push(
      `Warnings (fine if the task creates these paths; change them only if they're wrong):\n${warnings.map((w) => `- ${w}`).join("\n")}`,
    );
  }
  return parts.join("\n\n") + "\n";
}
