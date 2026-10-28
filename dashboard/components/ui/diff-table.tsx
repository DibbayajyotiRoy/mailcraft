"use client";
// A table of proposed edits: changed cells show the old value struck through and the new one highlighted, new
// rows are highlighted whole, skipped rows say why. Modelled on the "Diff Table" idea from Beautiful UI
// (beautifului.dev, MIT: "AI-proposed edits animating through tabular data"); its source is not published, so this
// is written from scratch on our tokens. Old/new stay readable without colour (<del> is struck through, <ins> is
// underlined) and the motion is one CSS animation that the global reduced-motion rule shortens.
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "./button";
import { SegmentedControl } from "./segmented-control";
import { TBody, TD, TH, THead, TR } from "./table";
import { cn } from "@/lib/cn";

export type DiffStatus = "new" | "update" | "unchanged" | "skipped";
/** `was` present = the cell changes from `was` to `value`. */
export type DiffCell = { value?: ReactNode; was?: string | null };
export type DiffRow = { id: string; status: DiffStatus; cells: Record<string, DiffCell>; /** Why a row is skipped, or any remark. */ note?: ReactNode };
export type DiffColumn = { id: string; header: string; className?: string };

const FILTERS: [DiffStatus | "all", string][] = [["all", "All"], ["new", "New"], ["update", "Updates"], ["unchanged", "Unchanged"], ["skipped", "Skipped"]];
const STATUS_LABEL: Record<DiffStatus, string> = { new: "New", update: "Update", unchanged: "Unchanged", skipped: "Skipped" };
const STATUS_STYLE: Record<DiffStatus, string> = { new: "bg-ok-bg text-ok", update: "bg-info-bg text-info", unchanged: "bg-surface-2 text-muted", skipped: "bg-bad-bg text-bad" };

const none = <span className="text-subtle">-</span>;
const hasValue = (v: ReactNode) => v !== undefined && v !== null && v !== "";

/** One edit: the old value struck through, the new one highlighted. `delay` staggers rows so the edits sweep down the table. */
export function Change({ was, now, delay = 0 }: { was?: ReactNode; now?: ReactNode; delay?: number }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      {hasValue(was) ? <del className="text-muted"><span className="sr-only">was </span>{was}</del> : <span className="sr-only">was empty </span>}
      <ins className="inline-block animate-diff-in rounded-sm bg-ok-bg px-1 text-ok" style={{ animationDelay: `${delay}ms` }}><span className="sr-only">now </span>{hasValue(now) ? now : none}</ins>
    </span>
  );
}

function Cell({ cell, status, delay }: { cell?: DiffCell; status: DiffStatus; delay: number }) {
  if (!cell || (!hasValue(cell.value) && cell.was === undefined)) return none;
  if (cell.was !== undefined) return <Change was={cell.was} now={cell.value} delay={delay} />;
  return <span className={cn(status === "new" && "inline-block animate-diff-in rounded-sm bg-ok-bg px-1 text-ok", status === "skipped" && "text-muted")} style={status === "new" ? { animationDelay: `${delay}ms` } : undefined}>{cell.value}</span>;
}

export function DiffTable({ caption, columns, rows, summary, sample, pageSize = 50, className }: {
  caption: string; columns: DiffColumn[]; rows: DiffRow[]; summary: Record<DiffStatus, number>;
  /** The rows are only the start of the data (first page, first N rows). */
  sample?: ReactNode; pageSize?: number; className?: string;
}) {
  const [filter, setFilter] = useState<DiffStatus | "all">("all");
  const [shown, setShown] = useState(pageSize);
  const total = summary.new + summary.update + summary.unchanged + summary.skipped;
  const visible = useMemo(() => (filter === "all" ? rows : rows.filter((r) => r.status === filter)), [rows, filter]);
  const count = (k: DiffStatus | "all") => (k === "all" ? total : summary[k]);
  return (
    <div className={cn("grid gap-3", className)}>
      <ul aria-label="Summary" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {(["new", "update", "unchanged", "skipped"] as const).map((k) => (
          <li key={k} className="inline-flex items-center gap-1.5"><span className={cn("rounded-full px-2 text-xs font-medium", STATUS_STYLE[k])}>{STATUS_LABEL[k]}</span><span className="tabular-nums">{summary[k]}</span></li>
        ))}
      </ul>
      {sample && <p className="text-xs text-muted">{sample}</p>}
      <div className="overflow-x-auto"><SegmentedControl label="Show rows" value={filter} onValueChange={(v) => { setFilter(v); setShown(pageSize); }}
        options={FILTERS.map(([value, label]) => ({ value, label: `${label} ${count(value)}` }))} /></div>
      <p role="status" className="sr-only">Showing {Math.min(shown, visible.length)} of {visible.length} {visible.length === 1 ? "row" : "rows"}</p>
      {visible.length === 0 ? <p className="rounded-md bg-surface-2 px-3 py-4 text-sm text-muted">No rows in this group.</p> : (
        // Wide table that scrolls sideways on a phone: the scroll region must be reachable by keyboard (axe: scrollable-region-focusable), so it is its own focusable region rather than <Table>'s plain wrapper.
        <div role="region" aria-label={`${caption}, scrolls sideways`} tabIndex={0} className="w-full overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <THead><TR><TH>Status</TH>{columns.map((c) => <TH key={c.id} className={c.className}>{c.header}</TH>)}</TR></THead>
          <TBody>
            {visible.slice(0, shown).map((r, i) => (
              <TR key={r.id}>
                <TD><span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium", STATUS_STYLE[r.status])}>{STATUS_LABEL[r.status]}</span></TD>
                {r.status === "skipped" ? (
                  <>
                    <TD className={columns[0]?.className}>{r.cells[columns[0]?.id]?.value ?? none}</TD>
                    <TD colSpan={Math.max(1, columns.length - 1)} className="text-bad">{r.note}</TD>
                  </>
                ) : columns.map((c) => <TD key={c.id} className={cn("py-1.5", c.className)}><Cell cell={r.cells[c.id]} status={r.status} delay={Math.min(i, 12) * 40} /></TD>)}
              </TR>
            ))}
          </TBody>
        </table>
        </div>
      )}
      {visible.length > shown && <div><Button variant="secondary" size="sm" onClick={() => setShown((n) => n + pageSize)}>Show {Math.min(pageSize, visible.length - shown)} more</Button></div>}
    </div>
  );
}
