import Link from "next/link";
import { notFound } from "next/navigation";
import { refreshRepoAction, removeRepoAction, saveRepoSettingsAction } from "@/app/work-actions";
import { LocalTime } from "@/components/local-time";
import { buttonClass, Card, Code, dangerButtonClass, inputClass, Notice, secondaryButtonClass, StatusDot } from "@/components/ui";
import { Flash } from "@/components/work";
import { requireUser } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { createRepoGitHub } from "@/lib/github/app";
import { PROJECT_BRIEF_PATH } from "@/lib/github/repos";
import { canChangeRepoSettings, canRemoveRepo, isAdmin, type RepoPermission } from "@/lib/permissions";
import { getConnectedRepo } from "@/lib/repos";
import { formatLines, LINE_CAP, TIER_LABEL, TIERS } from "@/lib/sizing";

export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string; connected?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { notice, error, connected } = await searchParams;
  const repo = Number.isInteger(Number(id)) ? await getConnectedRepo(getDb(), Number(id)) : null;
  if (!repo) notFound();

  // Settings follow GitHub: check the person's permission fresh. Site admins don't need it.
  let permission: RepoPermission = "none";
  if (!isAdmin(user)) {
    try {
      permission = await createRepoGitHub(getConfig()).permission(repo.fullName, user.handle);
    } catch (err) {
      console.error("[repos/id]", err);
    }
  }
  const canEdit = canChangeRepoSettings(user, { permission }).ok;
  const s = repo.settings;

  return (
    <div className="mx-auto max-w-3xl">
      <nav className="mb-3 text-sm text-stone-500">
        <Link href="/repos" className="hover:underline">
          Repos
        </Link>
      </nav>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{repo.fullName}</h1>
          <p className="mt-1 text-sm text-stone-600">
            <a href={`https://github.com/${repo.fullName}`} className="underline">
              Open on GitHub
            </a>{" "}
            · default branch <Code>{repo.defaultBranch}</Code> · read from GitHub <LocalTime value={repo.refreshedAt} />
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/tasks/new?repo=${repo.id}`} className={secondaryButtonClass}>
            Post a task here
          </Link>
          <form action={refreshRepoAction}>
            <input type="hidden" name="repoId" value={repo.id} />
            <button className={secondaryButtonClass}>Refresh from GitHub</button>
          </form>
        </div>
      </div>
      {connected ? (
        <Notice kind="success">
          {repo.fullName} is connected. {repo.projectBrief ? "Its PROJECT_BRIEF.md was read." : null}
        </Notice>
      ) : null}
      <Flash notice={notice} error={error} />

      <Card className="mb-6">
        <ul className="space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <StatusDot ok={repo.hasCi} />
            {repo.hasCi
              ? "CI workflow found. PRs must pass it before they reach review."
              : "CI workflow missing since the last refresh. Add one back: PRs can't be checked without it."}
          </li>
          <li className="flex items-center gap-2">
            <StatusDot ok={Boolean(repo.projectBrief)} />
            {repo.projectBrief ? (
              <>
                {PROJECT_BRIEF_PATH} read <LocalTime value={repo.projectBriefUpdatedAt} />. It refreshes on every push to{" "}
                {repo.defaultBranch}.
              </>
            ) : (
              <>No {PROJECT_BRIEF_PATH} yet. Agents fall back to the README. Writing it is a good first task.</>
            )}
          </li>
        </ul>
      </Card>

      <Card className="mb-6">
        <h2 className="text-lg font-semibold">{PROJECT_BRIEF_PATH}</h2>
        {repo.projectBrief ? (
          <pre className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-4 font-mono text-xs">
            {repo.projectBrief}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-stone-600">
            It should cover what the project is, what it&apos;s built with, setup and check commands, a repo map, conventions and the
            definition of done. Off-limits paths live in the settings below, not in the file.
          </p>
        )}
      </Card>

      <Card className="mb-6">
        <h2 className="text-lg font-semibold">Settings</h2>
        {canEdit ? (
          <form action={saveRepoSettingsAction} className="mt-4 space-y-5">
            <input type="hidden" name="repoId" value={repo.id} />
            <div>
              <label htmlFor="largestTier" className="mb-1.5 block text-sm font-semibold">
                Largest estimate allowed
              </label>
              <select id="largestTier" name="largestTier" defaultValue={s.largestTier} className={inputClass}>
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {TIER_LABEL[t]} (up to {formatLines(LINE_CAP[t])} lines)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="offLimitsPaths" className="mb-1.5 block">
                <span className="text-sm font-semibold">Off-limits paths</span>
                <span className="mt-0.5 block text-sm text-stone-600">
                  Globs no PR may touch, one per line. They&apos;re added to every brief, and the scope check enforces them.
                </span>
              </label>
              <textarea
                id="offLimitsPaths"
                name="offLimitsPaths"
                defaultValue={s.offLimitsPaths.join("\n")}
                rows={3}
                placeholder=".github/**"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label htmlFor="sizeCapIgnore" className="mb-1.5 block">
                <span className="text-sm font-semibold">Files the size cap ignores</span>
                <span className="mt-0.5 block text-sm text-stone-600">Lockfiles and generated files, one per line.</span>
              </label>
              <textarea
                id="sizeCapIgnore"
                name="sizeCapIgnore"
                defaultValue={s.sizeCapIgnore.join("\n")}
                rows={2}
                placeholder="package-lock.json"
                className={`${inputClass} font-mono`}
              />
            </div>
            <button className={buttonClass}>Save settings</button>
          </form>
        ) : (
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="inline font-medium">Largest estimate: </dt>
              <dd className="inline">{TIER_LABEL[s.largestTier]}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Off-limits paths: </dt>
              <dd className="inline">{s.offLimitsPaths.length ? s.offLimitsPaths.join(", ") : "none"}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Size cap ignores: </dt>
              <dd className="inline">{s.sizeCapIgnore.length ? s.sizeCapIgnore.join(", ") : "nothing"}</dd>
            </div>
            <p className="pt-1 text-stone-500">Repo admins on GitHub and Pitch In admins can change these.</p>
          </dl>
        )}
      </Card>

      {canRemoveRepo(user).ok ? (
        <Card>
          <h2 className="font-semibold">Remove from Pitch In</h2>
          <p className="mt-1 text-sm text-stone-600">
            Its open projects and tasks close, and anyone working on them is released. Nothing changes on GitHub.
          </p>
          <form action={removeRepoAction} className="mt-3 flex flex-wrap items-center gap-3">
            <input type="hidden" name="repoId" value={repo.id} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" value="yes" className="h-4 w-4 accent-brand-700" />
              Close its open work
            </label>
            <button className={dangerButtonClass}>Remove repo</button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
