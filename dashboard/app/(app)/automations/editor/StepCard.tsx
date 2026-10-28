"use client";
import Link from "next/link";
import { useId, type ReactNode } from "react";
import { ArrowDown, ArrowUp, CircleStop, Clock, GitBranch, Hourglass, Mail, Plus, Sparkles, Tag, Trash2, UserPen, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { FromPicker } from "@/components/emails/from-picker";
import { cn } from "@/lib/cn";
import type { Sender } from "@/lib/senders";
import { DURATION_UNITS, EDGE_LABEL, MAX_INSTRUCTIONS, splitDuration, stepSummary, typeLabel, type Action, type EStep, type StepType } from "./model";
import { RuleEditor } from "./RuleEditor";
import { StepStats, type StepStat } from "./StepStats";

export type Options = { templates: { id: string; alias: string; name: string; published: boolean }[]; segments: string[]; events: string[]; senders: Sender[] };

export const STEP_ICON: Record<StepType, typeof Mail> = { send_email: Mail, delay: Clock, wait_for_event: Hourglass, condition: GitBranch, update_contact: UserPen, add_to_segment: Users, exit: CircleStop };

function DurationField({ label, value, onChange, error, hint }: { label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string }) {
  const parts = splitDuration(value);
  return (
    <Field label={label} error={error} description={parts ? hint : "Written as 1h30m, 2d, …; the longest wait is 30 days."}>
      {(a) => parts ? (
        <div className="flex gap-2">
          <Input {...a} type="number" min={1} inputMode="numeric" className="w-24" value={parts.amount} onChange={(e) => onChange(`${e.target.value}${parts.unit}`)} />
          <Select aria-label={`${label} unit`} className="w-28" value={parts.unit} onChange={(e) => onChange(`${parts.amount}${e.target.value}`)}>{DURATION_UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </div>
      ) : <Input {...a} mono value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

/** Where a branch goes. Only ever forward in the list, so there are no loops. */
function EdgeSelect({ name, step, index, steps, error, onChange }: { name: string; step: EStep; index: number; steps: EStep[]; error?: string; onChange: (v: string) => void }) {
  const last = index === steps.length - 1;
  const opts: [string, string][] = last ? [["next", "End the journey"]] : [
    ["next", `Continue to step ${index + 2}: ${stepSummary(steps[index + 1])}`], ["end", "End the journey"],
    ...steps.slice(index + 2).map((s, k): [string, string] => [`to:${s.key}`, `Jump to step ${index + k + 3}: ${stepSummary(s)}`]),
  ];
  const raw = step.edges[name] ?? "next", value = last && raw === "end" ? "next" : raw;
  if (!opts.some(([v]) => v === value)) opts.push([value, `Invalid: ${value.replace(/^to:/, "")}`]);
  return (
    <Field label={EDGE_LABEL[name]} error={error}>
      {(a) => <Select {...a} value={value} onChange={(e) => onChange(e.target.value)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
    </Field>
  );
}

function SendFields({ s, opts, p, e }: { s: EStep; opts: Options; p: (c: Record<string, any>) => void; e: Record<string, string> }) {
  const c = s.config, llm = c.mode === "llm", id = useId();
  // A definition may name its template by id (the API accepts either); show it as the alias. Picking stores the alias.
  const current = opts.templates.find((t) => t.alias === c.template || t.id === c.template), known = !!current;
  const ci = String(c.custom_instructions ?? "");
  return (
    <>
      <Field label="Template" error={e.template} description={c.template && <Link href={`/templates/${encodeURIComponent(current?.alias ?? c.template)}`} className="text-accent hover:underline">Open template</Link>}>
        {(a) => (
          <Select {...a} value={current?.alias ?? c.template ?? ""} onChange={(ev) => p({ template: ev.target.value })}>
            <option value="">Choose a template…</option>
            {c.template && !known && <option value={c.template}>{c.template} (not found)</option>}
            {opts.templates.map((t) => <option key={t.alias} value={t.alias} disabled={!t.published}>{t.alias}{t.name && t.name !== t.alias ? ` · ${t.name}` : ""}{t.published ? "" : " (not published)"}</option>)}
          </Select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Subject" description="Leave empty to use the template's subject.">{(a) => <Input {...a} value={c.subject ?? ""} onChange={(ev) => p({ subject: ev.target.value })} />}</Field>
        <Field label="Stream" description="Marketing mail gets an unsubscribe link.">{(a) => (
          <Select {...a} value={c.stream ?? ""} onChange={(ev) => p({ stream: ev.target.value })}><option value="">Template default</option><option value="transactional">Transactional</option><option value="marketing">Marketing</option></Select>
        )}</Field>
      </div>
      <Field label="From" error={e.from} description="A connected mailbox, or an address on a verified domain. Leave on the first option to use the first verified domain for the stream.">
        {(a) => <FromPicker {...a} senders={opts.senders} emptyLabel="First verified domain" placeholder="hello@yourdomain.com" value={c.from ?? ""} onChange={(from) => p({ from })} />}
      </Field>
      <div className="rounded-md border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p id={`${id}-ai`} className="flex items-center gap-1.5 text-sm font-medium"><Sparkles aria-hidden className="size-4 text-accent" />Write with AI</p>
            <p id={`${id}-aid`} className="mt-0.5 text-xs text-muted">The model fills the template&apos;s AI slots for each contact, falling back to the slot&apos;s own copy.</p></div>
          <Switch checked={llm} onCheckedChange={(on) => p({ mode: on ? "llm" : "static" })} aria-labelledby={`${id}-ai`} aria-describedby={`${id}-aid`} />
        </div>
        {llm && (
          <Field className="mt-3" label="Writing guidance for this step" error={e.custom_instructions}
            description={<span className="tabular-nums">{ci.length} / {MAX_INSTRUCTIONS.toLocaleString("en")}. Added to your workspace&apos;s AI writing instructions.</span>}>
            {(a) => <Textarea {...a} rows={3} placeholder="e.g. Mention their first project. Keep it under 80 words." value={ci} onChange={(ev) => p({ custom_instructions: ev.target.value })} />}
          </Field>
        )}
      </div>
    </>
  );
}

export function StepCard({ step: s, index, steps, opts, fields, errors, stats, orphan, hasBranch, dispatch, onMove, onRemove }: {
  step: EStep; index: number; steps: EStep[]; opts: Options; fields: string[]; errors: Record<string, string>; stats?: StepStat | null; orphan: boolean; hasBranch: boolean;
  dispatch: (a: Action) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  const Icon = STEP_ICON[s.type], c = s.config, e = errors, n = steps.length, title = `step ${index + 1}, ${typeLabel(s.type)}`;
  const p = (config: Record<string, any>) => dispatch({ t: "patch", key: s.key, config });
  const edge = (name: string) => <EdgeSelect key={name} name={name} step={s} index={index} steps={steps} error={e[`edge_${name}`]} onChange={(v) => dispatch({ t: "patch", key: s.key, edges: { [name]: v } })} />;
  const showThen = s.type !== "exit" && s.type !== "condition" && s.type !== "wait_for_event" && (hasBranch || s.edges.next !== "next");
  return (
    <article id={`step-${s.key}`} tabIndex={-1} aria-label={title} className={cn("w-full rounded-lg border bg-bg p-4 shadow-[0_1px_2px_rgb(0_0_0/.04)] focus-visible:outline-2", Object.keys(e).length ? "border-bad" : "border-border")}>
      <header className="flex flex-wrap items-center gap-2">
        <span aria-hidden className={cn("grid size-7 place-items-center rounded-md", s.type === "send_email" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}><Icon className="size-4" /></span>
        <h3 className="text-sm font-medium"><span className="text-muted">Step {index + 1}</span> · {typeLabel(s.type)}</h3>
        {orphan && <Badge tone="warn" title="Earlier branches skip this step, so nothing leads here">never reached</Badge>}
        <code className="ml-auto hidden truncate text-xs text-subtle sm:block">{s.key}</code>
        <div className="ml-auto flex sm:ml-0">
          <Button size="icon" variant="ghost" data-move={`${s.key}:-1`} aria-label={`Move ${title} up`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp aria-hidden /></Button>
          <Button size="icon" variant="ghost" data-move={`${s.key}:1`} aria-label={`Move ${title} down`} disabled={index === n - 1} onClick={() => onMove(1)}><ArrowDown aria-hidden /></Button>
          <Button size="icon" variant="ghost" aria-label={`Delete ${title}`} onClick={onRemove}><Trash2 aria-hidden /></Button>
        </div>
      </header>
      {stats !== undefined && <StepStats stat={stats ?? undefined} className="mt-2" />}
      <div className="mt-3 grid gap-4">
        {e._ && <p role="alert" className="rounded-md bg-bad-bg px-3 py-2 text-sm font-medium text-bad">{e._}</p>}
        {s.type === "send_email" && <SendFields s={s} opts={opts} p={p} e={e} />}
        {s.type === "delay" && <DurationField label="Wait for" value={c.duration ?? ""} onChange={(v) => p({ duration: v })} error={e.duration} />}
        {s.type === "wait_for_event" && (
          <>
            <Field label="Event to wait for" error={e.event}>{(a) => <><Input {...a} list={`${a.id}-ev`} placeholder="activated" value={c.event ?? ""} onChange={(ev) => p({ event: ev.target.value })} /><datalist id={`${a.id}-ev`}>{opts.events.map((x) => <option key={x} value={x} />)}</datalist></>}</Field>
            <DurationField label="Wait up to" value={c.timeout ?? ""} onChange={(v) => p({ timeout: v })} error={e.timeout} />
            <RuleEditor optional label="Only count the event when" value={c.filter ?? null} onChange={(v) => p({ filter: v })} fields={fields} error={e.filter} />
            <div className="grid gap-4 sm:grid-cols-2">{edge("event")}{edge("timeout")}</div>
          </>
        )}
        {s.type === "condition" && (
          <>
            <RuleEditor label="If" value={c.rule} onChange={(v) => p({ rule: v })} fields={fields} error={e.rule} />
            <div className="grid gap-4 sm:grid-cols-2">{edge("true")}{edge("false")}</div>
          </>
        )}
        {s.type === "update_contact" && <PairsField pairs={c.pairs} error={e.pairs} onChange={(pairs) => p({ pairs })} />}
        {s.type === "add_to_segment" && (
          <Field label="Segment" error={e.segment} description="A segment that does not exist yet is created as a static one.">
            {(a) => <><Input {...a} list={`${a.id}-seg`} value={c.segment ?? ""} onChange={(ev) => p({ segment: ev.target.value })} /><datalist id={`${a.id}-seg`}>{opts.segments.map((x) => <option key={x} value={x} />)}</datalist></>}
          </Field>
        )}
        {s.type === "exit" && <Field label="Reason" description="Shown in the run log. Optional.">{(a) => <Input {...a} value={c.reason ?? ""} onChange={(ev) => p({ reason: ev.target.value })} />}</Field>}
        {showThen && edge("next")}
      </div>
    </article>
  );
}

function PairsField({ pairs, onChange, error }: { pairs: [string, string][]; onChange: (p: [string, string][]) => void; error?: string }) {
  const id = useId(), set = (i: number, j: 0 | 1, v: string) => onChange(pairs.map((x, k) => (k === i ? (j ? [x[0], v] : [v, x[1]]) : x) as [string, string]));
  return (
    <fieldset className="grid gap-2" aria-describedby={error ? `${id}-e` : undefined}>
      <legend className="text-sm font-medium">Set on the contact</legend>
      <ul className="grid gap-3 sm:gap-2">
        {pairs.map(([k, v], i) => (
          <li key={i} className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
            <Input aria-label={`Property ${i + 1}`} placeholder="plan" mono value={k} onChange={(ev) => set(i, 0, ev.target.value)} />
            <Input aria-label={`Value ${i + 1}`} placeholder="pro or $event.plan" value={v} onChange={(ev) => set(i, 1, ev.target.value)} />
            <Button size="icon" variant="ghost" aria-label={`Remove property ${i + 1}`} onClick={() => onChange(pairs.length > 1 ? pairs.filter((_, j) => j !== i) : [["", ""]])}><X aria-hidden /></Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">first_name, last_name and timezone set those fields; anything else is a property. A value starting with $ reads from the run, like <code>$event.plan</code>.</p>
      <div><Button size="sm" variant="ghost" className="-ml-2" onClick={() => onChange([...pairs, ["", ""]])}><Plus aria-hidden />Add property</Button></div>
      {error && <p id={`${id}-e`} className="text-xs font-medium text-bad">{error}</p>}
    </fieldset>
  );
}

/** Used by the trigger card and the page: a labelled block in the same card chrome. */
export function CardShell({ icon: Icon, title, children, className }: { icon: typeof Tag; title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <article className={cn("w-full rounded-lg border border-border bg-bg p-4 shadow-[0_1px_2px_rgb(0_0_0/.04)]", className)}>
      <header className="flex items-center gap-2"><span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent-soft text-accent"><Icon className="size-4" /></span><h3 className="text-sm font-medium">{title}</h3></header>
      <div className="mt-3 grid gap-4">{children}</div>
    </article>
  );
}
