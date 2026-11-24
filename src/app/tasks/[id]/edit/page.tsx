import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { editTaskAction } from "@/app/work-actions";
import { TaskForm } from "@/components/task-form";
import { Card, Notice, PageTitle } from "@/components/ui";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { valuesFromTask } from "@/lib/forms";
import { taskRef } from "@/lib/prompt";
import { loadTaskView } from "@/lib/views";

export default async function EditTask({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = getDb();
  const task = Number.isInteger(Number(id)) ? await loadTaskView(db, Number(id), new Date()) : null;
  if (!task) notFound();
  const [repo] = await db.select().from(repos).where(eq(repos.id, task.repoId));

  const editable = user.id === task.ownerId && task.status === "open" && !task.holder;
  return (
    <div className="mx-auto max-w-3xl">
      <nav className="mb-3 text-sm text-stone-500">
        <Link href={`/tasks/${task.id}`} className="hover:underline">
          {taskRef(task.id)}
        </Link>
      </nav>
      <PageTitle title={`Edit ${taskRef(task.id)}`} intro="The brief checker runs again when you save." />
      {editable ? (
        <Card>
          <TaskForm
            action={editTaskAction}
            initial={valuesFromTask(task.task)}
            hidden={{ taskId: task.id }}
            repos={[{ id: repo.id, fullName: repo.fullName, largestTier: repo.settings.largestTier }]}
            fixedRepoId={repo.id}
            submitLabel="Check and save"
          />
        </Card>
      ) : (
        <Notice kind="error">Only the owner can edit a task, and only while it&apos;s open and nobody has taken it on.</Notice>
      )}
    </div>
  );
}
