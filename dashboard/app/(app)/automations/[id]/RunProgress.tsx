"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { EventTimeline } from "@/components/ui/event-timeline";
import { RelativeTime } from "@/components/ui/relative-time";
import type { ApiError } from "@/lib/api";
import { runDetail } from "../actions";
import { FINISHED, isSettled, logLine, stepLabel, type RunDetail } from "../runlog";

const POLL_MS = 1500, MAX_POLLS = 40;

/** One run: state, where it is now, and what the engine decided at each step. Polls until it finishes or parks on a timer. */
export function RunProgress({ automation, run, types }: { automation: string; run: string; types: Record<string, string> }) {
  const [d, setD] = useState<RunDetail | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const polls = useRef(0);
  const load = useCallback(async () => {
    setBusy(true);
    const r = await runDetail(automation, run);
    setBusy(false);
    if (r.error) setErr(r.error); else { setErr(null); setD(r.data); }
  }, [automation, run]);
  useEffect(() => {
    if ((d && isSettled(d)) || polls.current >= MAX_POLLS) return;
    const t = setTimeout(() => { polls.current++; void load(); }, d || err ? POLL_MS : 0);
    return () => clearTimeout(t);
  }, [d, err, load]);
  const running = !!d && !isSettled(d) && polls.current < MAX_POLLS;
  return (
    <div className="grid gap-4" aria-busy={running || undefined}>
      {err && <ErrorState error={err} onRetry={() => { polls.current = 0; void load(); }} />}
      {!d && !err && <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 aria-hidden className="size-4 animate-spin" />Starting the run…</p>}
      {d && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <StatusBadge status={d.state} />
            {d.test && <Badge tone="info">test run</Badge>}
            {d.contact_email && <span className="min-w-0 break-all font-medium">{d.contact_email}</span>}
            {d.current_step && <span className="text-muted">at <code className="text-[12.5px]">{d.current_step}</code></span>}
            {d.state === "exited" && d.exit_reason && <span className="text-muted">left: {d.exit_reason.replace(/_/g, " ")}</span>}
            {d.next_wake_at && !["completed", "exited", "failed"].includes(d.state) && <span className="text-muted">next step <RelativeTime value={d.next_wake_at} /></span>}
          </div>
          {d.steps.length ? (
            <EventTimeline label="Run log" events={d.steps.map((s) => {
              const l = logLine(s);
              return { status: l.status, at: s.at, detail: <><span className="font-medium text-fg">{stepLabel(s.step_key, types)}</span>: {l.text}{l.href && <> · <Link href={l.href} className="text-accent underline underline-offset-2">view</Link></>}</> };
            })} />
          ) : <p className="text-sm text-muted">The engine has not picked this run up yet. It checks every second.</p>}
          <div className="flex items-center gap-3 text-xs text-muted">
            <span role="status" aria-live="polite">{running ? "Updating…" : FINISHED.includes(d.state) ? "Finished." : polls.current >= MAX_POLLS ? "Stopped checking. Refresh to look again." : "Paused on a timer. Refresh to check again."}</span>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => { polls.current = 0; void load(); }}><RefreshCw aria-hidden />Refresh</Button>
          </div>
        </>
      )}
    </div>
  );
}
