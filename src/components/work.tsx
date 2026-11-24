import Link from "next/link";
import type { ReactNode } from "react";
import type { TaskBrief, TaskKind, SizeTier } from "@/lib/db/schema";
import { taskRef } from "@/lib/prompt";
import { formatLines, LINE_CAP, TIER_LABEL } from "@/lib/sizing";
import type { WaitingItem } from "@/lib/questions";
import type { FullTaskView, OwnerQueueItem, UnlinkedPr } from "@/lib/views";
import { Badge, Card, Code, Notice } from "./ui";

/** ?notice= and ?error= messages after an action. */
export function Flash({ notice, error }: { notice?: string; error?: string }) {
  return (
    <>
      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </>
  );
}

export function TierBadge({ tier, cap = false }: { tier: SizeTier; cap?: boolean }) {
  const tone = tier === "small" ? "brand" : tier === "medium" ? "neutral" : "amber";
  return (
    <Badge tone={tone}>
      {TIER_LABEL[tier]}
      {cap ? ` · up to ${formatLines(LINE_CAP[tier])} lines` : ""}
    </Badge>
  );
}

export function KindBadge({ kind }: { kind: TaskKind }) {
  return kind === "other" ? <Badge>Docs, research or design</Badge> : null;
}

/** Where a task stands, from the viewer's side. */
export function TaskState({ task, waiting = false, viewerId }: { task: FullTaskView; waiting?: boolean; viewerId: number }) {
  if (task.status === "merged") return <Badge tone="brand">Done</Badge>;
  if (task.status === "closed") return <Badge>Closed</Badge>;
  if (task.status === "in_review" || task.status === "changes_requested") return <Badge tone="amber">In review</Badge>;
  if (task.holder) {
    return task.holder.userId === viewerId ? (
      <Badge tone="brand">Yours</Badge>
    ) : (
      <Badge tone="amber">Taken by @{task.holder.handle}</Badge>
    );
  }
  if (waiting) return <Badge>Waits its turn</Badge>;
  return <Badge tone="brand">Open</Badge>;
}

export function TaskRow({ task, waiting, viewerId }: { task: FullTaskView; waiting?: boolean; viewerId: number }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <span className="w-12 shrink-0 font-mono text-xs text-stone-500">{taskRef(task.id)}</span>
      <Link href={`/tasks/${task.id}`} className="min-w-0 flex-1 font-medium hover:underline">
        {task.position !== null ? <span className="text-stone-500">{task.position}. </span> : null}
        {task.title}
      </Link>
      <span className="flex flex-wrap items-center gap-1.5">
        <KindBadge kind={task.kind} />
        <TierBadge tier={task.sizeTier} />
        <TaskState task={task} waiting={waiting} viewerId={viewerId} />
      </span>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 text-stone-800">{children}</dd>
    </div>
  );
}

const Paragraph = ({ text }: { text: string }) => <p className="whitespace-pre-wrap">{text}</p>;

/** The Task Brief, laid out from its fields (the same content as the Markdown agents get). */
export function BriefView({
  brief,
  kind,
  sizeTier,
  allowedPaths,
}: {
  brief: TaskBrief;
  kind: TaskKind;
  /** Null only in an import preview, before the estimate is filled in. */
  sizeTier: SizeTier | null;
  allowedPaths: string[];
}) {
  const none = brief.testCommand.trim().toLowerCase() === "none";
  return (
    <dl className="divide-y divide-stone-100">
      <Field label="Goal">
        <Paragraph text={brief.goal} />
      </Field>
      <Field label="Files to look at">
        <ul className="space-y-1">
          {brief.files.map((f) => (
            <li key={f}>
              <Code>{f}</Code>
            </li>
          ))}
        </ul>
      </Field>
      {brief.output ? (
        <Field label="Output">
          <Paragraph text={brief.output} />
        </Field>
      ) : null}
      <Field label="Allowed paths">
        <span className="flex flex-wrap gap-1.5">
          {allowedPaths.map((p) => (
            <Code key={p}>{p}</Code>
          ))}
        </span>
      </Field>
      {brief.current || brief.expected ? (
        <Field label="Current and expected behaviour">
          <div className="space-y-2">
            {brief.current ? (
              <p className="whitespace-pre-wrap">
                <span className="font-medium">Now: </span>
                {brief.current}
              </p>
            ) : null}
            {brief.expected ? (
              <p className="whitespace-pre-wrap">
                <span className="font-medium">Expected: </span>
                {brief.expected}
              </p>
            ) : null}
          </div>
        </Field>
      ) : null}
      <Field label="Acceptance criteria">
        <ul className="space-y-1">
          {brief.acceptance.map((c) => (
            <li key={c} className="flex gap-2">
              <span aria-hidden className="mt-1 h-3.5 w-3.5 shrink-0 rounded border border-stone-400" />
              {c}
            </li>
          ))}
        </ul>
      </Field>
      <Field label="Test command">{none ? <span className="text-stone-600">None for this task</span> : <Code>{brief.testCommand}</Code>}</Field>
      <Field label="Constraints">
        <Paragraph text={brief.constraints} />
      </Field>
      <Field label="Estimate">
        <span className="flex items-center gap-2">
          {sizeTier ? <TierBadge tier={sizeTier} cap /> : <span className="text-red-700">Not set</span>}
          <KindBadge kind={kind} />
        </span>
      </Field>
      {brief.outOfScope ? (
        <Field label="Out of scope">
          <Paragraph text={brief.outOfScope} />
        </Field>
      ) : null}
      {brief.example ? (
        <Field label="Example input and output">
          <Paragraph text={brief.example} />
        </Field>
      ) : null}
    </dl>
  );
}

/** The owner's tasks whose PRs need them: failed checks first, then ready for review. */
export function OwnerQueue({
  items,
  waiting = [],
  unlinked = [],
}: {
  items: OwnerQueueItem[];
  waiting?: WaitingItem[];
  unlinked?: UnlinkedPr[];
}) {
  if (items.length === 0 && waiting.length === 0 && unlinked.length === 0) return null;
  return (
    <Card className="mb-6 border-amber-200 bg-amber-50/40">
      <h2 className="font-semibold">Needs you</h2>
      <p className="mt-1 text-sm text-stone-600">PRs on your tasks. Nothing expires while you decide.</p>
      <ul className="mt-2 divide-y divide-stone-100">
        {waiting.map((w) => (
          <li key={`q-${w.questionId}`} className="py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link href={`/tasks/${w.taskId}`} className="font-medium hover:underline">
                <span className="mr-2 font-mono text-xs text-stone-500">{taskRef(w.taskId)}</span>
                {w.title}
              </Link>
              <Badge tone="amber">Waiting on you: a question on PR #{w.prNumber}</Badge>
            </div>
            <p className="mt-1 line-clamp-2 text-stone-600">{w.question}</p>
          </li>
        ))}
        {unlinked.map((u) => (
          <li key={`u-${u.repoFullName}-${u.prNumber}`} className="py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link href={`/tasks/${u.taskId}`} className="font-medium hover:underline">
                <span className="mr-2 font-mono text-xs text-stone-500">{taskRef(u.taskId)}</span>
                {u.title}
              </Link>
              <Badge tone="amber">PR #{u.prNumber} didn&apos;t link</Badge>
            </div>
            <p className="mt-1 text-stone-600">
              {u.reason} If it&apos;s the right PR, paste its link on the task page.
            </p>
          </li>
        ))}
        {items.map((i) => (
          <li key={`${i.taskId}-${i.prNumber}`} className="py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link href={`/tasks/${i.taskId}`} className="font-medium hover:underline">
                <span className="mr-2 font-mono text-xs text-stone-500">{taskRef(i.taskId)}</span>
                {i.title}
              </Link>
              {i.status === "checks_failed" ? (
                <Badge tone="amber">Checks failed on PR #{i.prNumber}</Badge>
              ) : (
                <Badge tone="brand">PR #{i.prNumber} ready for review</Badge>
              )}
            </div>
            {i.failing.length ? (
              <ul className="mt-1 font-mono text-xs text-red-700">
                {i.failing.map((f) => (
                  <li key={f}>✗ {f}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
