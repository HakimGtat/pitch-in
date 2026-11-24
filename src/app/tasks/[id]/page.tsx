import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  adoptMilestoneAction,
  adoptTaskAction,
  closeTaskAction,
  handBackAction,
  linkPrAction,
  releaseAction,
} from "@/app/work-actions";
import { CopyButton } from "@/components/copy-button";
import { LocalTime } from "@/components/local-time";
import { Badge, buttonClass, Card, dangerButtonClass, Notice, secondaryButtonClass } from "@/components/ui";
import { BriefView, Flash, KindBadge, TaskState, TierBadge } from "@/components/work";
import { canAdoptMilestone, canAdoptTask, nextTaskInMilestone, waitsItsTurn } from "@/lib/adoption-rules";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { milestones, projects, tasks } from "@/lib/db/schema";
import { timeLeft } from "@/lib/lock";
import { canCloseOrRelease } from "@/lib/permissions";
import { GUIDED_STEPS, taskRef } from "@/lib/prompt";
import { promptForTask } from "@/lib/start";
import { loadTaskView, loadTaskViews, openSubmissionFor, prStatusFor, type PrViewer } from "@/lib/views";
import { answerInClaude, openQuestionsFor } from "@/lib/questions";
import type { StoredChecks } from "@/lib/checks/run";
import { describeAlert, openAlertsForTask } from "@/lib/alerts";
import { PrPanel } from "./pr-panel";
import { QuestionCard } from "./question-card";
import { reviewFor } from "./review";

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { notice, error } = await searchParams;
  const now = new Date();
  const db = getDb();
  const task = Number.isInteger(Number(id)) ? await loadTaskView(db, Number(id), now) : null;
  if (!task) notFound();

  const [project] = task.projectId ? await db.select().from(projects).where(eq(projects.id, task.projectId)) : [];
  const [milestone] = task.milestoneId ? await db.select().from(milestones).where(eq(milestones.id, task.milestoneId)) : [];
  const milestoneTasks = milestone ? await loadTaskViews(db, eq(tasks.milestoneId, milestone.id), now) : undefined;
  const projectOpen = !project || project.status === "open";

  const adopt = canAdoptTask(user, task, { projectOpen, milestoneTasks });
  const adoptWhole =
    project && milestoneTasks ? canAdoptMilestone(user, { ownerId: project.ownerId, projectOpen, tasks: milestoneTasks }) : null;
  const mine = task.holder?.userId === user.id;
  const next = milestoneTasks ? nextTaskInMilestone(milestoneTasks) : null;
  // Inside a whole-milestone adoption, only the next task is started; the owner reviews it first.
  const startable = mine && (!next || next.id === task.id);
  const start = mine ? await promptForTask(db, task, now) : null;
  const ownerOrAdmin = canCloseOrRelease(user, task).ok;
  const finished = task.status === "merged" || task.status === "closed";
  const submission = finished ? null : await openSubmissionFor(db, task.id);
  const viewer: PrViewer =
    user.id === task.ownerId
      ? "owner"
      : mine || submission?.authorId === user.id
        ? "adopter"
        : ownerOrAdmin
          ? "admin"
          : "other";
  const review = submission && viewer === "owner" ? await reviewFor(db, task, submission.id) : null;
  const [question] = submission ? await openQuestionsFor(db, task.id) : [];
  const taskAlerts = await openAlertsForTask(db, task.id);
  const checks = submission?.checkResults as StoredChecks | null | undefined;
  const prUrl = question ? (checks?.pr.url ?? `https://github.com/${task.repoFullName}/pull/${question.prNumber}`) : "";
  const answer =
    question && viewer === "owner"
      ? answerInClaude({
          repoFullName: task.repoFullName,
          prUrl,
          headRef: checks?.pr.headRef ?? "the PR's branch",
          ref: taskRef(task.id),
          question: question.body,
          briefMd: task.task.briefMd,
        })
      : null;

  return (
    <div>
      <nav className="mb-3 text-sm text-stone-500">
        <Link href="/" className="hover:underline">
          Board
        </Link>
        {project ? (
          <>
            {" / "}
            <Link href={`/projects/${project.id}`} className="hover:underline">
              {project.title}
            </Link>
            {milestone ? ` / Milestone ${milestone.position}` : null}
          </>
        ) : null}
      </nav>
      <div className="mb-6">
        <p className="font-mono text-sm text-stone-500">{taskRef(task.id)}</p>
        <h1 className="text-2xl font-bold tracking-tight">{task.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-600">
          <TaskState task={task} waiting={waitsItsTurn(task, milestoneTasks)} viewerId={user.id} />
          <TierBadge tier={task.sizeTier} cap />
          <KindBadge kind={task.kind} />
          <span>
            in{" "}
            <a href={`https://github.com/${task.repoFullName}`} className="underline">
              {task.repoFullName}
            </a>{" "}
            · posted by @{task.ownerHandle}
          </span>
        </div>
      </div>
      <Flash notice={notice} error={error} />
      {taskAlerts.map((a) => (
        <Notice key={a.id} kind="error">
          Warning: {describeAlert(a)} An admin has been alerted.
        </Notice>
      ))}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {project ? (
            <Card>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Project</h2>
              <p className="mt-1 font-semibold">{project.title}</p>
              <p className="text-stone-600">{project.goal}</p>
              {milestone ? (
                <>
                  <p className="mt-3 font-semibold">
                    Milestone {milestone.position}: {milestone.title}
                  </p>
                  <p className="text-stone-600">{milestone.goal}</p>
                </>
              ) : null}
            </Card>
          ) : null}
          <Card>
            <h2 className="mb-1 text-lg font-semibold">Task Brief</h2>
            <BriefView brief={task.task.brief} kind={task.kind} sizeTier={task.sizeTier} allowedPaths={task.task.allowedPaths} />
          </Card>
        </div>

        <aside className="space-y-6">
          <Card>
            <h2 className="font-semibold">Take it on</h2>
            {task.holder ? (
              <p className="mt-2 text-sm text-stone-700">
                {mine ? "It's yours" : `@${task.holder.handle} took this on`} until <LocalTime value={task.holder.expiresAt} />{" "}
                ({timeLeft(task.holder.expiresAt, now)} left).
                {task.holder.milestoneId ? " Taken as part of the whole milestone." : ""}
              </p>
            ) : null}
            {adopt.ok ? (
              <>
                <p className="mt-2 text-sm text-stone-600">
                  Taking it on locks it for you for 48 hours. You can hand it back any time.
                </p>
                <form action={adoptTaskAction} className="mt-3">
                  <input type="hidden" name="taskId" value={task.id} />
                  <button className={`${buttonClass} w-full`}>Take this on</button>
                </form>
              </>
            ) : !mine ? (
              <p className="mt-2 text-sm text-stone-600">{adopt.reason}</p>
            ) : null}
            {adoptWhole?.ok && milestone ? (
              <form action={adoptMilestoneAction} className="mt-3">
                <input type="hidden" name="milestoneId" value={milestone.id} />
                <input type="hidden" name="back" value={`/tasks/${task.id}`} />
                <button className={`${secondaryButtonClass} w-full`}>
                  Take on the whole milestone ({adoptWhole.taskIds.length} {adoptWhole.taskIds.length === 1 ? "task" : "tasks"})
                </button>
              </form>
            ) : null}
          </Card>

          {mine && !startable && next ? (
            <Card>
              <h2 className="font-semibold">Start with task {next.position}</h2>
              <p className="mt-2 text-sm text-stone-600">
                This milestone goes in order, and the owner reviews each task before the next one starts.{" "}
                <Link href={`/tasks/${next.id}`} className="font-medium underline">
                  Open task {next.position}: {next.title}
                </Link>
              </p>
            </Card>
          ) : null}

          {question ? (
            <QuestionCard viewer={viewer} prNumber={question.prNumber} prUrl={prUrl} question={question.body} answer={answer} />
          ) : null}

          {submission ? (
            <PrPanel taskId={task.id} viewer={viewer} submission={submission} status={prStatusFor(viewer, submission)} review={review} />
          ) : null}

          {startable && start && !submission ? (
            <Card className="border-brand-100">
              <h2 className="font-semibold">Start the work</h2>
              {user.profile === "guided" ? (
                <>
                  <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-stone-700">
                    {GUIDED_STEPS.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  <a href={start.url} target="_blank" rel="noopener noreferrer" className={`${buttonClass} mt-4 w-full`}>
                    Start in Claude
                  </a>
                  {start.long ? (
                    <div className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                      <p>This task is long. If Claude opens with an empty message box, copy the task and paste it there.</p>
                      <div className="mt-2">
                        <CopyButton text={start.prompt} label="Copy the task" />
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="mt-2 text-sm text-stone-600">
                    Start in Claude opens Claude Code on the web with this repo and the brief filled in. Nothing runs until you press
                    Enter. For any other agent, copy the brief.
                  </p>
                  <a href={start.url} target="_blank" rel="noopener noreferrer" className={`${buttonClass} mt-4 w-full`}>
                    Start in Claude
                  </a>
                  {start.long ? (
                    <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                      This link is longer than any we&apos;ve tested ({start.url.length.toLocaleString("en-US")} characters). If Claude
                      opens without the task filled in, copy the brief and paste it into the session.
                    </p>
                  ) : null}
                  <div className="mt-2 flex gap-2">
                    <CopyButton text={start.prompt} label="Copy brief" />
                    <a href={`/tasks/${task.id}/brief.md`} className={secondaryButtonClass}>
                      Download .md
                    </a>
                  </div>
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-stone-600">What the agent gets</summary>
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-3 font-mono text-xs">
                      {start.prompt}
                    </pre>
                  </details>
                </>
              )}
            </Card>
          ) : null}

          {task.holder && (mine || user.id === task.ownerId) && !finished && !submission ? (
            <Card>
              <h2 className="font-semibold">Link a PR</h2>
              <p className="mt-2 text-sm text-stone-600">
                A PR whose description starts with <code>Task: {taskRef(task.id)}</code> links by itself. If it didn&apos;t, paste its
                address here.
              </p>
              <form action={linkPrAction} className="mt-3 space-y-2">
                <input type="hidden" name="taskId" value={task.id} />
                <input
                  name="prUrl"
                  required
                  placeholder="https://github.com/owner/repo/pull/12"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                />
                <button className={secondaryButtonClass}>Link PR</button>
              </form>
            </Card>
          ) : null}

          {mine && !submission ? (
            <Card>
              <h2 className="font-semibold">Hand it back</h2>
              <p className="mt-2 text-sm text-stone-600">
                {task.holder?.milestoneId
                  ? "Stops your work on this milestone. Its remaining tasks go back on the board for someone else."
                  : "It goes back on the board for someone else."}
              </p>
              <form action={handBackAction} className="mt-3">
                <input type="hidden" name="taskId" value={task.id} />
                <button className={secondaryButtonClass}>{task.holder?.milestoneId ? "Hand back the milestone" : "Hand back"}</button>
              </form>
            </Card>
          ) : null}

          {ownerOrAdmin && !finished ? (
            <Card>
              <h2 className="font-semibold">{user.id === task.ownerId ? "Your task" : "Admin"}</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {user.id === task.ownerId && task.status === "open" && !task.holder ? (
                  <Link href={`/tasks/${task.id}/edit`} className={secondaryButtonClass}>
                    Edit
                  </Link>
                ) : null}
                {task.holder && !mine ? (
                  <form action={releaseAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <button className={secondaryButtonClass}>Release @{task.holder.handle}</button>
                  </form>
                ) : null}
                <form action={closeTaskAction}>
                  <input type="hidden" name="taskId" value={task.id} />
                  <button className={dangerButtonClass}>Close task</button>
                </form>
              </div>
            </Card>
          ) : null}

          {task.developersOnly ? (
            <p className="text-sm text-stone-500">
              <Badge>For developers</Badge> After an earlier guided try, this task is marked for developers.
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
