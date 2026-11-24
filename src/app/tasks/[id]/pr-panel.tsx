import { reopenAction } from "@/app/work-actions";
import { CopyButton } from "@/components/copy-button";
import { buttonClass, Card, dangerButtonClass, inputClass, secondaryButtonClass } from "@/components/ui";
import type { StoredChecks } from "@/lib/checks/run";
import type { Submission } from "@/lib/db/schema";
import { REASON_MAX } from "@/lib/review";
import type { PrAction, PrViewer } from "@/lib/views";

type Props = {
  taskId: number;
  viewer: PrViewer;
  submission: Submission;
  status: { headline: string; failing: string[]; actions: PrAction[] };
  review: { packet: string; review: { url: string; prompt: string; long: boolean }; draft: boolean } | null;
};

/** The task's open PR: its checks for everyone, the review for the owner, reopen for the owner or an admin. */
export function PrPanel({ taskId, viewer, submission, status, review }: Props) {
  const checks = submission.checkResults as StoredChecks | null;
  const prUrl = checks?.pr.url ?? null;
  const show = status.actions;

  return (
    <>
      <Card>
        <h2 className="font-semibold">
          Pull request{" "}
          {prUrl ? (
            <a href={prUrl} target="_blank" rel="noopener noreferrer" className="underline">
              #{submission.prNumber}
            </a>
          ) : (
            `#${submission.prNumber}`
          )}
          {checks?.pr.draft ? <span className="ml-2 text-sm font-normal text-stone-500">(draft)</span> : null}
        </h2>
        <p className="mt-2 text-sm text-stone-700">{status.headline}</p>
        {checks?.results.length && viewer !== "other" ? (
          <ul className="mt-3 space-y-1 font-mono text-xs">
            {checks.results.map((r) => (
              <li key={r.name} className={r.passed ? "text-stone-600" : "text-red-700"}>
                {r.passed ? "✓" : "✗"} {r.name.padEnd(9, " ")} {r.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {show.includes("open_pr") && prUrl ? (
          <a href={prUrl} target="_blank" rel="noopener noreferrer" className={`${secondaryButtonClass} mt-4`}>
            Open the PR on GitHub
          </a>
        ) : null}
      </Card>

      {show.includes("review") && review ? (
        <Card className="border-brand-100">
          <h2 className="font-semibold">Review it</h2>
          <p className="mt-2 text-sm text-stone-600">
            Review in Claude opens your own Claude Code session with the PR, its criteria and the review packet, plus rules that keep
            the review cheap. Nothing runs until you press Enter. Then accept and merge on GitHub, have your agent fix small problems
            first, or reopen the task here.
          </p>
          {review.draft ? (
            <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              This PR is a draft: mark it Ready for review on GitHub before you merge it.
            </p>
          ) : null}
          {review.review.long ? (
            <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              <p>
                This review is longer than a link holds. Copy it, open Claude Code on the web on this repo, and paste it there, or
                download it as a file.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton text={review.review.prompt} label="Copy the review prompt" />
              </div>
            </div>
          ) : (
            <a href={review.review.url} target="_blank" rel="noopener noreferrer" className={`${buttonClass} mt-4 w-full`}>
              Review in Claude
            </a>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <CopyButton text={review.packet} label="Copy packet" />
            <a href={`/tasks/${taskId}/review.md`} className={secondaryButtonClass}>
              Download .md
            </a>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-stone-600">The review packet</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-3 font-mono text-xs">
              {review.packet}
            </pre>
          </details>
        </Card>
      ) : null}

      {show.includes("reopen") ? (
        <Card>
          <h2 className="font-semibold">Reopen the task</h2>
          <p className="mt-2 text-sm text-stone-600">
            For work that isn&apos;t worth fixing. Pitch In closes the PR with your reason, adds the reason to the brief for the next
            person, and puts the task back on the board. Nobody is asked to do anything.
          </p>
          <form action={reopenAction} className="mt-3 space-y-2">
            <input type="hidden" name="taskId" value={taskId} />
            <label htmlFor="reason" className="block text-sm font-medium">
              Why, in one line
            </label>
            <textarea id="reason" name="reason" required maxLength={REASON_MAX} rows={2} className={inputClass} />
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input type="checkbox" name="developersOnly" /> Only developers can take it on next
            </label>
            <button className={dangerButtonClass}>Reopen task</button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
