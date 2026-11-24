import Link from "next/link";
import { switchOwnProfile } from "@/app/actions";
import { chooseTakeOn } from "@/app/work-actions";
import { DEVELOPER_TEXT, GUIDED_TEXT, ProfileChoice } from "@/components/profile-choice";
import { Badge, buttonClass, Card, Notice, PageTitle } from "@/components/ui";
import { OwnerQueue } from "@/components/work";
import { requireUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { TAKE_ON, TAKE_ON_LABEL, TAKE_ON_SHOWS } from "@/lib/sizing";
import { helpedShip } from "@/lib/merge";
import { taskRef } from "@/lib/prompt";
import { loadWaitingOnOwner } from "@/lib/questions";
import { loadOwnerQueue, loadUnlinkedForOwner } from "@/lib/views";

export default async function Profile({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const user = await requireUser();
  const { saved } = await searchParams;
  const { aiTeam, org } = getConfig();
  const [queue, waiting, shipped, unlinked] = await Promise.all([
    loadOwnerQueue(getDb(), user.id),
    loadWaitingOnOwner(getDb(), user.id),
    helpedShip(getDb(), user.id),
    loadUnlinkedForOwner(getDb(), user.id, new Date()),
  ]);

  return (
    <div className="mx-auto max-w-2xl">
      <PageTitle title="Your profile" />
      {saved ? <Notice kind="success">Profile saved.</Notice> : null}

      <Card className="mb-6 flex items-center gap-4">
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatarUrl} alt="" className="h-14 w-14 rounded-full" />
        ) : null}
        <div>
          <p className="text-lg font-semibold">{user.name ?? `@${user.handle}`}</p>
          <p className="text-stone-600">@{user.handle}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {user.isMainAdmin ? <Badge tone="brand">Main admin</Badge> : null}
            {user.isOrgOwner ? <Badge tone="brand">{org} owner</Badge> : null}
            {user.inAiTeam ? <Badge>{aiTeam}</Badge> : null}
          </div>
        </div>
      </Card>

      <OwnerQueue items={queue} waiting={waiting} unlinked={unlinked} />

      <Card className="mb-6">
        <h2 className="font-semibold">Helped ship{shipped.count ? ` (${shipped.count})` : ""}</h2>
        {shipped.count ? (
          <ul className="mt-2 divide-y divide-stone-100 text-sm">
            {shipped.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/tasks/${t.id}`} className="font-medium hover:underline">
                  <span className="mr-2 font-mono text-xs text-stone-500">{taskRef(t.id)}</span>
                  {t.title}
                </Link>
                <span className="text-stone-500">{t.repoFullName}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-stone-600">Work you take on shows up here once its owner merges it.</p>
        )}
      </Card>

      <Card className="mb-6">
        <h2 className="font-semibold">How much do you want to take on?</h2>
        <p className="mt-1 text-sm text-stone-600">Your default for the board. It&apos;s only a filter; every task stays open to you.</p>
        <form action={chooseTakeOn} className="mt-4">
          <input type="hidden" name="back" value="profile" />
          <ProfileChoice
            name="takeOn"
            defaultValue={user.takeOn}
            options={TAKE_ON.map((t) => ({ value: t, title: TAKE_ON_LABEL[t], label: "", description: `Shows ${TAKE_ON_SHOWS[t].toLowerCase()}.` }))}
          />
          <button className={`${buttonClass} mt-5`}>Save</button>
        </form>
      </Card>

      <Card>
        <h2 className="font-semibold">How much guidance do you want?</h2>
        <p className="mt-1 text-sm text-stone-600">Both profiles can take every task.</p>
        <form action={switchOwnProfile} className="mt-4">
          <ProfileChoice
            name="profile"
            defaultValue={user.profile ?? undefined}
            options={[
              { value: "developer", title: "Developer", label: "I've used a coding agent", description: DEVELOPER_TEXT },
              { value: "guided", title: "Guided", label: "I'm new to coding agents", description: GUIDED_TEXT },
            ]}
          />
          <button className={`${buttonClass} mt-5`}>Save</button>
        </form>
      </Card>
    </div>
  );
}
