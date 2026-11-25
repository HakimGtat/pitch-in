import {
  adminBlock,
  adminHandOver,
  adminResolveAlert,
  adminSetProfile,
  adminUnblock,
} from "@/app/actions";
import { LocalTime } from "@/components/local-time";
import { WebhookList } from "@/components/webhook-list";
import {
  Badge,
  buttonClass,
  Card,
  dangerButtonClass,
  Notice,
  secondaryButtonClass,
  StatusDot,
} from "@/components/ui";
import { listUsers } from "@/lib/admin";
import { describeAlert, listOpenAlerts } from "@/lib/alerts";
import { loadTrialReport } from "@/lib/trial";
import { recentAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { getGitHubStatus } from "@/lib/github/status";
import { WEBHOOK_JOB } from "@/lib/github/webhook";
import { recentJobs } from "@/lib/jobs";
import { canBlock, canHandOverMainAdmin, canUnblock } from "@/lib/permissions";

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <Card className="mb-6">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </Card>
  );
}

export default async function Admin({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const me = await requireAdmin();
  const { notice, error } = await searchParams;
  const config = getConfig();
  const db = getDb();
  const [people, audit, webhooks, github, openAlerts, trial] = await Promise.all([
    listUsers(db),
    recentAudit(db, 50),
    recentJobs(db, WEBHOOK_JOB, 10),
    getGitHubStatus(config),
    listOpenAlerts(db),
    loadTrialReport(db),
  ]);
  const mainAdmin = people.find((p) => p.isMainAdmin);
  const handOverTargets = people.filter((p) => canHandOverMainAdmin(me, p).ok);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
        <p className="mt-1 text-stone-600">
          Roles come from GitHub: owners of {config.org} are admins. Here you can block people and hand over the main
          admin role.
        </p>
      </div>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <Section title="Trial" aside={<span className="text-sm text-stone-500">From what the site records; always current</span>}>
        <ul className="space-y-1 text-sm">
          {trial.targets.map((t) => (
            <li key={t.label} className="flex flex-wrap justify-between gap-2">
              <span>
                <span className={t.met ? "text-brand-700" : "text-stone-400"}>{t.met ? "✓" : "○"}</span> {t.label}
              </span>
              <span className="font-medium">{t.value}</span>
            </li>
          ))}
          <li className="text-stone-500">Owners saying they&apos;d keep using it: ask them at the end of the trial.</li>
        </ul>
        <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <h3 className="font-semibold">Merged</h3>
            <p className="mt-1 text-stone-700">
              {trial.merged.total} in all: {trial.merged.byContributors} by coworkers ({trial.merged.byProfile.developer} Developer,{" "}
              {trial.merged.byProfile.guided} Guided), {trial.merged.byOwners} by their owners.
            </p>
            <p className="text-stone-600">
              Code {trial.merged.byKind.code}, other {trial.merged.byKind.other}. Small {trial.merged.byTier.small}, Medium{" "}
              {trial.merged.byTier.medium}, Large {trial.merged.byTier.large}.
            </p>
            <p className="text-stone-600">
              Reopened: {trial.reopens.developer} Developer, {trial.reopens.guided} Guided.
            </p>
            <h3 className="mt-3 font-semibold">Right now</h3>
            <p className="mt-1 text-stone-700">
              {trial.now.prsWaitingOnOwner} PRs waiting on owners, {trial.now.openQuestions} open questions, {trial.now.openAlerts} open alerts.
            </p>
          </div>
          <div>
            <h3 className="font-semibold">First-pass rate per check</h3>
            <ul className="mt-1 font-mono text-xs text-stone-700">
              {trial.firstPass.map((f) => (
                <li key={f.name} className="whitespace-pre">
                  {`${f.name.padEnd(9, " ")} ${f.of ? `${Math.round((f.passed / f.of) * 100)}% of ${f.of}` : "no data yet"}`}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {openAlerts.length ? (
        <Section title="Alerts" aside={<span className="text-sm text-stone-500">{openAlerts.length} open</span>}>
          <p className="mb-3 text-sm text-stone-600">
            Merges that skipped the task owner&apos;s review, and changes to a default branch that didn&apos;t come through an
            owner-merged PR. Free GitHub orgs can&apos;t protect branches on private repos, so Pitch In watches instead.
          </p>
          <ul className="divide-y divide-stone-100">
            {openAlerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <Badge tone="amber">{a.kind === "unreviewed_merge" ? "Unreviewed merge" : "Direct push"}</Badge>{" "}
                  <span className="text-stone-800">{describeAlert(a)}</span>{" "}
                  <span className="text-stone-500">
                    <LocalTime value={a.createdAt} />
                  </span>
                </div>
                {me.isMainAdmin ? (
                  <form action={adminResolveAlert}>
                    <input type="hidden" name="alertId" value={a.id} />
                    <button className={secondaryButtonClass}>Resolve</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="People" aside={<span className="text-sm text-stone-500">{people.length} {people.length === 1 ? "person" : "people"}</span>}>
        <div className="-mx-6 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-y border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-6 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Roles</th>
                <th className="px-3 py-2 font-medium">Profile</th>
                <th className="px-3 py-2 font-medium">Last sign-in</th>
                <th className="px-6 py-2 text-right font-medium">Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {people.map((p) => {
                const block = canBlock(me, p);
                const unblock = canUnblock(me, p);
                return (
                  <tr key={p.id} className={p.blocked ? "bg-red-50/40" : undefined}>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        {p.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
                        ) : (
                          <span className="h-8 w-8 rounded-full bg-stone-200" />
                        )}
                        <div>
                          <p className="font-medium">@{p.handle}</p>
                          {p.name ? <p className="text-stone-500">{p.name}</p> : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {p.isMainAdmin ? <Badge tone="brand">Main admin</Badge> : null}
                        {p.isOrgOwner ? <Badge tone="brand">Org owner</Badge> : null}
                        {p.inAiTeam ? <Badge>{config.aiTeam}</Badge> : null}
                        {p.blocked ? <Badge tone="red">Blocked</Badge> : null}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <form action={adminSetProfile} className="flex items-center gap-2">
                        <input type="hidden" name="userId" value={p.id} />
                        <input type="hidden" name="handle" value={p.handle} />
                        <select
                          name="profile"
                          defaultValue={p.profile ?? ""}
                          aria-label={`Profile for @${p.handle}`}
                          className="rounded-md border border-stone-300 bg-white px-2 py-1"
                        >
                          {p.profile ? null : <option value="">Not chosen</option>}
                          <option value="developer">Developer</option>
                          <option value="guided">Guided</option>
                        </select>
                        <button className={secondaryButtonClass}>Save</button>
                      </form>
                    </td>
                    <td className="px-3 py-3 text-stone-600">
                      <LocalTime value={p.lastSignInAt} />
                    </td>
                    <td className="px-6 py-3 text-right">
                      {p.blocked ? (
                        unblock.ok ? (
                          <form action={adminUnblock}>
                            <input type="hidden" name="userId" value={p.id} />
                            <input type="hidden" name="handle" value={p.handle} />
                            <button className={secondaryButtonClass}>Unblock</button>
                          </form>
                        ) : (
                          <span className="text-stone-400" title={unblock.reason}>Blocked</span>
                        )
                      ) : block.ok ? (
                        <form action={adminBlock}>
                          <input type="hidden" name="userId" value={p.id} />
                          <input type="hidden" name="handle" value={p.handle} />
                          <button className={dangerButtonClass}>Block</button>
                        </form>
                      ) : (
                        <span className="text-stone-400" title={block.reason}>
                          {p.id === me.id ? "You" : "Protected"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Main admin">
        {me.isMainAdmin ? (
          handOverTargets.length > 0 ? (
            <form action={adminHandOver} className="space-y-3">
              <p className="text-sm text-stone-600">
                You&apos;re the main admin. Handing over the role makes someone else the main admin and turns it off
                for you.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  name="userId"
                  aria-label="New main admin"
                  className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
                >
                  {handOverTargets.map((p) => (
                    <option key={p.id} value={p.id}>
                      @{p.handle}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="confirm" value="yes" className="h-4 w-4 accent-brand-700" />
                  I understand I&apos;ll stop being the main admin
                </label>
                <button className={buttonClass}>Hand over</button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-stone-600">
              You&apos;re the main admin. Once someone else signs in, you can hand the role to them here.
            </p>
          )
        ) : (
          <p className="text-sm text-stone-600">
            {mainAdmin ? <>The main admin is @{mainAdmin.handle}.</> : <>Nobody holds the main admin role yet.</>}
          </p>
        )}
      </Section>

      <Section title="GitHub">
        <ul className="mb-5 space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <StatusDot ok={Boolean(github.app)} />
            {github.app ? (
              <>
                GitHub App{" "}
                <a href={github.app.settingsUrl} className="font-medium underline">
                  {github.app.slug}
                </a>{" "}
                is registered
              </>
            ) : (
              <>GitHub App not registered yet</>
            )}
          </li>
          <li className="flex items-center gap-2">
            <StatusDot ok={github.app?.installed === true} />
            {github.app?.installed === true
              ? `Installed on ${config.org}`
              : github.app?.installed === null
                ? "Couldn't reach GitHub to check the installation"
                : `Not installed on ${config.org}`}
          </li>
          <li className="flex items-center gap-2">
            <StatusDot ok={github.smeeConfigured} />
            {github.smeeConfigured ? "Webhook relay (smee) is configured" : "SMEE_URL is empty, so webhooks can't reach this machine"}
          </li>
        </ul>
        <h3 className="mb-2 text-sm font-semibold text-stone-700">Recent webhooks</h3>
        <WebhookList jobs={webhooks} />
      </Section>

      <Section title="Audit log" aside={<span className="text-sm text-stone-500">Latest 50</span>}>
        {audit.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing recorded yet.</p>
        ) : (
          <div className="-mx-6 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-y border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="px-6 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Who</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-6 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap px-6 py-2 text-stone-600">
                      <LocalTime value={a.createdAt} />
                    </td>
                    <td className="px-3 py-2">{a.actorHandle ? `@${a.actorHandle}` : <span className="text-stone-500">GitHub / system</span>}</td>
                    <td className="px-3 py-2 font-mono text-xs">{a.action}</td>
                    <td className="px-3 py-2">{a.target ?? ""}</td>
                    <td className="max-w-xs truncate px-6 py-2 font-mono text-xs text-stone-500" title={a.details ? JSON.stringify(a.details) : undefined}>
                      {a.details ? JSON.stringify(a.details) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
