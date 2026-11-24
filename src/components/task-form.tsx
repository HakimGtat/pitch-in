"use client";

import { useActionState, useMemo, useState, type ReactNode } from "react";
import { submitWithoutReset } from "./submit";
import { briefToMarkdown, suggestAllowedPaths, WORD_LIMIT, type BriefField } from "@/lib/brief";
import type { SizeTier } from "@/lib/db/schema";
import { draftFromValues, type TaskFormState, type TaskFormValues } from "@/lib/forms";
import { splitLines } from "@/lib/glob";
import { formatLines, LINE_CAP, TIER_EFFORT, TIER_LABEL, TIERS, tierAllowed } from "@/lib/sizing";
import { buttonClass, Code, inputClass, secondaryButtonClass } from "./ui";

type RepoOption = { id: number; fullName: string; largestTier: SizeTier };

type Props = {
  action: (prev: TaskFormState, formData: FormData) => Promise<TaskFormState>;
  initial: TaskFormValues;
  hidden?: Record<string, string | number>;
  /** Single tasks pick their repo; milestone tasks and edits have it fixed. */
  repos: RepoOption[];
  fixedRepoId?: number;
  /** Preselected in the repo picker. */
  initialRepoId?: number;
  submitLabel: string;
};

function Label({ htmlFor, title, hint, optional }: { htmlFor: string; title: string; hint?: ReactNode; optional?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block">
      <span className="text-sm font-semibold">{title}</span>
      {optional ? <span className="ml-2 text-xs font-normal text-stone-500">{optional}</span> : null}
      {hint ? <span className="mt-0.5 block text-sm text-stone-600">{hint}</span> : null}
    </label>
  );
}

function FieldErrors({ flags }: { flags: { message: string }[] }) {
  return (
    <>
      {flags.map((e) => (
        <p key={e.message} className="mt-1.5 text-sm text-red-700">
          {e.message}
        </p>
      ))}
    </>
  );
}

export function TaskForm({ action, initial, hidden = {}, repos, fixedRepoId, initialRepoId, submitLabel }: Props) {
  const [state, formAction, pending] = useActionState(action, {
    values: initial,
    check: null,
    needsAck: false,
    error: null,
  });
  const [v, setV] = useState<TaskFormValues>(initial);
  const [repoId, setRepoId] = useState<number | null>(
    fixedRepoId ?? initialRepoId ?? (repos.length === 1 ? repos[0].id : null),
  );
  const repo = repos.find((r) => r.id === repoId) ?? null;
  const set = (key: keyof TaskFormValues) => (e: { target: { value: string } }) => setV((old) => ({ ...old, [key]: e.target.value }));

  const words = useMemo(() => briefToMarkdown(draftFromValues(v)).split(/\s+/).filter(Boolean).length, [v]);
  const errorsFor = (field: BriefField) => state.check?.errors.filter((e) => e.field === field) ?? [];
  const ring = (field: BriefField) => (errorsFor(field).length ? " border-red-400" : "");
  const isOther = v.kind === "other";

  return (
    <form onSubmit={submitWithoutReset(formAction)} className="space-y-6">
      {Object.entries(hidden).map(([k, value]) => (
        <input key={k} type="hidden" name={k} value={value} />
      ))}

      {state.error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      ) : null}
      {state.check && state.check.errors.length > 0 ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-semibold">The brief checker found {state.check.errors.length === 1 ? "one thing" : `${state.check.errors.length} things`} to fix:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {state.check.errors.map((e) => (
              <li key={`${e.field}:${e.message}`}>{e.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {state.needsAck && state.check ? (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Everything required is there. Have a look at {state.check.warnings.length === 1 ? "this" : "these"} first:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {state.check.warnings.map((w) => (
              <li key={w.message}>{w.message}</li>
            ))}
          </ul>
          <button name="ack" value="1" className={`${buttonClass} mt-3`} disabled={pending}>
            Post anyway
          </button>
        </div>
      ) : null}

      {fixedRepoId === undefined ? (
        <div>
          <Label htmlFor="repoId" title="Repo" hint="Only repos where you have write access on GitHub are listed." />
          <select
            id="repoId"
            name="repoId"
            value={repoId ?? ""}
            onChange={(e) => setRepoId(Number(e.target.value) || null)}
            className={inputClass}
            required
          >
            <option value="">Pick a repo</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div>
        <Label htmlFor="title" title="Title" hint="Short and specific, like a commit message." />
        <input id="title" name="title" value={v.title} onChange={set("title")} className={inputClass + ring("title")} maxLength={100} />
        <FieldErrors flags={errorsFor("title")} />
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold">What kind of work is it?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["code", "Code", "A fix, a feature, a page or a script."],
              ["other", "Docs, research or design", "Lands as Markdown or files in the repo."],
            ] as const
          ).map(([value, title, hint]) => (
            <label
              key={value}
              className="cursor-pointer rounded-lg border-2 border-stone-200 bg-white p-3 text-sm has-checked:border-brand-600 has-checked:bg-brand-50"
            >
              <span className="flex items-center gap-2 font-semibold">
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={v.kind === value}
                  onChange={set("kind")}
                  className="h-4 w-4 accent-brand-700"
                />
                {title}
              </span>
              <span className="mt-1 block text-stone-600">{hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <Label htmlFor="goal" title="Goal" hint="One sentence on the outcome, not the method." />
        <input id="goal" name="goal" value={v.goal} onChange={set("goal")} className={inputClass + ring("goal")} />
        <FieldErrors flags={errorsFor("goal")} />
      </div>

      <div>
        <Label
          htmlFor="files"
          title="Files to look at"
          hint={
            <>
              Exact paths, one per line, five at most. A note in brackets is fine: <Code>src/upload.py (validate_file)</Code>. For
              brand-new work, name the closest file or the folder it goes in.
            </>
          }
        />
        <textarea id="files" name="files" value={v.files} onChange={set("files")} rows={3} className={`${inputClass} font-mono${ring("files")}`} />
        <FieldErrors flags={errorsFor("files")} />
      </div>

      <div>
        <Label
          htmlFor="output"
          title="Output"
          optional={isOther ? "Required for this kind" : "Non-code tasks"}
          hint={
            <>
              The file to produce and its format, e.g. <Code>research/pricing.md</Code> with a comparison table and sources.
            </>
          }
        />
        <input id="output" name="output" value={v.output} onChange={set("output")} className={inputClass + ring("output")} />
        <FieldErrors flags={errorsFor("output")} />
      </div>

      <div>
        <Label
          htmlFor="allowedPaths"
          title="Allowed paths"
          hint={
            <>
              Glob patterns the PR may touch, one per line, e.g. <Code>src/upload/**</Code>. Anything else fails the scope check.
            </>
          }
        />
        <textarea
          id="allowedPaths"
          name="allowedPaths"
          value={v.allowedPaths}
          onChange={set("allowedPaths")}
          rows={2}
          className={`${inputClass} font-mono${ring("allowedPaths")}`}
        />
        <button
          type="button"
          className={`${secondaryButtonClass} mt-2`}
          onClick={() => setV((old) => ({ ...old, allowedPaths: suggestAllowedPaths(splitLines(old.files)).join("\n") }))}
        >
          Fill from the files above
        </button>
        <FieldErrors flags={errorsFor("allowedPaths")} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="current" title="Current behaviour" optional="Bugs" hint="What happens now, with steps to reproduce it." />
          <textarea id="current" name="current" value={v.current} onChange={set("current")} rows={3} className={inputClass + ring("current")} />
          <FieldErrors flags={errorsFor("current")} />
        </div>
        <div>
          <Label htmlFor="expected" title="Expected behaviour" optional="Bugs" hint="What should happen instead." />
          <textarea id="expected" name="expected" value={v.expected} onChange={set("expected")} rows={3} className={inputClass + ring("expected")} />
          <FieldErrors flags={errorsFor("expected")} />
        </div>
      </div>

      <div>
        <Label htmlFor="acceptance" title="Acceptance criteria" hint="Yes/no items, one per line, that you can tick in seconds when you review." />
        <textarea
          id="acceptance"
          name="acceptance"
          value={v.acceptance}
          onChange={set("acceptance")}
          rows={4}
          className={inputClass + ring("acceptance")}
        />
        <FieldErrors flags={errorsFor("acceptance")} />
      </div>

      <div>
        <Label
          htmlFor="testCommand"
          title="Test command"
          hint={isOther ? 'For docs or research, the repo\'s lint or link-check command, or "none".' : "One command that proves it's done."}
        />
        <input
          id="testCommand"
          name="testCommand"
          value={v.testCommand}
          onChange={set("testCommand")}
          placeholder={isOther ? "none" : "npm test"}
          className={`${inputClass} font-mono${ring("testCommand")}`}
        />
        <FieldErrors flags={errorsFor("testCommand")} />
      </div>

      <div>
        <Label htmlFor="constraints" title="Constraints" hint="e.g. no new dependencies, keep the public API, cite every source." />
        <input id="constraints" name="constraints" value={v.constraints} onChange={set("constraints")} className={inputClass + ring("constraints")} />
        <FieldErrors flags={errorsFor("constraints")} />
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold">Estimate</legend>
        <p className="mb-2 text-sm text-stone-600">Sets the PR&apos;s size cap (lines added plus removed). Bigger work is a project with milestones.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {TIERS.map((tier) => {
            const allowed = !repo || tierAllowed(tier, repo.largestTier);
            return (
              <label
                key={tier}
                className={`rounded-lg border-2 border-stone-200 bg-white p-3 text-sm has-checked:border-brand-600 has-checked:bg-brand-50 ${
                  allowed ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                }`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <input
                    type="radio"
                    name="sizeTier"
                    value={tier}
                    checked={v.sizeTier === tier}
                    onChange={set("sizeTier")}
                    disabled={!allowed}
                    className="h-4 w-4 accent-brand-700"
                  />
                  {TIER_LABEL[tier]}
                </span>
                <span className="mt-1 block text-stone-600">
                  {TIER_EFFORT[tier]}. Up to {formatLines(LINE_CAP[tier])} lines.
                </span>
                {!allowed ? <span className="mt-1 block text-xs text-stone-500">Above this repo&apos;s largest</span> : null}
              </label>
            );
          })}
        </div>
        <FieldErrors flags={errorsFor("sizeTier")} />
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="outOfScope" title="Out of scope" optional="Optional" hint="Related work the agent must not take on." />
          <input id="outOfScope" name="outOfScope" value={v.outOfScope} onChange={set("outOfScope")} className={inputClass} />
        </div>
        <div>
          <Label htmlFor="example" title="Example input and output" optional="Optional" hint="One concrete case." />
          <input id="example" name="example" value={v.example} onChange={set("example")} className={inputClass} />
        </div>
      </div>

      <FieldErrors flags={errorsFor("brief")} />

      <div className="flex flex-wrap items-center gap-4 border-t border-stone-200 pt-5">
        <button className={buttonClass} disabled={pending}>
          {pending ? "Checking…" : submitLabel}
        </button>
        <span className={`text-sm ${words > WORD_LIMIT ? "font-semibold text-red-700" : "text-stone-500"}`}>
          {words} of {WORD_LIMIT} words
        </span>
        <span className="text-sm text-stone-500">Never put secrets, .env values, customer data or private links in a brief.</span>
      </div>
    </form>
  );
}
