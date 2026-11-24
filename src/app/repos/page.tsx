import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { Badge, Card, PageTitle, secondaryButtonClass, StatusDot } from "@/components/ui";
import { Flash } from "@/components/work";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { listConnectedRepos } from "@/lib/repos";
import { TIER_LABEL } from "@/lib/sizing";

export default async function Repos({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  await requireUser();
  const { notice, error } = await searchParams;
  const repos = await listConnectedRepos(getDb());

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageTitle
          title="Repos"
          intro="Work on Pitch In lives in these repos. Each one has CI, and most have a PROJECT_BRIEF.md that every task's agent reads first."
        />
        <Link href="/repos/connect" className={secondaryButtonClass}>
          Connect a repo
        </Link>
      </div>
      <Flash notice={notice} error={error} />
      {repos.length === 0 ? (
        <Card className="py-14 text-center">
          <p className="text-lg font-semibold">No repos connected yet.</p>
          <p className="mt-2 text-stone-600">A repo admin on GitHub connects one, and then coworkers can post work on it.</p>
        </Card>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-stone-100">
            {repos.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                <div>
                  <Link href={`/repos/${r.id}`} className="font-semibold hover:underline">
                    {r.fullName}
                  </Link>
                  <p className="mt-1 flex flex-wrap items-center gap-3 text-sm text-stone-600">
                    <span className="flex items-center gap-1.5">
                      <StatusDot ok={r.hasCi} /> {r.hasCi ? "CI" : "CI missing"}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <StatusDot ok={Boolean(r.projectBrief)} /> {r.projectBrief ? "PROJECT_BRIEF.md" : "No PROJECT_BRIEF.md yet"}
                    </span>
                    <span>
                      Read from GitHub <LocalTime value={r.refreshedAt} />
                    </span>
                  </p>
                </div>
                <Badge>Largest: {TIER_LABEL[r.settings.largestTier]}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
