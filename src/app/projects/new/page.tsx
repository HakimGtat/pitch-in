import Link from "next/link";
import { createProjectAction } from "@/app/work-actions";
import { ProjectForm } from "@/components/project-form";
import { Card, Notice, PageTitle } from "@/components/ui";
import { requireUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { createRepoGitHub } from "@/lib/github/app";
import { reposWithWriteAccess } from "@/lib/repos";

export default async function NewProject({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  const user = await requireUser();
  const { repo } = await searchParams;
  let writable: Awaited<ReturnType<typeof reposWithWriteAccess>> = [];
  let trouble: string | null = null;
  try {
    writable = await reposWithWriteAccess(getDb(), createRepoGitHub(getConfig()), user.handle);
  } catch (err) {
    console.error("[projects/new]", err);
    trouble = "Pitch In couldn't check your repo access on GitHub just now. Try again in a minute.";
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle
        title="Post a project"
        intro="For work bigger than one Large task: a project with ordered milestones, each split into tasks. Every task still ends in one PR you review."
      />
      {trouble ? <Notice kind="error">{trouble}</Notice> : null}
      {!trouble && writable.length === 0 ? (
        <Card>
          <p className="font-semibold">You don&apos;t have write access to any connected repo.</p>
          <p className="mt-2 text-stone-600">
            Posting work needs write access to the repo on GitHub.{" "}
            <Link href="/repos" className="underline">
              See connected repos
            </Link>
            .
          </p>
        </Card>
      ) : writable.length ? (
        <Card>
          <ProjectForm
            action={createProjectAction}
            repos={writable.map((r) => ({ id: r.id, fullName: r.fullName }))}
            initialRepoId={writable.find((r) => r.id === Number(repo))?.id ?? null}
          />
        </Card>
      ) : null}
    </div>
  );
}
