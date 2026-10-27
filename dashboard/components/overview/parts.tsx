import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, Circle } from "lucide-react";
import { cn } from "@/lib/cn";
import { RANGES } from "@/components/monitor/helpers";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** 24h / 7d / 30d as a link group (URL param, works without JS). */
export function RangeSwitch({ active }: { active: string }) {
  return (
    <nav aria-label="Time range" className="inline-flex rounded-sm border border-border-strong bg-surface p-0.5">
      {RANGES.map((r) => (
        <Link key={r.key} data-ui="link" href={r.key === "7d" ? "/" : `/?range=${r.key}`} replace scroll={false} aria-current={r.key === active ? "true" : undefined}
          className={cn("grid h-7 min-w-10 place-items-center rounded-[4px] px-2 text-xs font-medium text-muted transition-colors duration-[var(--dur-fast)] hover:text-fg pointer-coarse:h-10", r.key === active && "bg-accent-soft text-fg")}>
          {r.label}
        </Link>
      ))}
    </nav>
  );
}

export type Attention = { id: string; text: string; href: string; action: string; tone: "bad" | "warn" };

export function NeedsAttention({ items }: { items: Attention[] }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="attn" className="mb-6">
      <h2 id="attn" className="sr-only">Needs attention</h2>
      <ul className="grid gap-2">
        {items.map((a) => (
          <li key={a.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5 text-sm", a.tone === "bad" ? "border-bad/40 bg-bad-bg text-bad" : "border-warn/30 bg-warn-bg text-warn")}>
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 font-medium">{a.text}</span>
            <Link data-ui="link" href={a.href} className="inline-flex h-7 items-center gap-1 font-medium underline underline-offset-2 pointer-coarse:h-11">{a.action}<ArrowRight aria-hidden className="size-3.5" /></Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values), W = 72, H = 24;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`).join(" ");
  return <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className={cn("h-6 w-[72px] text-muted", className)}><polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export type Step = { id: string; title: string; why: string; done: boolean; href: string; cta: string };

/** First-run checklist, derived from API state. ponytail: P2 owns the full onboarding flow and replaces this slot. */
export function SetupChecklistSlot({ steps }: { steps: Step[] }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <Card>
      <CardHeader title="Get set up" description={`${done} of ${steps.length} done. Your first send fills this page with data.`} />
      <CardBody>
        <ol className="grid gap-3">
          {steps.map((s) => (
            <li key={s.id} className="flex items-start gap-3">
              <span aria-hidden className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border", s.done ? "border-ok bg-ok-bg text-ok" : "border-border-strong text-subtle")}>{s.done ? <Check className="size-3" /> : <Circle className="size-2" />}</span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", s.done && "text-muted line-through")}>{s.title}<span className="sr-only">{s.done ? " (done)" : " (to do)"}</span></p>
                <p className="text-sm text-muted">{s.why}</p>
              </div>
              {!s.done && <Button asChild variant="secondary" size="sm"><Link data-ui="link" href={s.href}>{s.cta}</Link></Button>}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
