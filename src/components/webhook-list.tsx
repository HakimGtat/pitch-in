import type { Job } from "@/lib/db/schema";
import type { GitHubWebhookJob } from "@/lib/github/webhook";
import { LocalTime } from "./local-time";
import { Badge } from "./ui";

const statusTone = { queued: "amber", running: "amber", done: "brand", failed: "red" } as const;

export function WebhookList({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) {
    return <p className="text-sm text-stone-500">No webhooks received yet.</p>;
  }
  return (
    <ul className="divide-y divide-stone-100 text-sm">
      {jobs.map((job) => {
        const p = job.payload as GitHubWebhookJob;
        return (
          <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="font-mono">
              {p.event}
              {p.action ? `.${p.action}` : ""}
            </span>
            <span className="flex items-center gap-3 text-stone-500">
              <LocalTime value={job.createdAt} />
              <Badge tone={statusTone[job.status]}>{job.status}</Badge>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
