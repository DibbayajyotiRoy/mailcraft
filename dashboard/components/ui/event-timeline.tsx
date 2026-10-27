import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { StatusBadge, TONE } from "./badge";
import { RelativeTime } from "./relative-time";

export type TimelineEvent = { status: string; at: string; detail?: ReactNode };

const DOT = { ok: "bg-ok", warn: "bg-warn", info: "bg-info", bad: "bg-bad", neutral: "bg-subtle" } as const;

/** The "envelope trail": one vertical rail of what happened and when. Used by email detail, automation runs, domain verification. */
export function EventTimeline({ events, label, className }: { events: TimelineEvent[]; label: string; className?: string }) {
  return (
    <ol aria-label={label} className={cn("relative grid gap-5 pl-6 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border-strong before:content-['']", className)}>
      {events.map((e, i) => (
        <li key={i} className="relative">
          <span aria-hidden className={cn("absolute -left-6 top-1.5 size-[11px] rounded-full ring-4 ring-bg", DOT[TONE[e.status] ?? "neutral"])} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={e.status} size="sm" />
            <RelativeTime value={e.at} className="text-xs text-muted" />
          </div>
          {e.detail && <div className="mt-1 text-sm text-muted">{e.detail}</div>}
        </li>
      ))}
    </ol>
  );
}
