"use client";
import { useState } from "react";
import { cn } from "@/lib/cn";
import type { Day } from "@/components/monitor/helpers";

const SERIES = [
  { key: "delivered", label: "Delivered", fill: "fill-ok", chip: "bg-ok" },
  { key: "bounced", label: "Bounced", fill: "fill-bad", chip: "bg-bad" },
  { key: "pending", label: "In flight", fill: "fill-info", chip: "bg-info" },
] as const;
type Key = (typeof SERIES)[number]["key"];

/** Stacked daily bars (delivered + bounced + in flight = sent). Legend entries are toggles; "View as table" is the text alternative. */
export function TrendChart({ days, label }: { days: Day[]; label: string }) {
  const [off, setOff] = useState<Set<Key>>(new Set());
  const [table, setTable] = useState(false);
  const rows = days.map((d) => ({ date: d.date, delivered: d.delivered, bounced: d.bounced, pending: Math.max(0, d.sent - d.delivered - d.bounced), sent: d.sent }));
  const on = SERIES.filter((s) => !off.has(s.key));
  const total = (r: (typeof rows)[number]) => on.reduce((a, s) => a + r[s.key], 0);
  const max = Math.max(1, ...rows.map(total));
  const W = 560, H = 180, pad = 4, bw = Math.max(4, Math.min(36, (W / Math.max(rows.length, 1)) * 0.65));
  const step = W / Math.max(rows.length, 1);
  const toggle = (k: Key) => setOff((o) => { const x = new Set(o); x.has(k) ? x.delete(k) : x.add(k); return x; });
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Series" className="flex flex-wrap gap-1">
          {SERIES.map((s) => (
            <button key={s.key} type="button" data-ui="button" aria-pressed={!off.has(s.key)} onClick={() => toggle(s.key)}
              className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-border px-2 text-xs font-medium text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 aria-pressed:text-fg pointer-coarse:h-11">
              <span aria-hidden className={cn("size-2 rounded-full", s.chip, off.has(s.key) && "opacity-30")} />{s.label}
            </button>
          ))}
        </div>
        <button type="button" data-ui="button" aria-pressed={table} onClick={() => setTable((t) => !t)}
          className="h-7 rounded-sm px-2 text-xs font-medium text-muted underline underline-offset-2 hover:text-fg pointer-coarse:h-11">
          {table ? "View as chart" : "View as table"}
        </button>
      </div>
      {table ? (
        <div className="overflow-x-auto">
          <table data-ui="table" className="w-full text-sm">
            <caption className="sr-only">{label}</caption>
            <thead><tr className="text-left text-xs text-muted"><th scope="col" className="py-1 pr-4 font-medium">Day</th>{SERIES.map((s) => <th key={s.key} scope="col" className="py-1 pr-4 text-right font-medium">{s.label}</th>)}<th scope="col" className="py-1 text-right font-medium">Sent</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.date} className="border-t border-border"><th scope="row" className="py-1 pr-4 text-left font-normal">{r.date}</th>{SERIES.map((s) => <td key={s.key} className="py-1 pr-4 text-right tabular-nums">{r[s.key]}</td>)}<td className="py-1 text-right tabular-nums">{r.sent}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`${label}: ${rows.map((r) => `${r.date} ${r.sent} sent`).join(", ")}`} className="h-[200px] w-full">
          <line x1={0} x2={W} y1={H} y2={H} className="stroke-border-strong" />
          <line x1={0} x2={W} y1={pad} y2={pad} className="stroke-border" strokeDasharray="3 4" />
          <text x={0} y={pad + 11} className="fill-muted text-[10px]">{max}</text>
          {rows.map((r, i) => {
            let y = H;
            const x = i * step + (step - bw) / 2;
            return (
              <g key={r.date}>
                <title>{`${r.date}: ${r.delivered} delivered, ${r.bounced} bounced, ${r.pending} in flight`}</title>
                {on.map((s) => { const h = ((H - pad) * r[s.key]) / max; y -= h; return h > 0 ? <rect key={s.key} x={x} y={y} width={bw} height={h} rx={2} className={cn(s.fill, "transition-[height,y] duration-[var(--dur-base)]")} /> : null; })}
                {(rows.length <= 10 || i % Math.ceil(rows.length / 8) === 0) && <text x={x + bw / 2} y={H + 13} textAnchor="middle" className="fill-muted text-[10px]">{r.date.slice(5)}</text>}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
