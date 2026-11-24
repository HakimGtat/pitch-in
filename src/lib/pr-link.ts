import { and, eq, ne } from "drizzle-orm";
import { getUser, PermissionError } from "./admin";
import { writeAudit } from "./audit";
import type { Db } from "./db/client";
import { submissions, tasks } from "./db/schema";
import { parseTaskRef, taskRef } from "./prompt";
import { loadTaskView, type FullTaskView } from "./views";

// PR linking (plan.md, "PR linking"). A PR links to a task through a
// `Task: <id>` first line in its body, or through a link the adopter or the
// task owner pastes on the task page. Only the current adopter's PR links.
// Draft PRs link too. PRs that don't target the default branch are ignored.

// ---------- pure rules ----------

/** The task id from a body whose first line is `Task: PI-9` (or `Task: 9`). */
export function parseTaskLine(body: string | null | undefined): number | null {
  const first = (body ?? "").replace(/^﻿/, "").split(/\r?\n/).find((line) => line.trim() !== "");
  const m = first && /^\s*task\s*:\s*(\S+)\s*$/i.exec(first);
  if (!m) return null;
  const value = m[1];
  const id = /^\d+$/.test(value) ? Number(value) : parseTaskRef(value);
  return id !== null && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** `https://github.com/owner/repo/pull/12` (extra path, query or hash allowed) -> repo and number. */
export function parsePrUrl(text: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(text.trim());
  if (!m) return null;
  const number = Number(m[2]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: m[1], number } : null;
}

/** A PR into any branch other than the default one is not Pitch In's business. */
export const isIgnoredBase = (baseRef: string, defaultBranch: string): boolean => baseRef !== defaultBranch;

export type LinkTarget = {
  id: number;
  repoId: number;
  status: FullTaskView["status"];
  /** Handle of whoever holds the task right now, or null. */
  holderHandle: string | null;
};

export type LinkDecision = { linked: true; taskId: number } | { linked: false; reason: string };

/** Whether a PR by `authorHandle` in repo `repoId` links to the task its body names. */
export function decideLink(input: {
  taskId: number | null;
  task: LinkTarget | null;
  repoId: number;
  authorHandle: string;
}): LinkDecision {
  const { taskId, task, repoId, authorHandle } = input;
  if (taskId === null) return { linked: false, reason: "The PR body doesn't start with a line like `Task: PI-<id>`." };
  if (!task || task.repoId !== repoId) return { linked: false, reason: `${taskRef(taskId)} isn't a task in this repo.` };
  if (task.status === "merged" || task.status === "closed") {
    return { linked: false, reason: `${taskRef(task.id)} is already finished.` };
  }
  if (!task.holderHandle) return { linked: false, reason: `Nobody has taken on ${taskRef(task.id)} right now.` };
  if (task.holderHandle.toLowerCase() !== authorHandle.toLowerCase()) {
    return { linked: false, reason: `@${task.holderHandle} took on ${taskRef(task.id)}, so only their PR links to it.` };
  }
  return { linked: true, taskId: task.id };
}

// ---------- recording ----------

export type PullRequestInfo = {
  repoId: number;
  repoFullName: string;
  defaultBranch: string;
  number: number;
  baseRef: string;
  headSha: string;
  authorHandle: string;
  body: string | null;
  draft: boolean;
};

export type LinkOutcome =
  | { status: "ignored" }
  | { status: "linked"; taskId: number; submissionId: number }
  | { status: "unlinked"; reason: string };

const prTarget = (repoFullName: string, number: number) => `${repoFullName}#${number}`;

/** The task a PR is already linked to in this repo (a pasted link, or an earlier event), if any. */
async function existingLink(db: Db, repoId: number, number: number, exceptTaskId?: number) {
  const where = and(eq(tasks.repoId, repoId), eq(submissions.prNumber, number));
  const [row] = await db
    .select({ id: submissions.id, taskId: submissions.taskId, headSha: submissions.headSha })
    .from(submissions)
    .innerJoin(tasks, eq(submissions.taskId, tasks.id))
    .where(exceptTaskId === undefined ? where : and(where, ne(submissions.taskId, exceptTaskId)));
  return row ?? null;
}

/**
 * Links a PR from the pull_request webhook. Linked PRs get a submissions row.
 * Anything else is written to the audit log as `pr.unlinked` with its reason
 * (the submissions table needs a task and an author, so it can't hold those).
 */
export async function linkPullRequest(db: Db, pr: PullRequestInfo, now: Date = new Date()): Promise<LinkOutcome> {
  if (isIgnoredBase(pr.baseRef, pr.defaultBranch)) return { status: "ignored" };

  const known = await existingLink(db, pr.repoId, pr.number);
  if (known) {
    // An earlier event or a pasted link already linked it; a push only moves the head.
    if (pr.headSha && pr.headSha !== known.headSha) {
      await db.update(submissions).set({ headSha: pr.headSha, updatedAt: now }).where(eq(submissions.id, known.id));
    }
    return { status: "linked", taskId: known.taskId, submissionId: known.id };
  }

  const taskId = parseTaskLine(pr.body);
  const task = taskId === null ? null : await loadTaskView(db, taskId, now);
  const decision = decideLink({
    taskId,
    task: task && { id: task.id, repoId: task.repoId, status: task.status, holderHandle: task.holder?.handle ?? null },
    repoId: pr.repoId,
    authorHandle: pr.authorHandle,
  });

  if (!decision.linked || !task?.holder) {
    const reason = decision.linked ? "Nobody has taken on this task right now." : decision.reason;
    await writeAudit(db, {
      actorId: null,
      action: "pr.unlinked",
      target: prTarget(pr.repoFullName, pr.number),
      details: { reason, taskId, author: pr.authorHandle, draft: pr.draft },
    });
    return { status: "unlinked", reason };
  }

  const [row] = await db
    .insert(submissions)
    .values({
      taskId: task.id,
      prNumber: pr.number,
      headSha: pr.headSha,
      authorId: task.holder.userId,
      status: "checking",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: submissions.id });
  const submissionId = row?.id ?? (await existingLink(db, pr.repoId, pr.number))!.id;
  if (row) {
    await writeAudit(db, {
      actorId: task.holder.userId,
      action: "pr.linked",
      target: prTarget(pr.repoFullName, pr.number),
      details: { taskId: task.id, how: "task line", draft: pr.draft },
    });
  }
  return { status: "linked", taskId: task.id, submissionId };
}

/** Reads a pull_request webhook body and links it. Returns null for events that aren't about linking. */
export async function handlePullRequestEvent(
  db: Db,
  action: string | null,
  body: Record<string, unknown>,
  repo: { id: number; fullName: string; defaultBranch: string },
  now: Date = new Date(),
): Promise<LinkOutcome | null> {
  // `closed` (merges) and the rest belong to later tasks; here only the PR's life as an open PR matters.
  if (!action || !["opened", "reopened", "edited", "synchronize", "ready_for_review", "converted_to_draft"].includes(action)) {
    return null;
  }
  const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const pr = o(body.pull_request);
  const number = Number(pr.number);
  const login = o(pr.user).login;
  const baseRef = o(pr.base).ref;
  if (!Number.isSafeInteger(number) || typeof login !== "string" || typeof baseRef !== "string") return null;
  return linkPullRequest(
    db,
    {
      repoId: repo.id,
      repoFullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      number,
      baseRef,
      headSha: typeof o(pr.head).sha === "string" ? (o(pr.head).sha as string) : "",
      authorHandle: login,
      body: typeof pr.body === "string" ? pr.body : null,
      draft: pr.draft === true,
    },
    now,
  );
}

// ---------- the pasted link ----------

/**
 * The adopter or the task owner pastes a PR link on the task page. The site
 * can't read the PR here, so it trusts the paste: the PR is linked as the
 * current adopter's, and the worker fills in the head commit when it reads it.
 */
export async function linkPastedPr(
  db: Db,
  actorId: number,
  taskId: number,
  text: string,
  now: Date = new Date(),
): Promise<{ submissionId: number; prNumber: number }> {
  const actor = await getUser(db, actorId);
  if (actor.blocked) throw new PermissionError("Blocked people can't link PRs.");
  const task = await loadTaskView(db, taskId, now);
  if (!task) throw new PermissionError("That task doesn't exist.");
  const holder = task.holder;
  if (actor.id !== task.ownerId && actor.id !== holder?.userId) {
    throw new PermissionError("Only the person who took this on, or its owner, can link a PR.");
  }
  if (task.status === "merged" || task.status === "closed") throw new PermissionError("This task is already finished.");
  if (!holder) throw new PermissionError("Nobody has taken this task on, so there is no PR to link.");

  const parsed = parsePrUrl(text);
  if (!parsed) throw new PermissionError("Paste the PR's web address, like https://github.com/owner/repo/pull/12.");
  if (parsed.repo.toLowerCase() !== task.repoFullName.toLowerCase()) {
    throw new PermissionError(`That PR is in ${parsed.repo}, but this task is in ${task.repoFullName}.`);
  }
  const other = await existingLink(db, task.repoId, parsed.number, task.id);
  if (other) throw new PermissionError(`That PR is already linked to ${taskRef(other.taskId)}.`);

  const [row] = await db
    .insert(submissions)
    .values({ taskId: task.id, prNumber: parsed.number, headSha: "", authorId: holder.userId, status: "checking", createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: submissions.id });
  if (!row) throw new PermissionError("That PR is already linked to this task.");
  await writeAudit(db, {
    actorId: actor.id,
    action: "pr.linked",
    target: prTarget(task.repoFullName, parsed.number),
    details: { taskId: task.id, how: "pasted link" },
  });
  return { submissionId: row.id, prNumber: parsed.number };
}
