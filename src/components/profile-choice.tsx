type Option = { value: string; title: string; label: string; description: string };

/** Radio cards, e.g. Developer (has used a coding agent) and Guided (hasn't). */
export function ProfileChoice({
  name,
  options,
  defaultValue,
}: {
  name: string;
  options: Option[];
  defaultValue?: string;
}) {
  return (
    <div className={`grid gap-3 ${options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
      {options.map((o) => (
        <label
          key={o.value}
          className="cursor-pointer rounded-xl border-2 border-stone-200 bg-white p-4 transition hover:border-stone-300 has-checked:border-brand-600 has-checked:bg-brand-50"
        >
          <span className="flex items-center gap-2">
            <input
              type="radio"
              name={name}
              value={o.value}
              defaultChecked={o.value === defaultValue}
              required
              className="h-4 w-4 accent-brand-700"
            />
            <span className="font-semibold">{o.title}</span>
          </span>
          {o.label ? <span className="mt-1 block text-sm font-medium text-brand-800">{o.label}</span> : null}
          <span className="mt-2 block text-sm text-stone-600">{o.description}</span>
        </label>
      ))}
    </div>
  );
}

export const DEVELOPER_TEXT =
  "The full brief, Start in Claude, and Copy brief for any other agent.";
export const GUIDED_TEXT =
  "A step-by-step walkthrough and Start in Claude. Automatic checks and the owner's review back you up, so you never have to judge the result.";
