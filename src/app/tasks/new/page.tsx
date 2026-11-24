import { eq } from "drizzle-orm";
import Link from "next/link";
import { postTaskAction } from "@/app/work-actions";
import { TaskForm } from "@/components/task-form";
import { Card, Notice, PageTitle } from "@/components/ui";
import { requireUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { milestones, projects, repos } from "@/lib/db/schema";
import { blankTaskValues } from "@/lib/forms";
import { createRepoGitHub } from "@/lib/github/app";
import { reposWithWriteAccess } from "@/lib/repos";

export default async function NewTask({ searchParams }: { searchParams: Promise<{ repo?: string; milestone?: string }> }) {
  const user = await requireUser();
  const search = await searchParams;
  const db = getDb();
  const milestoneId = Number(search.milestone) || null;

  // Adding a task to a project's milestone: the repo comes from the project.
  if (milestoneId) {
    const [row] = await db
      .select({ milestone: milestones, project: projects, repo: repos })
      .from(milestones)
      .innerJoin(projects, eq(milestones.projectId, projects.id))
      .innerJoin(repos, eq(projects.repoId, repos.id))
      .where(eq(milestones.id, milestoneId));
    if (!row) return <Notice kind="error">That milestone doesn&apos;t exist.</Notice>;
    return (
      <div className="mx-auto max-w-3xl">
        <nav className="mb-3 text-sm text-stone-500">
          <Link href={`/projects/${row.project.id}`} className="hover:underline">
            {row.project.title}
          </Link>{" "}
          / Milestone {row.milestone.position}
        </nav>
        <PageTitle
          title={`Add a task to milestone ${row.milestone.position}`}
          intro={
            <>
              {row.milestone.title}: {row.milestone.goal} Tasks are taken in the order you add them.
            </>
          }
        />
        <Card>
          <TaskForm
            action={postTaskAction}
            initial={blankTaskValues()}
            hidden={{ milestoneId: row.milestone.id }}
            repos={[{ id: row.repo.id, fullName: row.repo.fullName, largestTier: row.repo.settings.largestTier }]}
            fixedRepoId={row.repo.id}
            submitLabel="Check and add task"
          />
        </Card>
      </div>
    );
  }

  let writable: Awaited<ReturnType<typeof reposWithWriteAccess>> = [];
  let trouble: string | null = null;
  try {
    writable = await reposWithWriteAccess(db, createRepoGitHub(getConfig()), user.handle);
  } catch (err) {
    console.error("[tasks/new]", err);
    trouble = "Pitch In couldn't check your repo access on GitHub just now. Try again in a minute.";
  }
  const preselect = writable.find((r) => r.id === Number(search.repo))?.id;

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle
        title="Post a task"
        intro={
          <>
            One task, one PR. Write the brief so an agent with no prior knowledge of the repo can finish it in one pass. Bigger work?{" "}
            <Link href="/projects/new" className="underline">
              Post a project with milestones
            </Link>
            .
          </>
        }
      />
      {trouble ? <Notice kind="error">{trouble}</Notice> : null}
      {!trouble && writable.length === 0 ? (
        <Card>
          <p className="font-semibold">You don&apos;t have write access to any connected repo.</p>
          <p className="mt-2 text-stone-600">
            Posting work needs write access to the repo on GitHub. Ask the repo&apos;s admin for access, or{" "}
            <Link href="/repos" className="underline">
              connect a repo
            </Link>{" "}
            you admin.
          </p>
        </Card>
      ) : writable.length ? (
        <Card>
          <TaskForm
            action={postTaskAction}
            initial={blankTaskValues()}
            repos={writable.map((r) => ({ id: r.id, fullName: r.fullName, largestTier: r.settings.largestTier }))}
            initialRepoId={preselect}
            submitLabel="Check and post"
          />
        </Card>
      ) : null}
    </div>
  );
}
