import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function StatCard({ label, value, delta, className }: { label: ReactNode; value: ReactNode; delta?: { text: string; tone: "ok" | "bad" | "neutral" }; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-surface p-4", className)}>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-baseline gap-x-2 text-2xl font-semibold tracking-[-.02em]">
        {value}
        {delta && <span className={cn("text-xs font-medium", delta.tone === "ok" && "text-ok", delta.tone === "bad" && "text-bad", delta.tone === "neutral" && "text-muted")}>{delta.text}</span>}
      </dd>
    </div>
  );
}

/** <dl> two-column metadata list. */
export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm", className)}>
      {items.map(([k, v], i) => <div key={i} className="contents"><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}
    </dl>
  );
}
