"use client";
// Adapted from the "Flowchart" primitive of Beautiful UI (https://beautifului.dev, registry item
// https://www.beautifului.dev/r/flowchart.json, components/primitives/Flowchart.tsx): the dotted canvas, a kind pill
// above a rounded card, bezier connectors that arrive at the card top, the accent ring on the selected card and its
// connectors. Released under the MIT License:
//
//   MIT License
//
//   Copyright (c) 2026 Turbo
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// What changed: our design tokens and Tailwind only (no motion library, no hard-coded hues), a read-only canvas instead
// of draggable cards, a computed top-down layout (flow.ts) instead of two hand-placed nodes, labelled branch edges,
// per-step stats, fit-to-width plus zoom, and an accessible list (nodes are buttons; where they lead and their counts
// are described, not only drawn).
import { CircleStop, Clock, GitBranch, Hourglass, Mail, Maximize2, Sparkles, Tag, TriangleAlert, UserPen, Users, ZoomIn, ZoomOut, Zap } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { layoutFlow, leadsTo, NODE_W, PILL_H, statWords, type FlowGraph, type FlowKind, type Placed } from "./flow";

const ICON: Record<FlowKind, typeof Mail> = { trigger: Zap, send_email: Mail, delay: Clock, wait_for_event: Hourglass, condition: GitBranch, update_contact: UserPen, add_to_segment: Users, exit: CircleStop, unknown: Tag };
/** [kind pill, icon chip]: tokens only, so light, dark and the contrast checks all apply. */
const TONE: Record<FlowKind, string> = {
  trigger: "bg-accent-soft text-accent", send_email: "bg-info-bg text-info", condition: "bg-warn-bg text-warn",
  update_contact: "bg-ok-bg text-ok", add_to_segment: "bg-ok-bg text-ok", delay: "bg-surface-3 text-muted", wait_for_event: "bg-surface-3 text-muted", exit: "bg-surface-3 text-muted", unknown: "bg-surface-3 text-muted",
};
const MIN_FIT = 0.6, MIN_ZOOM = 0.4, MAX_ZOOM = 1.6, STEP = 1.25;

function Stats({ n }: { n: Placed }) {
  const s = n.stat!, cells: [string, number][] = [["Entered", s.entered], ["Active", s.active], ["Done", s.completed], ["Failed", s.failed]];
  return (
    <span aria-hidden className={cn("grid shrink-0 grid-cols-4 gap-1 border-t px-2.5 py-1.5", s.failed > 0 ? "border-bad bg-bad-bg" : "border-border bg-surface-2")} style={{ height: 38 }}>
      {cells.map(([label, v]) => (
        <span key={label} className={cn("flex min-w-0 flex-col leading-4", label === "Failed" && v > 0 ? "font-semibold text-bad" : "text-fg")}>
          <span className="flex items-center gap-0.5 text-xs font-medium tabular-nums">{label === "Failed" && v > 0 && <TriangleAlert className="size-3" />}{v}</span>
          <span className={cn("truncate text-[11px] font-normal", label === "Failed" && v > 0 ? "text-bad" : "text-muted")}>{label}</span>
        </span>
      ))}
    </span>
  );
}

function StepNode({ n, id, graph, cardH, selected, onPick }: { n: Placed; id: string; graph: FlowGraph; cardH: number; selected: boolean; onPick: () => void }) {
  const Icon = ICON[n.kind], failed = (n.stat?.failed ?? 0) > 0;
  const extra = [leadsTo(graph, n.id), n.stat ? statWords(n.stat) : "", n.unreached ? "Nothing leads here, so this step never runs." : ""].filter(Boolean).join(" ");
  return (
    <li className="absolute" style={{ left: n.x, top: n.y, width: NODE_W }}>
      {n.implicit ? (
        <>
          <div style={{ height: PILL_H }} />
          <div className="mx-auto flex h-8 w-fit items-center gap-1.5 rounded-full border border-border-strong bg-bg px-3 text-xs font-medium text-muted"><CircleStop aria-hidden className="size-3.5" />Run ends</div>
        </>
      ) : (
        <>
          <div aria-hidden className="flex items-start justify-between gap-1.5" style={{ height: PILL_H }}>
            <span className={cn("inline-flex h-6 items-center rounded-sm border border-transparent px-2 text-xs font-medium forced-colors:border-[CanvasText]", TONE[n.kind])}>{n.label}</span>
            <span className="flex gap-1.5">{/* badges sit right of centre: the connector arrives at the card's middle */}
              {n.ai && <span className="inline-flex h-6 items-center gap-1 rounded-sm border border-transparent bg-info-bg px-2 text-xs font-medium text-info forced-colors:border-[CanvasText]"><Sparkles className="size-3" />AI-written</span>}
              {n.unreached && <span className="inline-flex h-6 items-center rounded-sm border border-transparent bg-warn-bg px-2 text-xs font-medium text-warn forced-colors:border-[CanvasText]">Never runs</span>}
            </span>
          </div>
          <button type="button" data-node={n.id} aria-describedby={`${id}-d`} onClick={onPick} style={{ height: cardH }}
            className={cn("flex w-full flex-col overflow-hidden rounded-lg border bg-bg text-left shadow-[0_1px_2px_rgb(0_0_0/.04)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] hover:border-border-strong hover:shadow-pop",
              failed ? "border-bad" : selected ? "border-accent" : "border-border", selected && "outline outline-1 outline-accent", n.unreached && "border-dashed")}>
            <span className="flex min-h-0 flex-1 items-center gap-2.5 px-2.5">
              <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-md", TONE[n.kind])}><Icon className="size-[18px]" /></span>
              <span className="block min-w-0 flex-1">
                <span className="sr-only">{n.label}{n.ai ? ", AI-written" : ""}. </span>
                <span title={n.title} className={cn("block text-sm font-semibold text-fg", n.mono ? "truncate font-mono text-[12.5px]" : n.kind === "condition" ? "line-clamp-3" : "line-clamp-2")}>{n.title}</span>
                {n.caption && <span title={n.caption} className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.caption}</span>}
              </span>
            </span>
            {n.stat && <Stats n={n} />}
          </button>
        </>
      )}
      <span id={`${id}-d`} className="sr-only">{extra}</span>
    </li>
  );
}

/**
 * Read-only flowchart of an automation. `onSelect(stepKey)` runs when a step is clicked or activated with the keyboard.
 * The visible canvas is decorative-plus: everything it shows is also in the list (DOM order = reading order, Yes branch
 * before No), each step described by where it leads and its counts.
 */
export function Flowchart({ graph, onSelect, label = "Automation flow", className }: { graph: FlowGraph; onSelect?: (key: string) => void; label?: string; className?: string }) {
  const layout = useMemo(() => layoutFlow(graph), [graph]);
  const uid = useId(), port = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(0), [zoom, setZoom] = useState<number | null>(null), [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const el = port.current;
    if (!el) return;
    const read = () => setVw(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = vw ? Math.min(1, Math.max(MIN_FIT, vw / layout.width)) : 1, scale = zoom ?? fit;
  const bump = (f: number) => setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale * f)));
  const steps = graph.nodes.filter((n) => !n.implicit).length;
  const lit = (e: { from: string; to: string }) => sel !== null && (e.from === sel || e.to === sel);

  return (
    <section aria-label={label} className={cn("overflow-hidden rounded-lg border border-border bg-surface-2", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-1.5">
        <p className="text-xs text-muted">{steps} step{steps === 1 ? "" : "s"}{graph.hasStats && " · all-time counts"}</p>
        <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
          <span aria-hidden className="mr-1 w-9 text-right text-xs tabular-nums text-muted">{Math.round(scale * 100)}%</span>
          <Button size="icon" variant="ghost" aria-label="Zoom out" disabled={scale <= MIN_ZOOM + 0.001} onClick={() => bump(1 / STEP)}><ZoomOut aria-hidden /></Button>
          <Button size="icon" variant="ghost" aria-label="Zoom in" disabled={scale >= MAX_ZOOM - 0.001} onClick={() => bump(STEP)}><ZoomIn aria-hidden /></Button>
          <Button size="icon" variant="ghost" aria-label="Fit to width" disabled={zoom === null} onClick={() => setZoom(null)}><Maximize2 aria-hidden /></Button>
        </div>
      </div>
      <div ref={port} className="overflow-x-auto overflow-y-hidden [background-image:radial-gradient(var(--border-strong)_1px,transparent_1.25px)] [background-size:22px_22px] [background-position:center]" style={{ height: Math.ceil(layout.height * scale) }}>
        <div className="relative mx-auto" style={{ width: Math.ceil(layout.width * scale), height: Math.ceil(layout.height * scale) }}>
          <div className="absolute left-0 top-0 origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}>
            <svg aria-hidden width={layout.width} height={layout.height} className="pointer-events-none absolute inset-0 fill-none">
              {layout.edges.map((e) => <path key={`${e.from}>${e.to}`} d={e.d} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" className={cn("transition-[stroke] duration-[var(--dur-fast)] forced-colors:stroke-[CanvasText]", lit(e) ? "stroke-accent" : "stroke-border-strong")} />)}
            </svg>
            {layout.edges.filter((e) => e.label).map((e) => (
              <span key={`${e.from}>${e.to}`} aria-hidden className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border bg-bg px-2 text-[11px] font-medium leading-[18px] text-muted" style={{ left: e.at.x, top: e.at.y }}>{e.label}</span>
            ))}
            <ol role="list" aria-label="Steps, in the order a contact meets them">
              {layout.nodes.map((n, i) => <StepNode key={n.id} n={n} id={`${uid}-${i}`} graph={graph} cardH={layout.cardH} selected={sel === n.id}
                onPick={() => { setSel(n.id); onSelect?.(n.id); }} />)}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

