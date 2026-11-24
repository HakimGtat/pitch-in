import type { BriefCheck, BriefDraft } from "./brief";
import type { Task, TaskKind } from "./db/schema";
import { splitLines, splitList } from "./glob";
import { parseTier } from "./sizing";

// The task form works with plain strings so the browser can keep what was
// typed while the brief checker answers. These convert to and from a draft.

export type TaskFormValues = {
  title: string;
  kind: TaskKind;
  sizeTier: string;
  goal: string;
  files: string;
  output: string;
  allowedPaths: string;
  current: string;
  expected: string;
  acceptance: string;
  testCommand: string;
  constraints: string;
  outOfScope: string;
  example: string;
};

export const TASK_FIELDS = [
  "title",
  "kind",
  "sizeTier",
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
] as const satisfies readonly (keyof TaskFormValues)[];

export const blankTaskValues = (): TaskFormValues => ({
  title: "",
  kind: "code",
  sizeTier: "",
  goal: "",
  files: "",
  output: "",
  allowedPaths: "",
  current: "",
  expected: "",
  acceptance: "",
  testCommand: "",
  constraints: "",
  outOfScope: "",
  example: "",
});

export function valuesFromForm(fd: FormData): TaskFormValues {
  const get = (k: string) => String(fd.get(k) ?? "");
  return {
    ...Object.fromEntries(TASK_FIELDS.map((k) => [k, get(k)])),
    kind: get("kind") === "other" ? "other" : "code",
  } as TaskFormValues;
}

export function valuesFromTask(task: Task): TaskFormValues {
  const b = task.brief;
  return {
    title: task.title,
    kind: task.kind,
    sizeTier: task.sizeTier,
    goal: b.goal,
    files: b.files.join("\n"),
    output: b.output,
    allowedPaths: task.allowedPaths.join("\n"),
    current: b.current,
    expected: b.expected,
    acceptance: b.acceptance.join("\n"),
    testCommand: b.testCommand,
    constraints: b.constraints,
    outOfScope: b.outOfScope,
    example: b.example,
  };
}

export function draftFromValues(v: TaskFormValues): BriefDraft {
  return {
    title: v.title.trim(),
    kind: v.kind,
    sizeTier: parseTier(v.sizeTier),
    allowedPaths: splitList(v.allowedPaths),
    brief: {
      goal: v.goal.trim(),
      files: splitLines(v.files),
      output: v.output.trim(),
      current: v.current.trim(),
      expected: v.expected.trim(),
      acceptance: splitLines(v.acceptance),
      testCommand: v.testCommand.trim(),
      constraints: v.constraints.trim(),
      outOfScope: v.outOfScope.trim(),
      example: v.example.trim(),
    },
  };
}

/** What the task form shows after the checker ran. */
export type TaskFormState = {
  values: TaskFormValues;
  check: Pick<BriefCheck, "errors" | "warnings" | "words"> | null;
  needsAck: boolean;
  error: string | null;
};
