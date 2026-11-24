"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PermissionError, setTakeOn } from "@/lib/admin";
import { adoptMilestone, adoptTask, handBack, releaseAdoption } from "@/lib/adoption";
import { requireUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { draftFromValues, valuesFromForm, type TaskFormState } from "@/lib/forms";
import { createRepoGitHub } from "@/lib/github/app";
import { splitList } from "@/lib/glob";
import { linkPastedPr } from "@/lib/pr-link";
import { connectRepo, parseRepoSettings, refreshRepo, removeRepo, updateRepoSettings } from "@/lib/repos";
import { reopenTask } from "@/lib/review";
import { fixRequest, previewFlagLines, type ImportPreview } from "@/lib/plan-import";
import { parseTakeOn } from "@/lib/sizing";
import {
  addMilestone,
  closeProject,
  closeTask,
  createProject,
  editTask,
  importPlan,
  markProjectDone,
  postTask,
  type FormFlag,
  type PostTarget,
} from "@/lib/work";

// Server actions for repos, projects, tasks and adoption. Every rule lives in
// src/lib; these only read the form, call the rule and say what happened.

const gh = () => createRepoGitHub(getConfig());
const num = (fd: FormData, key: string) => Number(fd.get(key));

const withMessage = (path: string, kind: "notice" | "error", message: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}`;

const githubTrouble = (err: unknown) =>
  err instanceof Error && /isn't installed|isn't set up/.test(err.message)
    ? err.message
    : "Pitch In couldn't reach GitHub just now. Try again in a minute.";

/** Runs a change and goes back to `path` with a notice, or with the reason it was refused. */
async function change(path: string, run: () => Promise<string>): Promise<never> {
  let target: string;
  try {
    const notice = await run();
    target = withMessage(path, "notice", notice);
  } catch (err) {
    if (err instanceof PermissionError) target = withMessage(path, "error", err.message);
    else {
      console.error("[action]", err);
      target = withMessage(path, "error", githubTrouble(err));
    }
  }
  revalidatePath("/", "layout");
  redirect(target);
}

// ---------- the take-on choice ----------

export async function chooseTakeOn(formData: FormData) {
  const user = await requireUser();
  const takeOn = parseTakeOn(formData.get("takeOn"));
  if (takeOn) await setTakeOn(getDb(), user.id, takeOn);
  revalidatePath("/", "layout");
  const back = String(formData.get("back") ?? "");
  redirect(back === "profile" ? "/profile?saved=1" : `/?take=${takeOn ?? ""}`);
}

// ---------- repos ----------

export async function connectRepoAction(formData: FormData) {
  const user = await requireUser();
  let target: string;
  try {
    const result = await connectRepo(getDb(), gh(), user.id, num(formData, "githubRepoId"));
    target = result.ok
      ? `/repos/${result.repoId}?connected=1`
      : `/repos/connect?noci=${encodeURIComponent(result.fullName)}`;
  } catch (err) {
    if (!(err instanceof PermissionError)) console.error("[connect]", err);
    target = withMessage("/repos/connect", "error", err instanceof PermissionError ? err.message : githubTrouble(err));
  }
  revalidatePath("/", "layout");
  redirect(target);
}

export async function refreshRepoAction(formData: FormData) {
  await requireUser();
  const repoId = num(formData, "repoId");
  await change(`/repos/${repoId}`, async () => {
    const repo = await refreshRepo(getDb(), gh(), repoId);
    return `Read ${repo.fullName} from GitHub again.`;
  });
}

export async function saveRepoSettingsAction(formData: FormData) {
  const user = await requireUser();
  const repoId = num(formData, "repoId");
  await change(`/repos/${repoId}`, async () => {
    const parsed = parseRepoSettings({
      largestTier: formData.get("largestTier"),
      offLimitsPaths: splitList(String(formData.get("offLimitsPaths") ?? "")),
      sizeCapIgnore: splitList(String(formData.get("sizeCapIgnore") ?? "")),
    });
    if (!parsed.ok) throw new PermissionError(parsed.error);
    await updateRepoSettings(getDb(), gh(), user.id, repoId, parsed.settings);
    return "Repo settings saved.";
  });
}

export async function removeRepoAction(formData: FormData) {
  const user = await requireUser();
  const repoId = num(formData, "repoId");
  if (formData.get("confirm") !== "yes") redirect(withMessage(`/repos/${repoId}`, "error", "Tick the box to confirm."));
  let target = "/repos";
  try {
    await removeRepo(getDb(), user.id, repoId);
    target = withMessage("/repos", "notice", "Repo removed. Its open work was closed.");
  } catch (err) {
    if (!(err instanceof PermissionError)) throw err;
    target = withMessage(`/repos/${repoId}`, "error", err.message);
  }
  revalidatePath("/", "layout");
  redirect(target);
}

// ---------- tasks ----------

async function briefAction(
  prev: TaskFormState,
  formData: FormData,
  save: (userId: number, draft: ReturnType<typeof draftFromValues>, ack: boolean) => ReturnType<typeof postTask>,
): Promise<TaskFormState> {
  const user = await requireUser();
  const values = valuesFromForm(formData);
  const ack = formData.get("ack") === "1";
  let taskId: number;
  try {
    const result = await save(user.id, draftFromValues(values), ack);
    if (!result.ok) {
      const { errors, warnings, words } = result.check;
      return { values, check: { errors, warnings, words }, needsAck: result.needsAck, error: null };
    }
    taskId = result.taskId;
  } catch (err) {
    if (!(err instanceof PermissionError)) console.error("[task]", err);
    return { values, check: prev.check, needsAck: false, error: err instanceof PermissionError ? err.message : githubTrouble(err) };
  }
  revalidatePath("/", "layout");
  redirect(`/tasks/${taskId}?notice=${encodeURIComponent("Posted. It's on the board now.")}`);
}

export async function postTaskAction(prev: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const milestoneId = num(formData, "milestoneId");
  const target: PostTarget = milestoneId ? { milestoneId } : { repoId: num(formData, "repoId") };
  if (!milestoneId && !num(formData, "repoId")) {
    return { values: valuesFromForm(formData), check: prev.check, needsAck: false, error: "Pick the repo this task is in." };
  }
  return briefAction(prev, formData, (userId, draft, ack) => postTask(getDb(), gh(), userId, target, draft, ack));
}

export async function editTaskAction(prev: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const taskId = num(formData, "taskId");
  return briefAction(prev, formData, (userId, draft, ack) => editTask(getDb(), gh(), userId, taskId, draft, ack));
}

export async function closeTaskAction(formData: FormData) {
  const user = await requireUser();
  const taskId = num(formData, "taskId");
  await change(`/tasks/${taskId}`, async () => {
    await closeTask(getDb(), user.id, taskId);
    return "Task closed. It's off the board.";
  });
}

// ---------- adoption ----------

export async function adoptTaskAction(formData: FormData) {
  const user = await requireUser();
  const taskId = num(formData, "taskId");
  await change(`/tasks/${taskId}`, async () => {
    await adoptTask(getDb(), user.id, taskId);
    return "It's yours for the next 48 hours. Start whenever you're ready.";
  });
}

export async function adoptMilestoneAction(formData: FormData) {
  const user = await requireUser();
  const milestoneId = num(formData, "milestoneId");
  const back = String(formData.get("back") || "/");
  let target: string;
  try {
    const taskIds = await adoptMilestone(getDb(), user.id, milestoneId);
    target = withMessage(
      `/tasks/${taskIds[0]}`,
      "notice",
      `You took on the whole milestone (${taskIds.length} ${taskIds.length === 1 ? "task" : "tasks"}) for the next 48 hours. Start with this one.`,
    );
  } catch (err) {
    if (!(err instanceof PermissionError)) throw err;
    target = withMessage(back, "error", err.message);
  }
  revalidatePath("/", "layout");
  redirect(target);
}

export async function handBackAction(formData: FormData) {
  const user = await requireUser();
  const taskId = num(formData, "taskId");
  await change(`/tasks/${taskId}`, async () => {
    const ids = await handBack(getDb(), user.id, taskId);
    return ids.length > 1 ? `Handed back ${ids.length} tasks. They're on the board again.` : "Handed back. It's on the board again.";
  });
}

export async function linkPrAction(formData: FormData) {
  const user = await requireUser();
  const taskId = num(formData, "taskId");
  await change(`/tasks/${taskId}`, async () => {
    const { prNumber } = await linkPastedPr(getDb(), user.id, taskId, String(formData.get("prUrl") ?? ""));
    return `PR #${prNumber} is linked to this task.`;
  });
}

export async function reopenAction(formData: FormData) {
  const user = await requireUser();
  const taskId = num(formData, "taskId");
  await change(`/tasks/${taskId}`, async () => {
    const { reopened, closedPrs } = await reopenTask(getDb(), gh(), user.id, taskId, {
      reason: String(formData.get("reason") ?? ""),
      developersOnly: formData.get("developersOnly") === "on",
    });
    const prs = closedPrs.length ? ` PR ${closedPrs.map((n) => `#${n}`).join(", ")} closed with your reason.` : "";
    return reopened.length > 1
      ? `Reopened. ${reopened.length} tasks are back on the board, with your reason in this one's brief.${prs}`
      : `Reopened. It's back on the board with your reason in its brief.${prs}`;
  });
}

export async function releaseAction(formData: FormData) {
  const user = await requireUser();
  const taskId = num(formData, "taskId");
  await change(`/tasks/${taskId}`, async () => {
    const ids = await releaseAdoption(getDb(), user.id, taskId);
    return ids.length > 1 ? `Released ${ids.length} tasks.` : "Released. It's on the board again.";
  });
}

// ---------- projects ----------

export type ProjectFormState = {
  values: { repoId: string; title: string; goal: string; milestones: { title: string; goal: string }[] };
  flags: FormFlag[];
  error: string | null;
};

export async function createProjectAction(prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const user = await requireUser();
  const titles = formData.getAll("milestoneTitle").map(String);
  const goals = formData.getAll("milestoneGoal").map(String);
  const values = {
    repoId: String(formData.get("repoId") ?? ""),
    title: String(formData.get("title") ?? ""),
    goal: String(formData.get("goal") ?? ""),
    milestones: titles.map((title, i) => ({ title, goal: goals[i] ?? "" })),
  };
  if (!Number(values.repoId)) return { values, flags: [], error: "Pick the repo this project lives in." };
  // Rows left completely empty are just spare rows.
  const milestones = values.milestones.filter((m) => m.title.trim() || m.goal.trim());

  let projectId: number;
  try {
    const result = await createProject(getDb(), gh(), user.id, Number(values.repoId), { ...values, milestones });
    if (!result.ok) return { values, flags: result.flags, error: null };
    projectId = result.projectId;
  } catch (err) {
    if (!(err instanceof PermissionError)) console.error("[project]", err);
    return { values, flags: [], error: err instanceof PermissionError ? err.message : githubTrouble(err) };
  }
  revalidatePath("/", "layout");
  redirect(`/projects/${projectId}?notice=${encodeURIComponent("Project posted. Add tasks to its milestones next.")}`);
}

// ---------- plan import ----------

export type ImportFormState = {
  /** The pasted text this result is for, so the form can tell when it's been edited since. */
  checkedText: string;
  checkedRepoId: number;
  result:
    | { kind: "unparsed"; errors: string[]; fix: string }
    | { kind: "preview"; preview: ImportPreview; flags: { errors: string[]; warnings: string[] }; fix: string }
    | null;
  error: string | null;
};

export async function importPlanAction(prev: ImportFormState, formData: FormData): Promise<ImportFormState> {
  const user = await requireUser();
  const repoId = num(formData, "repoId");
  const text = String(formData.get("text") ?? "");
  const intent = String(formData.get("intent") ?? "check");
  if (!repoId) return { checkedText: text, checkedRepoId: 0, result: null, error: "Pick the repo this project lives in." };

  let projectId: number;
  let count: number;
  try {
    const outcome = await importPlan(getDb(), gh(), user.id, repoId, text, {
      post: intent === "post" || intent === "post-anyway",
      acknowledged: intent === "post-anyway",
    });
    if (outcome.kind === "unparsed") {
      return { checkedText: text, checkedRepoId: repoId, result: { ...outcome, fix: fixRequest(outcome.errors, []) }, error: null };
    }
    if (outcome.kind === "preview") {
      const flags = previewFlagLines(outcome.preview);
      return {
        checkedText: text,
        checkedRepoId: repoId,
        result: { kind: "preview", preview: outcome.preview, flags, fix: fixRequest(flags.errors, flags.warnings) },
        error: null,
      };
    }
    projectId = outcome.projectId;
    count = outcome.taskIds.length;
  } catch (err) {
    if (!(err instanceof PermissionError)) console.error("[import]", err);
    return { ...prev, error: err instanceof PermissionError ? err.message : githubTrouble(err) };
  }
  revalidatePath("/", "layout");
  redirect(
    `/projects/${projectId}?notice=${encodeURIComponent(`Project posted with ${count} ${count === 1 ? "task" : "tasks"}. It's on the board now.`)}`,
  );
}

export async function addMilestoneAction(formData: FormData) {
  const user = await requireUser();
  const projectId = num(formData, "projectId");
  await change(`/projects/${projectId}`, async () => {
    const r = await addMilestone(getDb(), gh(), user.id, projectId, {
      title: String(formData.get("title") ?? ""),
      goal: String(formData.get("goal") ?? ""),
    });
    if (!r.ok) throw new PermissionError(r.flags.map((f) => f.message).join(" "));
    return "Milestone added.";
  });
}

export async function markProjectDoneAction(formData: FormData) {
  const user = await requireUser();
  const projectId = num(formData, "projectId");
  await change(`/projects/${projectId}`, async () => {
    await markProjectDone(getDb(), gh(), user.id, projectId);
    return "Project marked done.";
  });
}

export async function closeProjectAction(formData: FormData) {
  const user = await requireUser();
  const projectId = num(formData, "projectId");
  if (formData.get("confirm") !== "yes") redirect(withMessage(`/projects/${projectId}`, "error", "Tick the box to confirm."));
  await change(`/projects/${projectId}`, async () => {
    await closeProject(getDb(), user.id, projectId);
    return "Project closed. Its open tasks are off the board.";
  });
}
