import Link from "next/link";
import { redirect } from "next/navigation";
import { buttonClass, Card, Notice, PageTitle } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";

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

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const config = getConfig();
  const user = await getCurrentUser();

  if (!user) {
    const { error } = await searchParams;
    const message = error ? signInErrors[error]?.(config.signInTeam, config.org) : undefined;
    return (
      <div className="mx-auto max-w-xl pt-6">
        {message ? <Notice kind="error">{message}</Notice> : null}
        <Card className="p-8">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Pitch In</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Pick up a coworker&apos;s wishlist task.</h1>
          <p className="mt-4 text-stone-600">
            The AI team posts small tasks they never get to. You pick one, run it in your own Claude session, and the
            task owner reviews the pull request.
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

  if (!user.profile) redirect("/welcome");

  return (
    <div>
      <PageTitle title="Wishlist" intro="Small tasks from company repos, waiting for someone to pick them up." />
      <Card className="py-14 text-center">
        <p className="text-lg font-semibold">No wishlist tasks yet.</p>
        <p className="mt-2 text-stone-600">When the AI team posts one, it shows up here.</p>
      </Card>
    </div>
  );
}
