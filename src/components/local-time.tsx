"use client";

import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/**
 * Shows a time in the reader's own time zone. The server doesn't know that
 * zone, so the server render (and the first render while the page hydrates)
 * shows UTC, labelled, and the browser switches it to local time. Formatting
 * on the server in its own zone (UTC in Docker) used to stick, because React
 * doesn't patch a hydration text mismatch.
 */
export function LocalTime({ value }: { value: Date | string | null }) {
  const inBrowser = useSyncExternalStore(noSubscription, () => true, () => false);
  if (!value) return <span className="text-stone-400">Never</span>;
  const date = new Date(value);
  const iso = date.toISOString();
  return (
    <time dateTime={iso} title={iso}>
      {inBrowser
        ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : `${iso.slice(0, 16).replace("T", " ")} UTC`}
    </time>
  );
}
