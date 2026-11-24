import Link from "next/link";
import { connectRepoAction } from "@/app/work-actions";
import { CopyButton } from "@/components/copy-button";
import { Badge, buttonClass, Card, Code, Notice, PageTitle } from "@/components/ui";
import { Flash } from "@/components/work";
import { requireUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { createRepoGitHub } from "@/lib/github/app";
import {
  STARTER_LINT_CONFIG,
  STARTER_LINT_CONFIG_PATH,
  STARTER_WORKFLOW,
  STARTER_WORKFLOW_PATH,
  type GitHubRepo,
} from "@/lib/github/repos";
import type { RepoPermission } from "@/lib/permissions";
import { listConnectedRepos } from "@/lib/repos";

function NoCi({ fullName }: { fullName: string }) {
  return (
    <Card className="mb-6 border-amber-200">
      <h2 className="text-lg font-semibold">{fullName} has no CI yet, so it can&apos;t be connected</h2>
      <p className="mt-2 text-stone-600">
        Every PR on Pitch In has to pass the repo&apos;s own checks before it reaches its owner. Code repos need their tests in a
        GitHub Actions workflow. For a docs or research repo, this starter checks the Markdown. Commit it as{" "}
        <Code>{STARTER_WORKFLOW_PATH}</Code> on the default branch, then connect again.
      </p>
      <pre className="mt-4 overflow-auto rounded-lg bg-stone-900 p-4 font-mono text-xs text-stone-100">{STARTER_WORKFLOW}</pre>
      <div className="mt-2">
        <CopyButton text={STARTER_WORKFLOW} label="Copy workflow" />
      </div>
      <p className="mt-4 text-sm text-stone-600">
        Optional: existing docs often trip the line-length rule. To turn it off, also commit <Code>{STARTER_LINT_CONFIG_PATH}</Code>:
      </p>
      <pre className="mt-2 overflow-auto rounded-lg bg-stone-900 p-4 font-mono text-xs text-stone-100">{STARTER_LINT_CONFIG}</pre>
    </Card>
  );
}

export default async function ConnectRepo({
  searchParams,
}: {
  searchParams: Promise<{ noci?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { noci, error } = await searchParams;
  const config = getConfig();

  let available: { repo: GitHubRepo; permission: RepoPermission }[] = [];
  let trouble: string | null = null;
  try {
    const gh = createRepoGitHub(config);
    const connected = new Set((await listConnectedRepos(getDb())).map((r) => r.githubRepoId));
    const repos = (await gh.listRepos()).filter((r) => !connected.has(r.id) && !r.archived);
    const perms = await Promise.all(repos.map((r) => gh.permission(r.fullName, user.handle)));
    available = repos
      .map((repo, i) => ({ repo, permission: perms[i] }))
      .sort((a, b) => a.repo.fullName.localeCompare(b.repo.fullName));
  } catch (err) {
    console.error("[repos/connect]", err);
    trouble =
      err instanceof Error && /isn't installed|isn't set up/.test(err.message)
        ? err.message
        : "Pitch In couldn't list the repos on GitHub just now. Try again in a minute.";
  }

  return (
    <div className="mx-auto max-w-3xl">
      <nav className="mb-3 text-sm text-stone-500">
        <Link href="/repos" className="hover:underline">
          Repos
        </Link>
      </nav>
      <PageTitle
        title="Connect a repo"
        intro={
          <>
            These are the repos in {config.org} that the Pitch In GitHub App can see. Connecting needs admin permission on the repo in
            GitHub, and the repo needs CI.
          </>
        }
      />
      <Flash error={error} />
      {noci ? <NoCi fullName={noci} /> : null}
      {trouble ? <Notice kind="error">{trouble}</Notice> : null}
      {!trouble && available.length === 0 ? (
        <Card className="py-10 text-center">
          <p className="font-semibold">Every repo the App can see is already connected.</p>
          <p className="mt-2 text-sm text-stone-600">To add another, give the Pitch In App access to it in the org&apos;s GitHub settings.</p>
        </Card>
      ) : null}
      {available.length ? (
        <Card className="p-0">
          <ul className="divide-y divide-stone-100">
            {available.map(({ repo, permission }) => (
              <li key={repo.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                <div>
                  <p className="font-semibold">{repo.fullName}</p>
                  <p className="mt-1 flex gap-1.5">
                    <Badge>{repo.private ? "Private" : "Public"}</Badge>
                    <Badge tone={permission === "admin" ? "brand" : "neutral"}>
                      {permission === "admin" ? "You're an admin" : permission === "none" ? "No access" : `You have ${permission} access`}
                    </Badge>
                  </p>
                </div>
                {permission === "admin" ? (
                  <form action={connectRepoAction}>
                    <input type="hidden" name="githubRepoId" value={repo.id} />
                    <button className={buttonClass}>Connect</button>
                  </form>
                ) : (
                  <span className="text-sm text-stone-500">A repo admin connects this one</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
