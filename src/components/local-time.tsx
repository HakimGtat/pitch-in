"use client";

/** Shows a time in the reader's own time zone. */
export function LocalTime({ value }: { value: Date | string | null }) {
  if (!value) return <span className="text-stone-400">Never</span>;
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} suppressHydrationWarning>
      {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
}
