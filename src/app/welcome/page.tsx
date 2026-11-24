import { redirect } from "next/navigation";
import { answerWelcome } from "@/app/actions";
import { DEVELOPER_TEXT, GUIDED_TEXT, ProfileChoice } from "@/components/profile-choice";
import { buttonClass, Card, Notice } from "@/components/ui";
import { requireUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";
import { TAKE_ON, TAKE_ON_LABEL, TAKE_ON_SHOWS } from "@/lib/sizing";

export default async function Welcome({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser({ allowNoProfile: true });
  if (user.profile) redirect("/profile");
  const { error } = await searchParams;
  const { aiTeam } = getConfig();

  return (
    <div className="mx-auto max-w-2xl">
      {error ? <Notice kind="error">Answer both questions to continue.</Notice> : null}
      <Card className="p-8">
        <p className="text-sm text-stone-500">Welcome, @{user.handle}</p>
        <form action={answerWelcome}>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Have you worked with a coding agent like Claude Code before?</h1>
          <p className="mt-2 text-stone-600">
            Every task is open to everyone. Your answer only changes how much guidance you get, and you can switch any time from your
            profile.
          </p>
          {user.inAiTeam ? (
            <p className="mt-4 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">
              GitHub says you&apos;re in the {aiTeam} team, so Yes is already picked.
            </p>
          ) : null}
          <div className="mt-6">
            <ProfileChoice
              name="usedAgent"
              defaultValue={user.inAiTeam ? "yes" : undefined}
              options={[
                { value: "yes", title: "Yes", label: "Developer", description: DEVELOPER_TEXT },
                { value: "no", title: "No", label: "Guided", description: GUIDED_TEXT },
              ]}
            />
          </div>

          <h2 className="mt-10 text-xl font-bold tracking-tight">How much do you want to take on?</h2>
          <p className="mt-2 text-stone-600">
            The board shows work that fits. It&apos;s your call, and you can change it on the board any time.
          </p>
          <div className="mt-4">
            <ProfileChoice
              name="takeOn"
              defaultValue={user.takeOn}
              options={TAKE_ON.map((t) => ({ value: t, title: TAKE_ON_LABEL[t], label: "", description: `Shows ${TAKE_ON_SHOWS[t].toLowerCase()}.` }))}
            />
          </div>

          <p className="mt-6 text-sm text-stone-500">Posting work needs write access to the repo on GitHub, whatever you answer here.</p>
          <button className={`${buttonClass} mt-6`}>Continue</button>
        </form>
      </Card>
    </div>
  );
}
