import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { taskRef } from "@/lib/prompt";
import { promptForTask } from "@/lib/start";
import { loadTaskView } from "@/lib/views";

export const dynamic = "force-dynamic";

/** The same text as Copy brief, as a Markdown file for any other agent. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user?.profile) return new Response("Sign in first.", { status: 401 });
  const { id } = await params;
  const now = new Date();
  const db = getDb();
  const task = Number.isInteger(Number(id)) ? await loadTaskView(db, Number(id), now) : null;
  if (!task) return new Response("No such task.", { status: 404 });
  if (task.holder?.userId !== user.id) return new Response("Take this task on first.", { status: 403 });

  const { prompt } = await promptForTask(db, task, now);
  return new Response(prompt, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${taskRef(task.id)}.md"`,
    },
  });
}
