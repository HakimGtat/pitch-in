"use client";

import { useActionState, useState } from "react";
import { submitWithoutReset } from "./submit";
import type { ProjectFormState } from "@/app/work-actions";
import { buttonClass, inputClass, secondaryButtonClass } from "./ui";

type Props = {
  action: (prev: ProjectFormState, formData: FormData) => Promise<ProjectFormState>;
  repos: { id: number; fullName: string }[];
  initialRepoId: number | null;
};

type Milestone = { key: number; title: string; goal: string };

export function ProjectForm({ action, repos, initialRepoId }: Props) {
  const [state, formAction, pending] = useActionState(action, {
    values: { repoId: "", title: "", goal: "", milestones: [] },
    flags: [],
    error: null,
  });
  const [repoId, setRepoId] = useState(initialRepoId ?? (repos.length === 1 ? repos[0].id : 0));
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [rows, setRows] = useState<Milestone[]>([
    { key: 1, title: "", goal: "" },
    { key: 2, title: "", goal: "" },
  ]);
  const update = (key: number, field: "title" | "goal", value: string) =>
    setRows((old) => old.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const flagsFor = (field: string) => state.flags.filter((f) => f.field === field);

  return (
    <form onSubmit={submitWithoutReset(formAction)} className="space-y-6">
      {state.error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      ) : null}
      {state.flags.length ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-semibold">A few things to fix:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {state.flags.map((f) => (
              <li key={`${f.field}:${f.message}`}>{f.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <label htmlFor="repoId" className="mb-1.5 block">
          <span className="text-sm font-semibold">Repo</span>
          <span className="mt-0.5 block text-sm text-stone-600">The project and all its tasks live in this repo.</span>
        </label>
        <select
          id="repoId"
          name="repoId"
          value={repoId || ""}
          onChange={(e) => setRepoId(Number(e.target.value))}
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

      <div>
        <label htmlFor="title" className="mb-1.5 block text-sm font-semibold">
          Project title
        </label>
        <input id="title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} className={inputClass} />
      </div>

      <div>
        <label htmlFor="goal" className="mb-1.5 block">
          <span className="text-sm font-semibold">Goal</span>
          <span className="mt-0.5 block text-sm text-stone-600">
            What the project is for, in a sentence or two. It goes into every task&apos;s prompt.
          </span>
        </label>
        <textarea id="goal" name="goal" value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} className={inputClass} />
      </div>

      <fieldset>
        <legend className="text-sm font-semibold">Milestones, in order</legend>
        <p className="mt-0.5 text-sm text-stone-600">
          Each milestone is a step with its own goal. You add its tasks next. Inside a milestone, tasks are taken in order.
        </p>
        <ol className="mt-3 space-y-3">
          {rows.map((row, i) => (
            <li key={row.key} className="rounded-lg border border-stone-200 bg-stone-50 p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">Milestone {i + 1}</span>
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setRows((old) => old.filter((r) => r.key !== row.key))}
                    className="text-sm text-stone-500 hover:text-red-700"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <input
                name="milestoneTitle"
                aria-label={`Milestone ${i + 1} title`}
                placeholder="Title"
                value={row.title}
                onChange={(e) => update(row.key, "title", e.target.value)}
                className={inputClass}
              />
              <input
                name="milestoneGoal"
                aria-label={`Milestone ${i + 1} goal`}
                placeholder="Goal: what's true when this milestone is done"
                value={row.goal}
                onChange={(e) => update(row.key, "goal", e.target.value)}
                className={`${inputClass} mt-2`}
              />
              {flagsFor(`milestone${i}`).map((f) => (
                <p key={f.message} className="mt-1.5 text-sm text-red-700">
                  {f.message}
                </p>
              ))}
            </li>
          ))}
        </ol>
        <button
          type="button"
          className={`${secondaryButtonClass} mt-3`}
          onClick={() => setRows((old) => [...old, { key: Math.max(0, ...old.map((r) => r.key)) + 1, title: "", goal: "" }])}
        >
          Add another milestone
        </button>
      </fieldset>

      <div className="border-t border-stone-200 pt-5">
        <button className={buttonClass} disabled={pending}>
          {pending ? "Posting…" : "Post project"}
        </button>
      </div>
    </form>
  );
}
