"use client";
// Adapted from "Thinking" and "Tool Chips" on beautifului.dev (https://github.com/TurboKach/ai-native-react-components),
// MIT License, Copyright (c) 2026 Turbo. Restyled to mailcraft's tokens; the expand/collapse is a CSS grid-rows
// transition (no motion dependency). The thinking orb is this row's single animated element.
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { OrbState } from "thinking-orbs";
import { Busy } from "@/components/ui/busy";
import { cn } from "@/lib/cn";
import type { Phase } from "@/lib/assistant/types";
import type { Step } from "./useAssistant";

const ORB: Record<Phase, OrbState> = { thinking: "working", reading: "searching", writing: "composing" };
const grid = "grid transition-[grid-template-rows,opacity] duration-[var(--dur-slow)] ease-[var(--ease-out)]";

const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;

/** While the turn runs: orb + the real phase label and a live timer ("Reading templates… 4s"). Afterwards:
 *  "Thought for 6s · 2 steps", expandable to the steps (the timer is per mount, so restored history shows steps only). */
export function Steps({ steps, running, phase }: { steps: Step[]; running: boolean; phase: { phase: Phase; label: string } | null }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const [row, setRow] = useState<string | null>(null);
  const id = useId();
  const start = useRef<number | null>(null);
  const [now, setNow] = useState(0);
  const [took, setTook] = useState<number | null>(null);
  useEffect(() => {
    if (running) {
      start.current ??= Date.now();
      setNow(Date.now());
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
    }
    if (start.current !== null) setTook((v) => v ?? Date.now() - start.current!);
  }, [running]);
  if (!running && !steps.length && took === null) return null;
  const expanded = manual ?? (running && steps.length > 0);
  const failed = steps.filter((s) => s.status === "error").length;
  return (
    <div className="text-sm">
      <div className="flex min-h-7 items-center gap-1">
        {running && <Busy state={ORB[phase?.phase ?? "thinking"]} label={phase?.label ?? "Thinking…"} />}
        {running && <span aria-hidden className="text-subtle tabular-nums">{secs(Math.max(0, now - (start.current ?? now)))}</span>}
        {!running && !steps.length && took !== null && <span className="text-muted tabular-nums">Thought for {secs(took)}</span>}
        {steps.length > 0 && (
          <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setManual(!expanded)}
            className="-mx-1 inline-flex h-7 items-center gap-1 rounded-sm px-1.5 text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 hover:text-fg pointer-coarse:h-11">
            {!running && <span className="tabular-nums">{took !== null ? `Thought for ${secs(took)} · ` : ""}{steps.length} step{steps.length === 1 ? "" : "s"}{failed ? `, ${failed} failed` : ""}</span>}
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform duration-[var(--dur-base)]", expanded && "rotate-180")} />
            <span className="sr-only">{expanded ? "Hide" : "Show"} steps</span>
          </button>
        )}
      </div>
      <div id={id} className={cn(grid, expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} aria-hidden={!expanded}>
        <div className="min-h-0 overflow-hidden">
          <ul className="ml-2 mt-1 flex flex-col gap-0.5 border-l border-border pl-3">
            {steps.map((s) => {
              const open = row === s.id && !!s.detail;
              const body = (
                <>
                  <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
                    {s.status === "running" ? <Loader2 className="size-3.5 animate-spin text-muted" /> : s.status === "error" ? <X className="size-3.5 text-bad" /> : <Check className="size-3.5 text-subtle" />}
                  </span>
                  <span className={cn("min-w-0 truncate", s.status === "error" ? "text-bad" : "text-fg")}>{s.label}</span>
                </>
              );
              return (
                <li key={s.id}>
                  {s.detail ? (
                    <button type="button" aria-expanded={open} onClick={() => setRow(open ? null : s.id)} tabIndex={expanded ? 0 : -1}
                      className="flex min-h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left hover:bg-surface-2 pointer-coarse:min-h-11">{body}</button>
                  ) : <div className="flex min-h-7 w-full items-center gap-2 px-1.5">{body}</div>}
                  {s.detail && open && <p className="ml-7 mt-0.5 text-xs text-muted">{s.detail}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
