import { LocalTime } from "@/components/local-time";
import { buttonClass, Card, Code, PageTitle } from "@/components/ui";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { buildManifest, createSetupState, manifestFormAction } from "@/lib/github/manifest";
import { getGitHubStatus } from "@/lib/github/status";
import { WEBHOOK_JOB, type GitHubWebhookJob } from "@/lib/github/webhook";
import { recentJobs } from "@/lib/jobs";

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-4 border-b border-stone-100 py-5 last:border-0">
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${
          done ? "bg-brand-700 text-white" : "bg-stone-200 text-stone-700"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-1 space-y-2 text-sm text-stone-600">{children}</div> : null}
      </div>
    </li>
  );
}

export default async function Setup() {
  const config = getConfig();
  const status = await getGitHubStatus(config);
  const [lastWebhook] = await recentJobs(getDb(), WEBHOOK_JOB, 1);
  const app = status.app;

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle
        title="Connect Pitch In to GitHub"
        intro={
          <>
            One-time setup for <strong>{config.org}</strong>. You need to be an owner of the org on GitHub.
          </>
        }
      />
      <Card>
        <ol>
          <Step n={1} done={status.smeeConfigured} title="Create a webhook relay channel">
            {status.smeeConfigured ? (
              <p>
                <Code>SMEE_URL</Code> is set. Keep that URL private: anyone with it can read webhook contents (titles
                and file names, not code).
              </p>
            ) : (
              <p>
                Open{" "}
                <a href="https://smee.io/new" className="font-medium underline" target="_blank" rel="noreferrer">
                  smee.io/new
                </a>
                , copy the channel URL into <Code>SMEE_URL</Code> in <Code>.env</Code>, then run{" "}
                <Code>docker compose up -d</Code>.
              </p>
            )}
          </Step>

          <Step n={2} done={Boolean(app)} title={`Register the Pitch In GitHub App on ${config.org}`}>
            {app ? (
              <p>
                Registered as{" "}
                <a href={app.settingsUrl} className="font-medium underline">
                  {app.slug}
                </a>
                .
              </p>
            ) : status.smeeConfigured ? (
              <>
                <p>
                  GitHub shows you the App&apos;s name and permissions before creating it. Afterwards it sends you
                  back here with the keys to paste into <Code>.env</Code>.
                </p>
                <form method="post" action={manifestFormAction(config.org, createSetupState(config.sessionSecret))}>
                  <input
                    type="hidden"
                    name="manifest"
                    value={JSON.stringify(
                      buildManifest({ appUrl: config.appUrl, smeeUrl: config.smeeUrl!, org: config.org }),
                    )}
                  />
                  <button className={`${buttonClass} mt-2`}>Register on GitHub</button>
                </form>
              </>
            ) : (
              <p>Finish step 1 first.</p>
            )}
          </Step>

          <Step n={3} done={app?.installed === true} title={`Install the App on ${config.org}`}>
            {!app ? (
              <p>After step 2.</p>
            ) : app.installed === true ? (
              <p>Installed.</p>
            ) : (
              <>
                {app.installed === null ? <p>Couldn&apos;t reach GitHub to check. Reload to try again.</p> : null}
                <p>Install it on the org. You can pick only the trial repos.</p>
                <a href={app.installUrl} className={`${buttonClass} mt-2`}>
                  Install on GitHub
                </a>
              </>
            )}
          </Step>

          <Step n={4} done={Boolean(lastWebhook)} title="Check that webhooks arrive">
            {lastWebhook ? (
              <p>
                Last webhook: <Code>{(lastWebhook.payload as GitHubWebhookJob).event}</Code> at{" "}
                <LocalTime value={lastWebhook.createdAt} />.
              </p>
            ) : (
              <p>
                Installing the App sends one. If nothing shows up here, check{" "}
                <Code>docker compose logs relay web</Code>.
              </p>
            )}
          </Step>

          <Step n={5} done={false} title="Sign in">
            <p>
              Members of the <strong>{config.signInTeam}</strong> team can sign in. The first time{" "}
              <Code>@{config.mainAdminLogin}</Code> signs in, they become the main admin.
            </p>
            {app?.installed ? (
              <a href="/api/auth/github" className={`${buttonClass} mt-2`}>
                Sign in with GitHub
              </a>
            ) : null}
          </Step>
        </ol>
      </Card>
    </div>
  );
}
