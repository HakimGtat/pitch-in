"use client";

import { useActionState, useState } from "react";
import type { ImportFormState } from "@/app/work-actions";
import type { SizeTier } from "@/lib/db/schema";
import type { ImportPreview, TaskPreview } from "@/lib/plan-import";
import { buildPlanningPrompt, planInClaudeUrl } from "@/lib/planning-prompt";
import { CopyButton } from "./copy-button";
import { submitWithoutReset } from "./submit";
import { Badge, buttonClass, Card, inputClass, secondaryButtonClass } from "./ui";
import { BriefView, KindBadge, TierBadge } from "./work";

// "Post a project", the import way (plan.md, Milestone 3): plan with your own
// Claude session, paste its JSON, check it, read the preview, post it all.

export type PlanRepo = {
  id: number;
  fullName: string;
  largestTier: SizeTier;
  offLimitsPaths: string[];
  hasProjectBrief: boolean;
};

type Props = {
  action: (prev: ImportFormState, formData: FormData) => Promise<ImportFormState>;
  repos: PlanRepo[];
  initialRepoId: number | null;
};

const FORM_ID = "plan-import";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function PlanImport({ action, repos, initialRepoId }: Props) {
  const [state, formAction, pending] = useActionState(action, { checkedText: "", checkedRepoId: 0, result: null, error: null });
  const [repoId, setRepoId] = useState(initialRepoId ?? (repos.length === 1 ? repos[0].id : 0));
  const [planFile, setPlanFile] = useState("");
  const [section, setSection] = useState("");
  const [text, setText] = useState("");

  const repo = repos.find((r) => r.id === repoId) ?? null;
  const planning = repo ? { repo, planFile, section } : null;
  const prompt = planning ? buildPlanningPrompt(planning) : "";
  const url = planning ? planInClaudeUrl(planning) : "";
  // Browsers send a textarea's line breaks as \r\n, so compare without them.
  const unix = (s: string) => s.replace(/\r\n/g, "\n");
  const stale = state.result !== null && (unix(text) !== unix(state.checkedText) || repoId !== state.checkedRepoId);
  const result = state.result;

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-lg font-semibold">1. Plan it in Claude</h2>
        <p className="mt-1 text-sm text-stone-600">
          Your own Claude Code session splits a plan you already have into milestones and task briefs, once. It reformats the plan
          rather than redesigning it, reads only that section and <code className="font-mono">PROJECT_BRIEF.md</code>, and answers
          with one JSON block. Nothing runs until you press Enter.
        </p>

        <div className="mt-5">
          <label htmlFor="planRepo" className="mb-1.5 block">
            <span className="text-sm font-semibold">Repo</span>
            <span className="mt-0.5 block text-sm text-stone-600">The project and all its tasks live in this repo.</span>
          </label>
          <select
            id="planRepo"
            value={repoId || ""}
            onChange={(e) => setRepoId(Number(e.target.value))}
            className={inputClass}
          >
            <option value="">Pick a repo</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
          {repo && !repo.hasProjectBrief ? (
            <p className="mt-1.5 text-sm text-amber-800">
              This repo has no PROJECT_BRIEF.md yet, so your agent reads the README instead.
            </p>
          ) : null}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="planFile" className="mb-1.5 block">
              <span className="text-sm font-semibold">Plan file</span>
              <span className="mt-0.5 block text-sm text-stone-600">In the repo. Leave blank to describe the goal in the session.</span>
            </label>
            <input
              id="planFile"
              value={planFile}
              onChange={(e) => setPlanFile(e.target.value)}
              placeholder="plan.md"
              maxLength={120}
              className={`${inputClass} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="planSection" className="mb-1.5 block">
              <span className="text-sm font-semibold">Section</span>
              <span className="mt-0.5 block text-sm text-stone-600">The part to split. Leave blank for the whole file.</span>
            </label>
            <input
              id="planSection"
              value={section}
              onChange={(e) => setSection(e.target.value)}
              placeholder="Milestone 4"
              maxLength={120}
              disabled={!planFile.trim()}
              className={`${inputClass} disabled:bg-stone-100`}
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {repo ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClass}>
              Plan in Claude
            </a>
          ) : (
            <button type="button" disabled className={buttonClass}>
              Plan in Claude
            </button>
          )}
          {repo ? <CopyButton text={prompt} label="Copy prompt" /> : null}
        </div>
        {repo ? (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-stone-600">What your agent gets</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-3 font-mono text-xs">{prompt}</pre>
          </details>
        ) : (
          <p className="mt-2 text-sm text-stone-500">Pick a repo first.</p>
        )}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">2. Paste the plan</h2>
        <p className="mt-1 text-sm text-stone-600">
          Copy your agent&apos;s answer and paste it here, fence and all. Pitch In runs the brief checker on every task, for free, and
          shows you the whole project before anything is posted.
        </p>
        <form id={FORM_ID} onSubmit={submitWithoutReset(formAction)} className="mt-4 space-y-4">
          <input type="hidden" name="repoId" value={repoId || ""} />
          <label htmlFor="planText" className="sr-only">
            The JSON block from your Claude session
          </label>
          <textarea
            id="planText"
            name="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'```json\n{"project": {"title": "…", "goal": "…"}, "milestones": [ … ]}\n```'}
            className={`${inputClass} font-mono text-xs`}
          />
          {state.error ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {state.error}
            </div>
          ) : null}
          <button name="intent" value="check" className={result && !stale ? secondaryButtonClass : buttonClass} disabled={pending || !repoId || !text.trim()}>
            {pending ? "Checking…" : result ? "Check again" : "Check plan"}
          </button>
        </form>
      </Card>

      {result && stale ? (
        <p role="status" className="rounded-lg border border-stone-200 bg-stone-100 px-4 py-3 text-sm text-stone-700">
          You changed the plan or the repo since it was checked. Check it again to see the preview and post.
        </p>
      ) : null}

      {result?.kind === "unparsed" && !stale ? (
        <Card className="border-red-200">
          <h2 className="font-semibold text-red-800">Pitch In couldn&apos;t read this plan</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-800">
            {result.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <div className="mt-4">
            <CopyButton text={result.fix} label="Copy for your agent" />
          </div>
        </Card>
      ) : null}

      {result?.kind === "preview" && !stale ? (
        <Preview preview={result.preview} flags={result.flags} fix={result.fix} pending={pending} />
      ) : null}
    </div>
  );
}

function Preview({
  preview,
  flags,
  fix,
  pending,
}: {
  preview: ImportPreview;
  flags: { errors: string[]; warnings: string[] };
  fix: string;
  pending: boolean;
}) {
  const shape = `${plural(preview.milestones.length, "milestone")}, ${plural(preview.tasks, "task")}`;
  return (
    <section aria-labelledby="preview-title" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="preview-title" className="text-lg font-semibold">
          Preview
        </h2>
        <span className="text-sm text-stone-600">{shape}</span>
      </div>

      {flags.errors.length || flags.warnings.length ? (
        <div
          role={flags.errors.length ? "alert" : "status"}
          className={`rounded-lg border px-4 py-3 text-sm ${flags.errors.length ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}
        >
          <p className="font-semibold">
            {flags.errors.length
              ? `${plural(flags.errors.length, "problem")} to fix before posting`
              : `Nothing blocks posting, but check ${flags.warnings.length === 1 ? "this warning" : `these ${flags.warnings.length} warnings`}`}
          </p>
          {flags.errors.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {flags.errors.map((e, i) => (
                <li key={`e${i}`}>{e}</li>
              ))}
            </ul>
          ) : null}
          {flags.warnings.length ? (
            <div className={flags.errors.length ? "mt-3 text-amber-900" : ""}>
              {flags.errors.length ? (
                <p className="font-semibold">
                  {plural(flags.warnings.length, "warning")}, which {flags.warnings.length === 1 ? "doesn't" : "don't"} block posting
                </p>
              ) : null}
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {flags.warnings.map((w, i) => (
                  <li key={`w${i}`}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-3 text-stone-700">
            {flags.errors.length
              ? "Fix them in the JSON above and check again, or copy them for your agent and paste its new answer."
              : "If a warning is wrong, change the JSON above and check again, or copy it for your agent."}
          </p>
          <div className="mt-2">
            <CopyButton text={fix} label="Copy flags for your agent" />
          </div>
        </div>
      ) : (
        <p role="status" className="rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          No flags. Read it through, then post it at the bottom.
        </p>
      )}

      <Card>
        <p className="text-sm font-semibold uppercase tracking-wide text-stone-500">Project</p>
        <p className="mt-1 text-lg font-semibold">{preview.project.title || <span className="text-red-700">No title</span>}</p>
        <p className="text-stone-600">{preview.project.goal}</p>
        <FlagList errors={preview.project.flags} />
      </Card>

      {preview.milestones.map((m, i) => (
        <Card key={i}>
          <p className="text-sm font-semibold uppercase tracking-wide text-stone-500">Milestone {i + 1}</p>
          <p className="mt-1 font-semibold">{m.title || <span className="text-red-700">No title</span>}</p>
          <p className="text-stone-600">{m.goal}</p>
          <FlagList errors={m.flags} />
          <ol className="mt-4 space-y-2">
            {m.tasks.map((t, j) => (
              <TaskItem key={j} task={t} position={j + 1} />
            ))}
          </ol>
        </Card>
      ))}

      <div className="flex flex-wrap items-center gap-3 border-t border-stone-200 pt-5">
        {flags.errors.length ? (
          <>
            <button type="button" disabled className={buttonClass}>
              Post project
            </button>
            <span className="text-sm text-stone-600">Fix the {plural(flags.errors.length, "problem")} first.</span>
          </>
        ) : flags.warnings.length ? (
          <>
            <button form={FORM_ID} name="intent" value="post-anyway" className={buttonClass} disabled={pending}>
              {pending ? "Posting…" : "Post anyway"}
            </button>
            <span className="text-sm text-stone-600">
              Posts the whole project with {plural(preview.tasks, "task")}, warnings and all. Tasks stay editable until someone takes
              them on.
            </span>
          </>
        ) : (
          <>
            <button form={FORM_ID} name="intent" value="post" className={buttonClass} disabled={pending}>
              {pending ? "Posting…" : "Post project"}
            </button>
            <span className="text-sm text-stone-600">
              Posts the whole project with {plural(preview.tasks, "task")}. Tasks stay editable until someone takes them on.
            </span>
          </>
        )}
      </div>
    </section>
  );
}

function FlagList({ errors, warnings = [] }: { errors: { message: string }[] | string[]; warnings?: { message: string }[] }) {
  const text = (f: { message: string } | string) => (typeof f === "string" ? f : f.message);
  if (!errors.length && !warnings.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {errors.map((f, i) => (
        <li key={`e${i}`} className="text-red-700">
          {text(f)}
        </li>
      ))}
      {warnings.map((f, i) => (
        <li key={`w${i}`} className="text-amber-800">
          {text(f)}
        </li>
      ))}
    </ul>
  );
}

function TaskItem({ task, position }: { task: TaskPreview; position: number }) {
  const { draft } = task;
  const flagged = task.errors.length > 0 || task.warnings.length > 0;
  return (
    <li className={`rounded-lg border ${task.errors.length ? "border-red-200" : task.warnings.length ? "border-amber-200" : "border-stone-200"}`}>
      <details open={flagged || undefined}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3">
          <span className="text-sm text-stone-500">Task {position}</span>
          <span className="font-medium">{draft.title || <span className="text-red-700">No title</span>}</span>
          {draft.sizeTier ? <TierBadge tier={draft.sizeTier} /> : null}
          <KindBadge kind={draft.kind} />
          {task.errors.length ? <Badge tone="red">{plural(task.errors.length, "problem")}</Badge> : null}
          {task.warnings.length ? <Badge tone="amber">{plural(task.warnings.length, "warning")}</Badge> : null}
          <span className="ml-auto text-xs text-stone-500">{task.words} words</span>
        </summary>
        <div className="border-t border-stone-100 px-4 pb-4">
          <FlagList errors={task.errors} warnings={task.warnings} />
          <BriefView brief={draft.brief} kind={draft.kind} sizeTier={draft.sizeTier} allowedPaths={draft.allowedPaths} />
        </div>
      </details>
    </li>
  );
}
