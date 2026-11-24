import { and, eq, inArray } from "drizzle-orm";
import { getUser, PermissionError } from "./admin";
import { releaseHolding, syncMilestoneStatus } from "./adoption";
import { writeAudit } from "./audit";
import { briefToMarkdown, checkText } from "./brief";
import type { Db } from "./db/client";
import { submissions, tasks } from "./db/schema";
import type { RepoGitHub } from "./github/repos";
import { canReopen } from "./permissions";
import { taskRef } from "./prompt";
import { answerQuestionsFor } from "./questions";
import { loadTaskView, OPEN_SUBMISSION } from "./views";

// Reopen (plan.md, "Review with the owner's agent"): for a PR that isn't worth
// fixing. The App closes the PR with the owner's short reason, the reason goes
// into the brief so the next person doesn't repeat it, and the task goes back
// on the board. The contributor isn't asked to do anything.

export const REASON_MAX = 300;

/** One plain line, so it reads cleanly in the brief and the next person's prompt. */
export function cleanReason(text: unknown): string {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const NOTE_PREFIX = "Note from an earlier try:";

export function reopenComment(reason: string): string {
  return [
    `The owner reopened this task on Pitch In instead of merging this PR: ${reason}`,
    "",
    "The task is back on the board with that note in its brief, for whoever takes it on next. Nothing more is needed from you here. Thanks for taking it on.",
  ].join("\n");
}

export async function reopenTask(
  db: Db,
  gh: RepoGitHub,
  actorId: number,
  taskId: number,
  input: { reason: string; developersOnly: boolean },
  now: Date = new Date(),
): Promise<{ reopened: number[]; closedPrs: number[] }> {
  const actor = await getUser(db, actorId);
  const task = await loadTaskView(db, taskId, now);
  if (!task) throw new PermissionError("That task doesn't exist.");
  if (task.status === "merged" || task.status === "closed") throw new PermissionError("This task is already finished.");
  const access = { permission: await gh.permission(task.repoFullName, actor.handle) };
  const decision = canReopen(actor, task, access);
  if (!decision.ok) throw new PermissionError(decision.reason);

  const reason = cleanReason(input.reason);
  if (!reason) throw new PermissionError("Give a short reason. It goes into the brief for the next person.");
  if (reason.length > REASON_MAX) throw new PermissionError(`Keep the reason under ${REASON_MAX} characters.`);
  const problems = checkText(reason, task.repoFullName);
  if (problems.length) throw new PermissionError(problems[0]);

  const open = await db
    .select()
    .from(submissions)
    .where(and(eq(submissions.taskId, task.id), inArray(submissions.status, [...OPEN_SUBMISSION])));
  // GitHub first: if it can't close the PR, nothing changes here.
  for (const s of open) await gh.closePullRequest(task.repoFullName, s.prNumber, reopenComment(reason));

  return db.transaction(async (tx) => {
    if (open.length) {
      await tx
        .update(submissions)
        .set({ status: "closed", updatedAt: now })
        .where(inArray(submissions.id, open.map((s) => s.id)));
      await answerQuestionsFor(tx, open.map((s) => s.id), now);
    }
    const brief = { ...task.task.brief };
    brief.constraints = [brief.constraints.trim(), `${NOTE_PREFIX} ${reason}`].filter(Boolean).join(" ");
    const briefMd = briefToMarkdown({
      title: task.task.title,
      kind: task.task.kind,
      sizeTier: task.task.sizeTier,
      allowedPaths: task.task.allowedPaths,
      brief,
    });
    const released = await releaseHolding(tx, task.id, now);
    await tx
      .update(tasks)
      .set({
        brief,
        briefMd,
        status: "open",
        ...(input.developersOnly ? { developersOnly: true } : {}),
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));
    await syncMilestoneStatus(tx, task.milestoneId, now);
    await writeAudit(tx, {
      actorId: actor.id,
      action: "task.reopened",
      target: taskRef(task.id),
      details: {
        reason,
        developersOnly: input.developersOnly,
        closedPrs: open.map((s) => s.prNumber),
        reopened: released.map(taskRef),
        holder: task.holder?.handle ?? null,
      },
    });
    const reopened = released.includes(task.id) ? released : [task.id, ...released];
    return { reopened, closedPrs: open.map((s) => s.prNumber) };
  });
}
