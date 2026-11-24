import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addMilestoneAction,
  adoptMilestoneAction,
  closeProjectAction,
  markProjectDoneAction,
} from "@/app/work-actions";
import { Badge, buttonClass, Card, dangerButtonClass, inputClass, secondaryButtonClass } from "@/components/ui";
import { Flash, TaskRow } from "@/components/work";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { canCloseOrRelease } from "@/lib/permissions";
import { loadProjectView } from "@/lib/views";

const MILESTONE_LABEL = { open: "Open", in_progress: "In progress", done: "Done" } as const;

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { notice, error } = await searchParams;
  const project = Number.isInteger(Number(id)) ? await loadProjectView(getDb(), Number(id), user, new Date()) : null;
  if (!project) notFound();

  const isOwner = user.id === project.ownerId;
  const open = project.status === "open";
  const canClose = open && canCloseOrRelease(user, project).ok;

  return (
    <div>
      <nav className="mb-3 text-sm text-stone-500">
        <Link href="/" className="hover:underline">
          Board
        </Link>{" "}
        / Project
      </nav>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{project.title}</h1>
          {project.status !== "open" ? <Badge>{project.status === "done" ? "Done" : "Closed"}</Badge> : null}
        </div>
        <p className="mt-1 text-stone-600">{project.goal}</p>
        <p className="mt-2 text-sm text-stone-500">
          In{" "}
          <Link href={`/repos/${project.repo.id}`} className="underline">
            {project.repo.fullName}
          </Link>{" "}
          · by @{project.ownerHandle}
        </p>
      </div>
      <Flash notice={notice} error={error} />

      {project.milestones.map((m) => (
        <Card key={m.id} className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                Milestone {m.position}: {m.title}
              </h2>
              <p className="text-stone-600">{m.goal}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={m.derivedStatus === "done" ? "brand" : m.derivedStatus === "in_progress" ? "amber" : "neutral"}>
                {MILESTONE_LABEL[m.derivedStatus]}
              </Badge>
              {m.adoptWhole.ok ? (
                <form action={adoptMilestoneAction}>
                  <input type="hidden" name="milestoneId" value={m.id} />
                  <input type="hidden" name="back" value={`/projects/${project.id}`} />
                  <button className={secondaryButtonClass}>Take on the whole milestone</button>
                </form>
              ) : null}
            </div>
          </div>
          {m.tasks.length ? (
            <ul className="mt-3 divide-y divide-stone-100">
              {m.tasks.map((t) => (
                <TaskRow key={t.id} task={t} waiting={t.waiting} viewerId={user.id} />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-stone-500">No tasks yet.</p>
          )}
          {isOwner && open ? (
            <Link href={`/tasks/new?milestone=${m.id}`} className={`${secondaryButtonClass} mt-3`}>
              Add a task
            </Link>
          ) : null}
        </Card>
      ))}

      {isOwner && open ? (
        <Card className="mb-6">
          <h2 className="font-semibold">Add a milestone</h2>
          <form action={addMilestoneAction} className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <input type="hidden" name="projectId" value={project.id} />
            <input name="title" placeholder="Title" aria-label="Milestone title" className={inputClass} required />
            <input name="goal" placeholder="Goal" aria-label="Milestone goal" className={inputClass} required />
            <button className={buttonClass}>Add</button>
          </form>
        </Card>
      ) : null}

      {(isOwner && open) || canClose ? (
        <Card>
          <h2 className="font-semibold">{isOwner ? "Finish the project" : "Admin"}</h2>
          <div className="mt-3 flex flex-wrap items-start gap-6">
            {isOwner && open ? (
              <form action={markProjectDoneAction}>
                <input type="hidden" name="projectId" value={project.id} />
                <button className={secondaryButtonClass}>Mark project done</button>
                <p className="mt-1 max-w-xs text-xs text-stone-500">Closes any tasks nobody has done. Not while someone is working.</p>
              </form>
            ) : null}
            {canClose ? (
              <form action={closeProjectAction} className="space-y-2">
                <input type="hidden" name="projectId" value={project.id} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="confirm" value="yes" className="h-4 w-4 accent-brand-700" />
                  Close it and release anyone working on it
                </label>
                <button className={dangerButtonClass}>Close project</button>
              </form>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
