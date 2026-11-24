import { eq } from "drizzle-orm";
import type { StoredChecks } from "@/lib/checks/run";
import type { Db } from "@/lib/db/client";
import { submissions } from "@/lib/db/schema";
import { taskRef } from "@/lib/prompt";
import { buildReviewPacket, packetReady } from "@/lib/review-packet";
import { reviewInClaude } from "@/lib/review-prompt";
import type { FullTaskView } from "@/lib/views";

/** The review packet and Review in Claude for a task's PR, once all seven checks passed. Null otherwise. */
export async function reviewFor(db: Db, task: FullTaskView, submissionId: number) {
  const [submission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
  const checks = submission?.checkResults as StoredChecks | null;
  if (!submission || submission.status !== "in_review" || !packetReady(checks)) return null;
  const packet = buildReviewPacket({
    ref: taskRef(task.id),
    title: task.title,
    kind: task.kind,
    output: task.task.brief.output,
    repoFullName: task.repoFullName,
    prNumber: submission.prNumber,
    checks,
  });
  const review = reviewInClaude({
    prUrl: checks.pr.url,
    repoFullName: task.repoFullName,
    ref: taskRef(task.id),
    title: task.title,
    headRef: checks.pr.headRef,
    draft: checks.pr.draft,
    acceptance: task.task.brief.acceptance,
    packet,
  });
  return { packet, review, draft: checks.pr.draft };
}
