import Link from "next/link";
import { redirect } from "next/navigation";
import { adoptMilestoneAction } from "@/app/work-actions";
import { LocalTime } from "@/components/local-time";
import { buttonClass, Card, Notice, PageTitle, secondaryButtonClass } from "@/components/ui";
import { Flash, OwnerQueue, TaskRow } from "@/components/work";
import { getCurrentUser } from "@/lib/auth/current-user";
import { filterBoard } from "@/lib/board-rules";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { taskRef } from "@/lib/prompt";
import { offersWholeMilestones, parseTakeOn, TAKE_ON, TAKE_ON_LABEL, TAKE_ON_SHOWS } from "@/lib/sizing";
import { loadWaitingOnOwner } from "@/lib/questions";
import { loadBoard, loadHeldBy, loadOwnerQueue } from "@/lib/views";

const signInErrors: Record<string, (team: string, org: string) => string> = {
  not_in_team: (team, org) =>
    `Pitch In is only open to the ${team} team in ${org} on GitHub. Ask an admin to add you, then sign in again.`,
  invite_pending: (team) =>
    `You've been invited to the ${team} team, but haven't accepted yet. Accept the invite on GitHub, then sign in again.`,
  blocked: () => "An admin has turned off your Pitch In access. Talk to them if you think that's a mistake.",
  app_not_installed: (_team, org) =>
    `The Pitch In GitHub App isn't installed on ${org} yet, so sign-in can't check your team. An admin needs to finish setup.`,
  github_error: () => "Pitch In couldn't check your team on GitHub just now. Try again in a minute.",
  cancelled: () => "Sign-in was cancelled on GitHub.",
  expired: () => "That sign-in link expired. Start again.",
};

type Search = { error?: string; notice?: string; take?: string };

function Landing({ message }: { message?: string }) {
  const config = getConfig();
  return (
    <div className="mx-auto max-w-xl pt-6">
      {message ? <Notice kind="error">{message}</Notice> : null}
      <Card className="p-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Pitch In</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Pick up part of a coworker&apos;s project.</h1>
        <p className="mt-4 text-stone-600">
          Coworkers post the projects they&apos;re building with AI: websites, games, apps, research, automation. You take on as
          much as you want, run it in your own Claude session, and the owner reviews the pull request.
        </p>
        {config.githubApp ? (
          <>
            <a href="/api/auth/github" className={`${buttonClass} mt-8 w-full py-3 text-base`}>
              Sign in with GitHub
            </a>
            <p className="mt-3 text-center text-sm text-stone-500">
              For members of the {config.signInTeam} team in {config.org}.
            </p>
          </>
        ) : (
          <Notice kind="info">
            <span className="block pt-0.5">
              Pitch In isn&apos;t connected to GitHub yet. An admin needs to{" "}
              <Link href="/setup" className="font-semibold underline">
                finish setup
              </Link>
              .
            </span>
          </Notice>
        )}
      </Card>
    </div>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await getCurrentUser();
  const search = await searchParams;
  if (!user) {
    const config = getConfig();
    return <Landing message={search.error ? signInErrors[search.error]?.(config.signInTeam, config.org) : undefined} />;
  }
  if (!user.profile) redirect("/welcome");

  const now = new Date();
  const db = getDb();
  const takeOn = parseTakeOn(search.take) ?? user.takeOn;
  const [board, mine, queue, waiting] = await Promise.all([
    loadBoard(db, user, now),
    loadHeldBy(db, user.id, now),
    loadOwnerQueue(db, user.id),
    loadWaitingOnOwner(db, user.id),
  ]);
  const view = filterBoard(board, takeOn);
  const wholeMilestones = offersWholeMilestones(takeOn);
  const empty = view.projects.length === 0 && view.singles.length === 0;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <PageTitle title="Board" intro="Pick up part of a coworker's project. Everything here runs in your own Claude session." />
        <div className="mb-6 flex gap-2">
          <Link href="/tasks/new" className={secondaryButtonClass}>
            Post a task
          </Link>
          <Link href="/projects/new" className={secondaryButtonClass}>
            Post a project
          </Link>
        </div>
      </div>
      <Flash notice={search.notice} error={search.error} />

      <OwnerQueue items={queue} waiting={waiting} />

      <Card className="mb-6">
        <h2 className="font-semibold">How much do you want to take on?</h2>
        <p className="mt-1 text-sm text-stone-600">
          The board shows work that fits. It&apos;s your call, and only a filter.{" "}
          {takeOn === user.takeOn ? "This is your default." : (
            <>
              Your default is {TAKE_ON_LABEL[user.takeOn].toLowerCase()};{" "}
              <Link href="/profile" className="underline">
                change it on your profile
              </Link>
              .
            </>
          )}
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="How much do you want to take on?">
          {TAKE_ON.map((t) => (
            <Link
              key={t}
              href={`/?take=${t}`}
              role="radio"
              aria-checked={t === takeOn}
              className={`rounded-xl border-2 p-3 transition ${
                t === takeOn ? "border-brand-600 bg-brand-50" : "border-stone-200 bg-white hover:border-stone-300"
              }`}
            >
              <span className="block font-semibold">{TAKE_ON_LABEL[t]}</span>
              <span className="mt-0.5 block text-sm text-stone-600">{TAKE_ON_SHOWS[t]}</span>
            </Link>
          ))}
        </div>
      </Card>

      {mine.length ? (
        <Card className="mb-6 border-brand-100 bg-brand-50/40">
          <h2 className="font-semibold">Your work</h2>
          <ul className="mt-2 divide-y divide-stone-100">
            {mine.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/tasks/${t.id}`} className="font-medium hover:underline">
                  <span className="mr-2 font-mono text-xs text-stone-500">{taskRef(t.id)}</span>
                  {t.title}
                </Link>
                <span className="text-stone-600">
                  Yours until <LocalTime value={t.holder!.expiresAt} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {empty ? (
        <Card className="py-14 text-center">
          <p className="text-lg font-semibold">Nothing that fits {TAKE_ON_LABEL[takeOn].toLowerCase()} right now.</p>
          <p className="mt-2 text-stone-600">
            {takeOn === "big" ? "When a coworker posts work, it shows up here." : "Try a bigger choice above, or post some work of your own."}
          </p>
        </Card>
      ) : null}

      {view.projects.map((p) => (
        <Card key={p.id} className="mb-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">
              <Link href={`/projects/${p.id}`} className="hover:underline">
                {p.title}
              </Link>
            </h2>
            <span className="text-sm text-stone-500">
              {p.repo.fullName} · by @{p.ownerHandle}
            </span>
          </div>
          <p className="mt-1 text-stone-600">{p.goal}</p>
          {p.milestones.map((m) => (
            <section key={m.id} className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">
                  Milestone {m.position}: {m.title}
                </h3>
                {wholeMilestones && m.adoptWhole.ok ? (
                  <form action={adoptMilestoneAction}>
                    <input type="hidden" name="milestoneId" value={m.id} />
                    <input type="hidden" name="back" value={`/?take=${takeOn}`} />
                    <button className={secondaryButtonClass}>Take on the whole milestone</button>
                  </form>
                ) : null}
              </div>
              <p className="text-sm text-stone-600">{m.goal}</p>
              <ul className="mt-1 divide-y divide-stone-100">
                {m.tasks.map((t) => (
                  <TaskRow key={t.id} task={t} waiting={t.waiting} viewerId={user.id} />
                ))}
              </ul>
            </section>
          ))}
        </Card>
      ))}

      {view.singles.length ? (
        <Card>
          <h2 className="text-lg font-semibold">Single tasks</h2>
          <ul className="mt-1 divide-y divide-stone-100">
            {view.singles.map((t) => (
              <TaskRow key={t.id} task={t} viewerId={user.id} />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
