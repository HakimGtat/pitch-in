import { CopyButton } from "@/components/copy-button";
import { buttonClass, Card } from "@/components/ui";
import type { PrViewer } from "@/lib/views";

type Props = {
  viewer: PrViewer;
  prNumber: number;
  prUrl: string;
  question: string;
  answer: { url: string; prompt: string; long: boolean } | null;
};

/** A question the contributor's agent left on its draft PR. Only the owner gets a button. */
export function QuestionCard({ viewer, prNumber, prUrl, question, answer }: Props) {
  return (
    <Card className="border-amber-200 bg-amber-50/40">
      <h2 className="font-semibold">Waiting on the owner</h2>
      <p className="mt-2 text-sm text-stone-700">
        The agent working on this stopped and left a question on{" "}
        <a href={prUrl} target="_blank" rel="noopener noreferrer" className="underline">
          draft PR #{prNumber}
        </a>
        :
      </p>
      <blockquote className="mt-2 whitespace-pre-wrap border-l-4 border-amber-300 pl-3 text-sm text-stone-700">{question}</blockquote>
      {viewer === "owner" && answer ? (
        <>
          <p className="mt-3 text-sm text-stone-600">
            Settle it with your own agent: finish the work on the PR, or reopen the task with the answer in its brief. Either way
            the PR closes and the question counts as answered.
          </p>
          {answer.long ? (
            <div className="mt-3">
              <CopyButton text={answer.prompt} label="Copy for Claude" />
            </div>
          ) : (
            <a href={answer.url} target="_blank" rel="noopener noreferrer" className={`${buttonClass} mt-3 w-full`}>
              Answer in Claude
            </a>
          )}
        </>
      ) : viewer === "adopter" ? (
        <p className="mt-3 text-sm text-stone-600">
          Your part is done. The owner answers it, by finishing the work or reopening the task; nothing is needed from you.
        </p>
      ) : null}
    </Card>
  );
}
