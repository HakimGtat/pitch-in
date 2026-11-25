import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getUser, PermissionError } from "./admin";
import { writeAudit } from "./audit";
import type { Db } from "./db/client";
import { adoptions, auditLog, submissions, tasks, users } from "./db/schema";
import { renewLock } from "./merge";
import { parseTaskLine } from "./checks/pr-body";
import { queueChecks } from "./checks/run";
import { taskRef } from "./prompt";
import { loadTaskView, OPEN_SUBMISSION, type FullTaskView } from "./views";

export { parseTaskLine };

// PR linking (plan.md, "PR linking"). A PR links to a task through a
// `Task: <id>` first line in its body, or through a link the adopter or the
// task owner pastes on the task page. Only the current adopter's PR links.
// Draft PRs link too. PRs that don't target the default branch are ignored.

// ---------- pure rules ----------

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
    .select({
      id: submissions.id,
      taskId: submissions.taskId,
      headSha: submissions.headSha,
      status: submissions.status,
      authorId: submissions.authorId,
    })
    .from(submissions)
    .innerJoin(tasks, eq(submissions.taskId, tasks.id))
    .where(exceptTaskId === undefined ? where : and(where, ne(submissions.taskId, exceptTaskId)))
    .orderBy(desc(submissions.id))
    .limit(1);
  return row ?? null;
}

const OPEN = new Set<string>(OPEN_SUBMISSION);

/** A PR by the task's own owner. */
const isOwnPr = (task: FullTaskView, authorHandle: string) => task.ownerHandle.toLowerCase() === authorHandle.toLowerCase();

/** Who an adoption row belongs to (used for one whose 48 hours ran out with nobody else taking the task). */
async function adopterOf(db: Db, adoptionId: number): Promise<{ userId: number; handle: string } | null> {
  const [row] = await db
    .select({ userId: adoptions.userId, handle: users.handle })
    .from(adoptions)
    .innerJoin(users, eq(adoptions.userId, users.id))
    .where(and(eq(adoptions.id, adoptionId), eq(adoptions.status, "active")));
  return row ?? null;
}

/** The task's other open PR, if it has one: one task, one PR. */
async function otherOpenPr(db: Db, taskId: number, prNumber: number): Promise<number | null> {
  const [row] = await db
    .select({ prNumber: submissions.prNumber })
    .from(submissions)
    .where(
      and(eq(submissions.taskId, taskId), inArray(submissions.status, [...OPEN_SUBMISSION]), ne(submissions.prNumber, prNumber)),
    );
  return row?.prNumber ?? null;
}

/** Records why a PR didn't link, once per reason: pushes and edits repeat the event. */
async function noteUnlinked(db: Db, pr: PullRequestInfo, reason: string, taskId: number | null): Promise<LinkOutcome> {
  const [last] = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, "pr.unlinked"), eq(auditLog.target, prTarget(pr.repoFullName, pr.number))))
    .orderBy(desc(auditLog.id))
    .limit(1);
  if ((last?.details as { reason?: string } | null)?.reason !== reason) {
    await writeAudit(db, {
      actorId: null,
      action: "pr.unlinked",
      target: prTarget(pr.repoFullName, pr.number),
      details: { reason, taskId, author: pr.authorHandle, draft: pr.draft },
    });
  }
  return { status: "unlinked", reason };
}

/** The PR stopped being the task's PR (closed, gone, or retargeted): the task waits for another. */
export async function detachSubmission(db: Db, submissionId: number, taskId: number, now: Date, why: string): Promise<void> {
  await db.update(submissions).set({ status: "closed", updatedAt: now }).where(eq(submissions.id, submissionId));
  await db
    .update(tasks)
    .set({ status: "adopted", updatedAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "in_review")));
  await writeAudit(db, { actorId: null, action: "pr.detached", target: taskRef(taskId), details: { submissionId, why } });
}

const oneTaskOnePr = (taskId: number, other: number) => `${taskRef(taskId)} already has an open PR (#${other}). One task, one PR.`;

/**
 * Links a PR from the pull_request webhook. Linked PRs get a submissions row.
 * Anything else is written to the audit log as `pr.unlinked` with its reason
 * (the submissions table needs a task and an author, so it can't hold those).
 */
export async function linkPullRequest(db: Db, pr: PullRequestInfo, now: Date = new Date()): Promise<LinkOutcome> {
  const known = await existingLink(db, pr.repoId, pr.number);

  if (isIgnoredBase(pr.baseRef, pr.defaultBranch)) {
    // Retargeted away from the default branch: it isn't the task's PR any more.
    if (known && OPEN.has(known.status)) await detachSubmission(db, known.id, known.taskId, now, `retargeted to ${pr.baseRef}`);
    return { status: "ignored" };
  }

  if (known) {
    const linked = { status: "linked" as const, taskId: known.taskId, submissionId: known.id };
    if (known.status === "merged") return linked;
    if (OPEN.has(known.status)) {
      if (pr.headSha && pr.headSha !== known.headSha) {
        // A new push: the old results no longer describe the PR, so it isn't ready for review until it's checked again.
        await db.update(submissions).set({ headSha: pr.headSha, status: "checking", updatedAt: now }).where(eq(submissions.id, known.id));
        await db
          .update(tasks)
          .set({ status: "adopted", updatedAt: now })
          .where(and(eq(tasks.id, known.taskId), eq(tasks.status, "in_review")));
      }
      return linked;
    }
    // Closed earlier and open again: it's the task's PR again if the same person still holds the task.
    const held = await loadTaskView(db, known.taskId, now);
    const finished = !held || held.status === "merged" || held.status === "closed";
    // ...or it's the owner's own PR and still nobody holds the task.
    const ownerAgain = held && !held.holder && known.authorId === held.ownerId;
    if (held && !finished && (held.holder?.userId === known.authorId || ownerAgain)) {
      const other = await otherOpenPr(db, held.id, pr.number);
      if (other !== null) return noteUnlinked(db, pr, oneTaskOnePr(held.id, other), held.id);
      await db
        .update(submissions)
        .set({ status: "checking", headSha: pr.headSha || known.headSha, updatedAt: now })
        .where(eq(submissions.id, known.id));
      await writeAudit(db, {
        actorId: null,
        action: "pr.relinked",
        target: prTarget(pr.repoFullName, pr.number),
        details: { taskId: held.id },
      });
      return linked;
    }
    return noteUnlinked(db, pr, `${taskRef(known.taskId)} has moved on since this PR was closed (it was reopened or finished).`, known.taskId);
  }

  const taskId = parseTaskLine(pr.body);
  let task = taskId === null ? null : await loadTaskView(db, taskId, now);
  // A run that started before the 48 hours ran out can open its PR after: nobody else took the task, so it's still theirs.
  if (task && !task.holder && task.adoptionId && task.status !== "merged" && task.status !== "closed") {
    const lapsed = await adopterOf(db, task.adoptionId);
    if (lapsed && lapsed.handle.toLowerCase() === pr.authorHandle.toLowerCase()) {
      await renewLock(db, task.id, now);
      task = await loadTaskView(db, task.id, now);
    }
  }
  const decision = decideLink({
    taskId,
    task: task && { id: task.id, repoId: task.repoId, status: task.status, holderHandle: task.holder?.handle ?? null },
    repoId: pr.repoId,
    authorHandle: pr.authorHandle,
  });

  // The owner doing their own task (nobody holds it): it links as owner-done, with no "helped ship" credit.
  const ownerDone = Boolean(task && !task.holder && isOwnPr(task, pr.authorHandle));
  if (!task || (!ownerDone && (!decision.linked || !task.holder))) {
    return noteUnlinked(db, pr, decision.linked ? "Nobody has taken on this task right now." : decision.reason, taskId);
  }
  const other = await otherOpenPr(db, task.id, pr.number);
  if (other !== null) return noteUnlinked(db, pr, oneTaskOnePr(task.id, other), task.id);
  const authorId = ownerDone ? task.ownerId : task.holder!.userId;
  if (ownerDone && task.adoptionId) {
    // A hold that ran out with nobody else taking the task: it ends here, so it can't come back with the owner's PR.
    await db.update(adoptions).set({ status: "expired", endedAt: now }).where(eq(adoptions.id, task.adoptionId));
  }

  const [row] = await db
    .insert(submissions)
    .values({
      taskId: task.id,
      prNumber: pr.number,
      headSha: pr.headSha,
      authorId,
      status: "checking",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: submissions.id });
  const submissionId = row?.id ?? (await existingLink(db, pr.repoId, pr.number))!.id;
  if (row) {
    await writeAudit(db, {
      actorId: authorId,
      action: "pr.linked",
      target: prTarget(pr.repoFullName, pr.number),
      details: { taskId: task.id, how: ownerDone ? "owner's own PR" : "task line", draft: pr.draft },
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
  // The person whose 48 hours ran out without anyone else taking the task still counts: their PR may have opened late.
  const lapsed = !task.holder && task.adoptionId ? await adopterOf(db, task.adoptionId) : null;
  if (actor.id !== task.ownerId && actor.id !== task.holder?.userId && actor.id !== lapsed?.userId) {
    throw new PermissionError("Only the person who took this on, or its owner, can link a PR.");
  }
  if (task.status === "merged" || task.status === "closed") throw new PermissionError("This task is already finished.");
  // Nobody holds it: only the owner's own work can be linked, as owner-done.
  if (!task.holder && !lapsed && actor.id !== task.ownerId) {
    throw new PermissionError("Nobody has taken this task on, so there is no PR to link.");
  }
  const holder = task.holder ?? (lapsed ? { userId: lapsed.userId } : { userId: task.ownerId });

  const parsed = parsePrUrl(text);
  if (!parsed) throw new PermissionError("Paste the PR's web address, like https://github.com/owner/repo/pull/12.");
  if (parsed.repo.toLowerCase() !== task.repoFullName.toLowerCase()) {
    throw new PermissionError(`That PR is in ${parsed.repo}, but this task is in ${task.repoFullName}.`);
  }
  const other = await existingLink(db, task.repoId, parsed.number, task.id);
  if (other && other.status !== "closed") throw new PermissionError(`That PR is already linked to ${taskRef(other.taskId)}.`);
  const open = await otherOpenPr(db, task.id, parsed.number);
  if (open !== null) throw new PermissionError(`This task already has an open PR (#${open}). One task, one PR.`);

  const [mine] = await db
    .select({ id: submissions.id, status: submissions.status })
    .from(submissions)
    .where(and(eq(submissions.taskId, task.id), eq(submissions.prNumber, parsed.number)));
  if (mine && mine.status !== "closed") throw new PermissionError("That PR is already linked to this task.");
  // A PR linked before and closed since comes back as this task's PR; the worker checks it's really open.
  const [row] = mine
    ? await db
        .update(submissions)
        .set({ status: "checking", authorId: holder.userId, updatedAt: now })
        .where(eq(submissions.id, mine.id))
        .returning({ id: submissions.id })
    : await db
        .insert(submissions)
        .values({ taskId: task.id, prNumber: parsed.number, headSha: "", authorId: holder.userId, status: "checking", createdAt: now, updatedAt: now })
        .returning({ id: submissions.id });
  if (lapsed) await renewLock(db, task.id, now);
  await writeAudit(db, {
    actorId: actor.id,
    action: "pr.linked",
    target: prTarget(task.repoFullName, parsed.number),
    details: { taskId: task.id, how: "pasted link" },
  });
  // Check it now rather than waiting for GitHub's next event on the PR. The job reads the PR fresh.
  await queueChecks(db, { repoId: task.repoId, prNumber: parsed.number }, `pasted-${row.id}`, now);
  return { submissionId: row.id, prNumber: parsed.number };
}
