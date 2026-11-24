import type { ReactNode } from "react";

export const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-stone-300";

export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-800 transition hover:bg-stone-100";

export const dangerButtonClass =
  "inline-flex items-center justify-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50";

export const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-stone-400 focus:border-brand-600";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-stone-200 bg-white p-6 shadow-sm ${className}`}>
      {children}
    </section>
  );
}

export function PageTitle({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {intro ? <p className="mt-1 text-stone-600">{intro}</p> : null}
    </div>
  );
}

const badgeTones = {
  neutral: "bg-stone-100 text-stone-700",
  brand: "bg-brand-100 text-brand-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof badgeTones }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeTones[tone]}`}>
      {children}
    </span>
  );
}

export function Notice({ kind, children }: { kind: "info" | "error" | "success"; children: ReactNode }) {
  const tone = {
    info: "border-stone-200 bg-stone-100 text-stone-800",
    error: "border-red-200 bg-red-50 text-red-800",
    success: "border-brand-100 bg-brand-50 text-brand-800",
  }[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`mb-6 rounded-lg border px-4 py-3 text-sm ${tone}`}>
      {children}
    </div>
  );
}

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${ok ? "bg-brand-600" : "bg-amber-500"}`}
    />
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>;
}
