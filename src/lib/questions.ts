import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { writeAudit } from "./audit";
import type { Db } from "./db/client";
import { questions, repos, submissions, tasks, type Question } from "./db/schema";
import { isLongLink, startInClaudeUrl, taskRef } from "./prompt";
import { loadTaskView, OPEN_SUBMISSION } from "./views";

// Questions for the owner (plan.md, "Questions for the owner"). When a wrong
// guess would waste the run, the contributor's agent opens a draft PR with a
// comment starting "Question for owner:" and ends its run. The site picks the
// comment up from the issue_comment webhook and flags the task as waiting on
// the owner. The owner settles it by finishing the work on the PR or by
// reopening the task with the answer in its brief; either way the PR closes
// and the question counts as answered. Nothing here posts to GitHub, and
// nothing asks the contributor to come back.

export const QUESTION_PREFIX = /^\s*\**\s*Question for owner\s*:/i;

export const isQuestion = (body: string | null | undefined) => QUESTION_PREFIX.test(body ?? "");

export type AskOutcome =
  | { status: "asked"; questionId: number; taskId: number }
  | { status: "ignored"; why: string };

export async function recordQuestion(
  db: Db,
  input: { repoId: number; prNumber: number; commentId: number; body: string; commenter: string },
  now: Date = new Date(),
): Promise<AskOutcome> {
  if (!isQuestion(input.body)) return { status: "ignored", why: "the comment isn't a question for the owner" };
  const [row] = await db
    .select({ submission: submissions })
    .from(submissions)
    .innerJoin(tasks, eq(submissions.taskId, tasks.id))
    .where(
      and(
        eq(tasks.repoId, input.repoId),
        eq(submissions.prNumber, input.prNumber),
        inArray(submissions.status, [...OPEN_SUBMISSION]),
      ),
    );
  if (!row) return { status: "ignored", why: "the PR isn't linked to an open task" };
  const task = await loadTaskView(db, row.submission.taskId, now);
  if (!task) return { status: "ignored", why: "the task is gone" };
  const adopter = task.holder?.handle ?? null;
  if (!adopter || adopter.toLowerCase() !== input.commenter.toLowerCase()) {
    return { status: "ignored", why: `@${input.commenter} isn't the person who took on ${taskRef(task.id)}` };
  }

  const [q] = await db
    .insert(questions)
    .values({
      submissionId: row.submission.id,
      githubCommentId: input.commentId,
      body: input.body.trim().slice(0, 4000),
      askedAt: now,
    })
    .onConflictDoNothing({ target: questions.githubCommentId })
    .returning({ id: questions.id });
  if (!q) return { status: "ignored", why: "already recorded" };
  await writeAudit(db, {
    actorId: task.holder!.userId,
    action: "question.asked",
    target: taskRef(task.id),
    details: { pr: input.prNumber, commentId: input.commentId },
  });
  return { status: "asked", questionId: q.id, taskId: task.id };
}

/** Marks the questions on these submissions answered: their PR closed, or the task was reopened. */
export async function answerQuestionsFor(db: Db, submissionIds: number[], now: Date): Promise<number> {
  if (submissionIds.length === 0) return 0;
  const rows = await db
    .update(questions)
    .set({ answeredAt: now })
    .where(and(inArray(questions.submissionId, submissionIds), isNull(questions.answeredAt)))
    .returning({ id: questions.id });
  return rows.length;
}

/** Unanswered questions on a task's PRs, oldest first. */
export async function openQuestionsFor(db: Db, taskId: number): Promise<(Question & { prNumber: number })[]> {
  const rows = await db
    .select({ question: questions, prNumber: submissions.prNumber })
    .from(questions)
    .innerJoin(submissions, eq(questions.submissionId, submissions.id))
    .where(and(eq(submissions.taskId, taskId), isNull(questions.answeredAt)))
    .orderBy(asc(questions.askedAt));
  return rows.map((r) => ({ ...r.question, prNumber: r.prNumber }));
}

export type WaitingItem = { taskId: number; title: string; prNumber: number; repoFullName: string; question: string };

/** The owner's tasks waiting on them: an open question on one of their PRs. */
export async function loadWaitingOnOwner(db: Db, ownerId: number): Promise<WaitingItem[]> {
  const rows = await db
    .select({ question: questions, prNumber: submissions.prNumber, task: tasks, repoFullName: repos.fullName })
    .from(questions)
    .innerJoin(submissions, eq(questions.submissionId, submissions.id))
    .innerJoin(tasks, eq(submissions.taskId, tasks.id))
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(and(eq(tasks.ownerId, ownerId), isNull(questions.answeredAt), isNull(repos.removedAt)))
    .orderBy(asc(questions.askedAt));
  return rows.map((r) => ({
    taskId: r.task.id,
    title: r.task.title,
    prNumber: r.prNumber,
    repoFullName: r.repoFullName,
    question: r.question.body,
  }));
}

/**
 * Answer in Claude: the owner's own session with the question, the brief and
 * the draft PR. The owner settles it by finishing the work on the PR, or by
 * reopening the task with the answer in its brief. The contributor is never
 * asked to come back.
 */
export function buildAnswerPrompt(input: {
  repoFullName: string;
  prUrl: string;
  headRef: string;
  ref: string;
  question: string;
  briefMd: string;
}): string {
  return [
    `A coworker's agent working on ${input.ref} in ${input.repoFullName} stopped and left you a question on its draft PR: ${input.prUrl}. Its run has ended, so nobody is waiting for a reply.`,
    `The question, as it wrote it:\n\n${input.question.trim()}`,
    [
      "Help me settle it in one of two ways:",
      `- Finish the work: if the answer is clear and the rest is small, do it yourself in this session on the PR's branch (${input.headRef}) if this session can push to it, otherwise as a small PR into that branch. Then mark the PR Ready for review and I'll merge it.`,
      "- Reopen: if it needs a fresh run, write the answer as one short line for the task's brief. I'll reopen the task on Pitch In with it, and the next person who takes it on gets it in their prompt.",
      "Don't ask the contributor to do anything, and keep it cheap: read the brief and the PR's own files only.",
    ].join("\n"),
    `The task's brief:\n\n${input.briefMd.trim()}`,
  ].join("\n\n") + "\n";
}

export function answerInClaude(input: Parameters<typeof buildAnswerPrompt>[0]): { prompt: string; url: string; long: boolean } {
  const prompt = buildAnswerPrompt(input);
  const url = startInClaudeUrl(prompt, input.repoFullName);
  return { prompt, url, long: isLongLink(url) };
}

