import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { buttonClass, Card, Code, Notice, PageTitle } from "@/components/ui";
import { getConfig } from "@/lib/config";
import { convertManifestCode, envLinesFor, verifySetupState } from "@/lib/github/manifest";

/** GitHub sends the admin back here after creating the App, with a one-time code. */
export default async function SetupCallback({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string }>;
}) {
  const config = getConfig();
  const { code, state } = await searchParams;

  if (config.githubApp) {
    return (
      <div className="mx-auto max-w-2xl">
        <Notice kind="info">The GitHub App is already set up.</Notice>
        <Link href="/setup" className={buttonClass}>Back to setup</Link>
      </div>
    );
  }

  if (!code || !verifySetupState(state, config.sessionSecret)) {
    return (
      <div className="mx-auto max-w-2xl">
        <Notice kind="error">
          This setup link is invalid or more than an hour old. Start again from the setup page.
        </Notice>
        <Link href="/setup" className={buttonClass}>Back to setup</Link>
      </div>
    );
  }

  let lines: string;
  let slug: string;
  try {
    const conversion = await convertManifestCode(code);
    lines = envLinesFor(conversion);
    slug = conversion.slug;
    console.log(`[setup] GitHub App ${slug} registered; waiting for its keys to be added to .env`);
  } catch (err) {
    return (
      <div className="mx-auto max-w-2xl">
        <Notice kind="error">{err instanceof Error ? err.message : "GitHub didn't accept the setup code."}</Notice>
        <Link href="/setup" className={buttonClass}>Back to setup</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle title="GitHub App created" intro={<>GitHub registered <strong>{slug}</strong>. Two steps left.</>} />
      <Notice kind="error">
        These lines include the App&apos;s private key and are shown only once. Treat them like a password: put them in{" "}
        <Code>.env</Code> only, never in chat, docs or git.
      </Notice>
      <Card>
        <ol className="list-decimal space-y-5 pl-5">
          <li>
            <p className="font-semibold">Paste these into .env</p>
            <p className="mt-1 text-sm text-stone-600">
              Replace the empty <Code>GITHUB_APP_</Code> lines in <Code>.env</Code> in the Pitch In folder.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-stone-900 p-4 text-xs leading-relaxed text-stone-100">
              {lines}
            </pre>
            <div className="mt-2">
              <CopyButton text={lines} label="Copy lines" />
            </div>
          </li>
          <li>
            <p className="font-semibold">Restart Pitch In</p>
            <p className="mt-1 text-sm text-stone-600">
              Run <Code>docker compose up -d</Code>. The containers pick up the new settings and setup moves on to
              installing the App.
            </p>
          </li>
        </ol>
      </Card>
    </div>
  );
}
