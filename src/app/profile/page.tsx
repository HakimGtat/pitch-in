import { switchOwnProfile } from "@/app/actions";
import { DEVELOPER_TEXT, GUIDED_TEXT, ProfileChoice } from "@/components/profile-choice";
import { Badge, buttonClass, Card, Notice, PageTitle } from "@/components/ui";
import { requireUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";

export default async function Profile({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const user = await requireUser();
  const { saved } = await searchParams;
  const { aiTeam, org } = getConfig();

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

      <Card>
        <h2 className="font-semibold">How much guidance do you want?</h2>
        <p className="mt-1 text-sm text-stone-600">Both profiles can take every task.</p>
        <form action={switchOwnProfile} className="mt-4">
          <ProfileChoice
            name="profile"
            defaultValue={user.profile ?? undefined}
            options={[
              { value: "developer", title: "Developer", label: "On the AI team", description: DEVELOPER_TEXT },
              { value: "guided", title: "Guided", label: "Not on the AI team", description: GUIDED_TEXT },
            ]}
          />
          <button className={`${buttonClass} mt-5`}>Save</button>
        </form>
      </Card>
    </div>
  );
}
