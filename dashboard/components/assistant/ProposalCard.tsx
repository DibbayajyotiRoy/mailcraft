"use client";
// Adapted from "Approval Card" and "Task Rows" on beautifului.dev (https://github.com/TurboKach/ai-native-react-components),
// MIT License, Copyright (c) 2026 Turbo. Restyled to mailcraft's tokens and design system (Button, Badge, AlertDialog).
import { AlertTriangle, Check, ChevronDown, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { diffLines, diffStat } from "@/lib/assistant/diff";
import { goLiveNext } from "@/lib/assistant/errors";
import type { ApplyResult, Proposal } from "@/lib/assistant/types";
import type { Card } from "./useAssistant";

const KIND: Record<Proposal["kind"], string> = { template: "Template draft", automation: "Automation draft", automation_state: "Automation", broadcast: "Broadcast", email: "Email", list: "List", contacts: "Contacts", go_live: "Go-live approval" };
const PILL: Record<ApplyResult["status"], [string, "ok" | "info" | "warn" | "bad"]> = { completed: ["Completed", "ok"], queued: ["Queued", "info"], pending_approval: ["Waiting for approval", "warn"], failed: ["Failed", "bad"] };
const FOLD = 14;

function Diff({ d }: { d: NonNullable<Proposal["diff"]> }) {
  const [all, setAll] = useState(false);
  const rows = diffLines(d.before, d.after), { add, del } = diffStat(rows), shown = all ? rows : rows.slice(0, FOLD);
  return (
    <div>
      <p className="mb-1 flex items-center gap-2 text-xs text-muted">{d.label}<span className="font-mono tabular-nums"><span className="text-ok">+{add}</span> <span className="text-bad">−{del}</span></span></p>
      <div role="region" aria-label={`${d.label} changes`} tabIndex={0} className="max-h-72 overflow-auto rounded-md border border-border bg-bg font-mono text-xs leading-5">
        {shown.map((r, i) => (
          <div key={i} className={cn("flex min-w-max gap-2 px-2", r.t === "+" && "bg-ok-bg", r.t === "-" && "bg-bad-bg", r.t === "…" && "bg-surface-2 text-muted italic")}>
            <span aria-hidden className={cn("w-3 shrink-0 select-none", r.t === "+" && "text-ok", r.t === "-" && "text-bad")}>{r.t === "…" ? "" : r.t}</span>
            <span className="whitespace-pre">{r.s || " "}</span>
            {r.t !== "…" && r.t !== " " && <span className="sr-only">{r.t === "+" ? "(added)" : "(removed)"}</span>}
          </div>
        ))}
      </div>
      {rows.length > FOLD && <button type="button" onClick={() => setAll(!all)} className="mt-1 text-xs text-accent underline underline-offset-2">{all ? "Show less" : `Show all ${rows.length} lines`}</button>}
    </div>
  );
}

function Preview({ p }: { p: NonNullable<Proposal["preview"]> }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline">
        <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />{open ? "Hide" : "Show"} preview
      </button>
      <div id={id} hidden={!open} className="mt-2">
        {open && <>
          <p className="mb-1 truncate text-xs text-muted">Subject: <span className="text-fg">{p.subject || "(none)"}</span></p>
          {/* sandbox="" = no scripts, no forms, no same-origin: the email is rendered inert */}
          <iframe title="Email preview" sandbox="" srcDoc={p.html} className="h-72 w-full rounded-md border border-border bg-white" />
        </>}
      </div>
    </div>
  );
}

/** Task row for an applied proposal: status badge, what ran, where to look. */
export function TaskRow({ r }: { r: ApplyResult }) {
  const [label, tone] = PILL[r.status];
  return (
    <div role="status" className="flex items-start gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5">
      <span aria-hidden className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", r.status === "failed" ? "bg-bad text-on-bad" : "bg-ok text-on-ok")}>
        {r.status === "failed" ? <X className="size-3" /> : <Check className="size-3" />}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{r.label}</p>
        {r.detail && <p className="text-muted">{r.detail}</p>}
        {r.error && <p className="text-bad">{r.error.message}{r.error.hint ? ` ${r.error.hint}` : ""}</p>}
        {r.href && <Link href={r.href} className="mt-1 inline-block text-accent underline underline-offset-2">{r.hrefLabel ?? "Open"}</Link>}
      </div>
      <Badge tone={tone} size="sm">{label}</Badge>
    </div>
  );
}

export function ProposalCard({ card, onApply, onCancel, onEdit }: { card: Card; onApply: (confirmed: boolean) => void; onCancel: () => void; onEdit: () => void }) {
  const { proposal: p, state, result } = card;
  const [ask, setAsk] = useState(false), [, tick] = useState(0);
  // Apply must disable on time, not at the next unrelated render.
  useEffect(() => {
    const ms = p.expires_at - Date.now();
    if (state !== "pending" || ms <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(ms + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [state, p.expires_at]);
  const waiting = !!p.waiting && state === "pending"; // a go-live request is already in Approvals: nothing to apply, so no buttons and no expiry
  const expired = state === "pending" && !waiting && Date.now() > p.expires_at;
  const open = state === "pending" || state === "applying";
  return (
    <section aria-label={p.title} className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="space-y-3 p-3">
        <header>
          <Badge size="sm" tone={p.risk === "sends" ? "warn" : "neutral"}>{KIND[p.kind]}{p.risk === "sends" ? " · sends email" : ""}</Badge>
          <h3 className="mt-1.5 text-base font-semibold">{p.title}</h3>
          <p className="text-sm text-muted">{p.summary}</p>
        </header>
        {p.warnings.length > 0 && (
          <ul className="space-y-1 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">
            {p.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />{w}</li>)}
          </ul>
        )}
        {p.audience && (
          <dl className="flex flex-wrap gap-2 text-sm">
            <div className="rounded-md bg-surface-2 px-2.5 py-1.5"><dt className="text-xs text-muted">{p.kind === "list" ? "Matches now" : "Will receive it"}</dt><dd className="text-md font-semibold tabular-nums">{p.audience.count}</dd></div>
            {p.audience.skipped.map((s) => <div key={s.reason} className="rounded-md bg-surface-2 px-2.5 py-1.5"><dt className="text-xs text-muted">Skipped: {s.reason.replace(/_/g, " ")}</dt><dd className="text-md font-semibold tabular-nums">{s.n}</dd></div>)}
            {p.audience.schedule && <div className="rounded-md bg-surface-2 px-2.5 py-1.5"><dt className="text-xs text-muted">Spread over</dt><dd className="text-sm">{p.audience.schedule}</dd></div>}
          </dl>
        )}
        {p.items && p.items.length > 0 && <ul className="max-h-40 space-y-0.5 overflow-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs" tabIndex={0} aria-label="Included items">{p.items.map((i, k) => <li key={k} className="truncate">{i}</li>)}</ul>}
        {p.lint && p.lint.length > 0 && (
          <ul className="space-y-1 text-sm" aria-label="Lint">
            {p.lint.slice(0, 6).map((l, i) => <li key={i} className="flex items-start gap-2"><Badge size="sm" tone={l.sev === "error" ? "bad" : "warn"}>{l.sev}</Badge><span className="min-w-0 break-words">{l.msg}</span></li>)}
          </ul>
        )}
        {p.diff && <Diff d={p.diff} />}
        {p.preview && <Preview p={p.preview} />}
      </div>
      <footer className="border-t border-border bg-bg px-3 py-2.5">
        {waiting && <TaskRow r={{ status: "pending_approval", label: "A go-live request is already waiting", detail: goLiveNext(p.pending?.kind), href: "/approvals", hrefLabel: "Open Approvals" }} />}
        {open && !expired && !waiting && (
          <div className="flex flex-wrap items-center gap-2">
            <Button loading={state === "applying"} onClick={() => (p.confirm ? setAsk(true) : onApply(false))}>Apply</Button>
            <Button variant="secondary" disabled={state === "applying"} onClick={onEdit}>Edit</Button>
            <Button variant="ghost" disabled={state === "applying"} onClick={onCancel}>Cancel</Button>
            <span className="ml-auto text-xs text-muted">Nothing changes until you apply.</span>
          </div>
        )}
        {expired && <p className="text-sm text-muted">This proposal expired. Ask the assistant to prepare it again.</p>}
        {state === "cancelled" && <p className="text-sm text-muted">Cancelled. Nothing was changed.</p>}
        {(state === "applied" || state === "failed") && result && <TaskRow r={result} />}
        {state === "applying" && <span className="sr-only" role="status"><Loader2 className="animate-spin" />Applying…</span>}
      </footer>
      <AlertDialog open={ask} onOpenChange={setAsk}>
        <AlertDialogContent title="Please confirm" description={p.confirm} confirmLabel="Yes, apply it" destructive={false} onConfirm={() => onApply(true)} />
      </AlertDialog>
    </section>
  );
}
