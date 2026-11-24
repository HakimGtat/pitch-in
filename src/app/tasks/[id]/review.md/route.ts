import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { taskRef } from "@/lib/prompt";
import { loadTaskView, openSubmissionFor } from "@/lib/views";
import { reviewFor } from "../review";

export const dynamic = "force-dynamic";

/** The Review in Claude prompt with the review packet, as a Markdown file. Only for the task owner. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user?.profile) return new Response("Sign in first.", { status: 401 });
  const { id } = await params;
  const db = getDb();
  const task = Number.isInteger(Number(id)) ? await loadTaskView(db, Number(id), new Date()) : null;
  if (!task) return new Response("No such task.", { status: 404 });
  if (task.ownerId !== user.id || user.blocked) return new Response("Only the task owner reviews its PRs.", { status: 403 });

  const submission = await openSubmissionFor(db, task.id);
  const ready = submission ? await reviewFor(db, task, submission.id) : null;
  if (!ready) return new Response("There's no PR ready for review on this task.", { status: 404 });
  return new Response(ready.review.prompt, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${taskRef(task.id)}-review.md"`,
    },
  });
}
