"use client";
import Link from "next/link";
import { useActionState, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { Plus, Zap } from "lucide-react";
import { Button, SubmitButton } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { saveAutomation, type SaveState } from "../actions";
import { countErrors, newKey, reduce, stepKeyInError, stepSummary, STEP_TYPES, toDefinition, typeLabel, unreachable, validate, type Draft, type StepType } from "./model";
import { BASE_FIELDS, RuleEditor } from "./RuleEditor";
import { CardShell, STEP_ICON, StepCard, type Options } from "./StepCard";
import { NO_STAT, StepStats, type StepStat } from "./StepStats";
import { FlowPreview } from "../flow/FlowPreview";
import { useMedia } from "../flow/useMedia";

const ENTRY: [string, string][] = [
  ["once", "Once per contact"], ["always", "Every time the trigger happens"], ["after_days", "Again after a number of days"], ["if_no_active_run", "Only when they are not already in it"],
];

function AddStep({ at, last, onPick }: { at: number; last?: boolean; onPick: (t: StepType) => void }) {
  return (
    <div className="flex flex-col items-center text-border-strong">
      <span aria-hidden className="h-5 w-0.5 bg-current" />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          {last
            ? <Button id="add-step-end" variant="secondary"><Plus aria-hidden />Add step</Button>
            : <Button size="icon" variant="secondary" className="size-7 rounded-full pointer-coarse:size-11" aria-label={at === 0 ? "Insert a step after the trigger" : `Insert a step after step ${at}`}><Plus aria-hidden /></Button>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-64">
          {STEP_TYPES.map(({ type, label, hint }) => {
            const Icon = STEP_ICON[type];
            return <DropdownMenuItem key={type} onSelect={() => onPick(type)} className="items-start py-1.5"><Icon aria-hidden className="mt-0.5" /><span><span className="block">{label}</span><span className="block text-xs text-muted">{hint}</span></span></DropdownMenuItem>;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {!last && <span aria-hidden className="h-5 w-0.5 bg-current" />}
    </div>
  );
}

/** One screen to build or change an automation. Everything typed stays in the draft until a save succeeds; the API's own refusals come back inline, on the step they name. */
export function Editor({ initial, mode, id, status, version, options, stats }: {
  initial: Draft; mode: "new" | "edit"; id?: string; status?: string; version?: number; options: Options; stats?: Record<string, StepStat> | null;
}) {
  const [d, dispatch] = useReducer(reduce, initial);
  const [state, action] = useActionState(saveAutomation, {} as SaveState);
  const [submitted, setSubmitted] = useState(false);
  const [live, setLive] = useState("");
  const [backfill, setBackfill] = useState(initial.trigger.kind === "segment");
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const focus = useRef<{ move?: [string, string]; card?: string } | null>(null);
  const errs = useMemo(() => validate(d), [d]);
  const bad = countErrors(errs);
  const missing = useMemo(() => unreachable(d), [d]);
  const keys = d.steps.map((s) => s.key);
  const serverKey = state.error ? stepKeyInError(state.error.message, keys) : undefined;
  const hasBranch = d.steps.some((s) => s.type === "condition" || s.type === "wait_for_event");
  const fields = useMemo(() => [...BASE_FIELDS, ...d.steps.filter((s) => s.type === "send_email").map((s) => `clicked_step:${s.key}`), ...options.events.map((e) => `event_count:${e}`)], [d.steps, options.events]);
  const isLive = status === "active", locked = mode === "edit", canPublish = !locked || status === "draft";
  const e = (k: string) => (submitted ? errs.top[k] : undefined);
  const wide = useMedia("(min-width: 1400px)"); // room for the live preview beside the form

  let definition = "";
  try { definition = JSON.stringify(toDefinition(d)); } catch { /* raw rule JSON that does not parse: validation reports it, nothing is submitted */ }

  useEffect(() => {
    const f = focus.current;
    if (!f) return;
    focus.current = null;
    if (f.card) return void document.getElementById(`step-${f.card}`)?.focus();
    const btns = [...document.querySelectorAll<HTMLButtonElement>("[data-move]")];
    (btns.find((b) => b.dataset.move === f.move?.[0] && !b.disabled) ?? btns.find((b) => b.dataset.move === f.move?.[1] && !b.disabled))?.focus();
  }, [d.steps]);

  function tryFocusInvalid() {
    requestAnimationFrame(() => document.querySelector<HTMLElement>('form [aria-invalid="true"], form [role="alert"]')?.focus());
  }
  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    setSubmitted(true);
    if (bad || !definition) { ev.preventDefault(); tryFocusInvalid(); }
  }
  function openConfirm() {
    setSubmitted(true);
    if (bad || !definition) return tryFocusInvalid();
    setConfirm(true);
  }
  const move = (key: string, dir: -1 | 1) => {
    const i = d.steps.findIndex((s) => s.key === key), j = i + dir;
    if (j < 0 || j >= d.steps.length) return;
    focus.current = { move: [`${key}:${dir}`, `${key}:${-dir}`] };
    dispatch({ t: "move", key, dir });
    setLive(`Moved ${stepSummary(d.steps[i])} to step ${j + 1} of ${d.steps.length}.`);
  };
  const add = (type: StepType, at: number) => {
    const key = newKey(d, type);
    focus.current = { card: key };
    dispatch({ t: "add", type, at });
    setLive(`Added a ${typeLabel(type)} step at position ${at + 1}.`);
  };
  const remove = (key: string) => {
    const i = d.steps.findIndex((s) => s.key === key);
    focus.current = d.steps[i + 1] ? { card: d.steps[i + 1].key } : d.steps[i - 1] ? { card: d.steps[i - 1].key } : null;
    dispatch({ t: "remove", key });
    setLive(`Deleted ${typeLabel(d.steps[i].type)} step. ${d.steps.length - 1} steps left.`);
  };

  return (
    <div className={wide ? "grid grid-cols-[minmax(0,48rem)_minmax(0,1fr)] items-start gap-6" : undefined}>
    <form ref={form} action={action} onSubmit={onSubmit} noValidate className="grid max-w-3xl gap-6">
      <input type="hidden" name="definition" value={definition} />
      {locked && isLive && <input type="hidden" name="intent" value="save" />}

      {locked && (
        <p role="note" className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted">
          {isLive ? <>This automation is <strong className="text-fg">live</strong>. Saving stores version {(version ?? 0) + 1} and new contacts use it straight away; contacts already inside finish on version {version}.</>
            : status === "paused" ? <>Saving stores version {(version ?? 0) + 1}. It stays paused until you resume it.</>
            : <>Saving stores version {(version ?? 0) + 1}. It stays a draft until you publish it.</>}
        </p>
      )}

      <Card>
        <CardHeader title="Details" />
        <CardBody>
          <Field label="Name" error={e("name")} description={locked ? "The name identifies the automation, so it cannot change. Duplicate it to start under a new name." : "Lowercase and hyphens work well, like welcome-flow."}>
            {(a) => <Input {...a} readOnly={locked} value={d.name} onChange={(ev) => dispatch({ t: "set", patch: { name: ev.target.value } })} />}
          </Field>
        </CardBody>
      </Card>

      <section aria-labelledby="flow-h">
        <h2 id="flow-h" className="mb-2 text-md font-semibold">Flow</h2>
        <p role="status" aria-live="polite" className="sr-only">{live}</p>
        <ol aria-label="Automation steps" className="grid justify-items-center rounded-lg bg-surface-2 p-3 sm:p-6 [background-image:radial-gradient(var(--border-strong)_1px,transparent_1px)] [background-size:16px_16px]">
          <li id={`step-${d.triggerKey}`} tabIndex={-1} className="w-full">
            <CardShell icon={Zap} title="Trigger">
              {stats && <StepStats stat={stats[d.triggerKey] ?? NO_STAT} />}
              <SegmentedControl label="Start when" value={d.trigger.kind} onValueChange={(kind) => dispatch({ t: "trigger", patch: { kind } })}
                options={[{ value: "event", label: "An event happens" }, { value: "segment", label: "A contact enters a segment" }]} />
              {d.trigger.kind === "event" ? (
                <Field label="Event name" error={e("trigger")} description="Your app sends events with POST /v1/events. Separate several names with commas.">
                  {(a) => (
                    <>
                      <Input {...a} list="trigger-events" placeholder="signed_up" mono value={d.trigger.events} onChange={(ev) => dispatch({ t: "trigger", patch: { events: ev.target.value } })} />
                      <datalist id="trigger-events">{options.events.map((x) => <option key={x} value={x} />)}</datalist>
                      {options.events.length > 0 && (
                        <div role="group" aria-label="Recent events" className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="text-xs text-muted">Seen recently:</span>
                          {options.events.slice(0, 6).map((x) => <Button key={x} size="sm" variant="secondary" className="h-7" onClick={() => dispatch({ t: "trigger", patch: { events: x } })}><code className="text-xs">{x}</code></Button>)}
                        </div>
                      )}
                    </>
                  )}
                </Field>
              ) : (
                <Field label="Segment" error={e("trigger")} description="Everyone already in the segment enters when you publish, unless you choose to skip them.">
                  {(a) => options.segments.length ? (
                    <Select {...a} value={d.trigger.segment} onChange={(ev) => dispatch({ t: "trigger", patch: { segment: ev.target.value } })}>
                      <option value="">Choose a segment…</option>
                      {d.trigger.segment && !options.segments.includes(d.trigger.segment) && <option value={d.trigger.segment}>{d.trigger.segment}</option>}
                      {options.segments.map((x) => <option key={x} value={x}>{x}</option>)}
                    </Select>
                  ) : <Input {...a} value={d.trigger.segment} onChange={(ev) => dispatch({ t: "trigger", patch: { segment: ev.target.value } })} />}
                </Field>
              )}
              <RuleEditor optional label="Only start when" value={d.trigger.filter} onChange={(filter) => dispatch({ t: "trigger", patch: { filter } })} fields={fields} error={e("trigger_filter")} />
            </CardShell>
          </li>
          {d.steps.map((s, i) => (
            <li key={s.key} className="grid w-full justify-items-center">
              <AddStep at={i} onPick={(t) => add(t, i)} />
              <StepCard step={s} index={i} steps={d.steps} opts={options} fields={fields} orphan={missing.has(s.key)} hasBranch={hasBranch}
                errors={{ ...(submitted ? errs.step[s.key] : {}), ...(serverKey === s.key ? { _: state.error!.message } : {}) }}
                stats={stats ? (stats[s.key] ?? null) : undefined} dispatch={dispatch} onMove={(dir) => move(s.key, dir)} onRemove={() => remove(s.key)} />
            </li>
          ))}
          <li className="grid w-full justify-items-center">
            <AddStep at={d.steps.length} last onPick={(t) => add(t, d.steps.length)} />
            {e("steps") && <p role="alert" tabIndex={-1} className="mt-2 text-sm font-medium text-bad">{errs.top.steps}</p>}
            {!d.steps.length && !e("steps") && <p className="mt-2 text-sm text-muted">Nothing happens after the trigger yet.</p>}
          </li>
        </ol>
      </section>

      <Card>
        <CardHeader title="Behaviour" description="When contacts can enter, when they stop, and how much you review." />
        <CardBody className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Who can enter" description="What happens when a contact triggers it again.">
              {(a) => <Select {...a} value={d.entry_rule} onChange={(ev) => dispatch({ t: "set", patch: { entry_rule: ev.target.value as Draft["entry_rule"] } })}>{ENTRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
            </Field>
            {d.entry_rule === "after_days" && <Field label="Days between entries" error={e("entry_days")}>{(a) => <Input {...a} type="number" min={1} inputMode="numeric" value={d.entry_days} onChange={(ev) => dispatch({ t: "set", patch: { entry_days: ev.target.value } })} />}</Field>}
          </div>
          <div className="grid gap-3">
            <div className="flex items-start justify-between gap-3">
              <div><p id="goal-l" className="text-sm font-medium">Stop early when a contact does something</p><p id="goal-d" className="mt-0.5 text-xs text-muted">Contacts still inside leave the moment this event arrives, and their unsent emails are cancelled.</p></div>
              <Switch checked={d.goal !== null} onCheckedChange={(on) => dispatch({ t: "set", patch: { goal: on ? { events: "", filter: null } : null } })} aria-labelledby="goal-l" aria-describedby="goal-d" />
            </div>
            {d.goal && (
              <>
                <Field label="Exit event" error={e("goal")} description="Separate several names with commas.">{(a) => <Input {...a} mono list="trigger-events" placeholder="upgraded" value={d.goal!.events} onChange={(ev) => dispatch({ t: "set", patch: { goal: { ...d.goal!, events: ev.target.value } } })} />}</Field>
                <RuleEditor optional label="Only when" value={d.goal.filter} onChange={(filter) => dispatch({ t: "set", patch: { goal: { ...d.goal!, filter } } })} fields={fields} error={e("goal_filter")} />
              </>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Review before sending" description="Held emails wait in Approvals until you approve them.">
              {(a) => <Select {...a} value={d.approval.mode} onChange={(ev) => dispatch({ t: "set", patch: { approval: { ...d.approval, mode: ev.target.value as Draft["approval"]["mode"] } } })}>
                <option value="first_n">Review the first few sends</option><option value="always">Review every send</option><option value="never">Send without review</option></Select>}
            </Field>
            {d.approval.mode === "first_n" && <Field label="Sends to review" error={e("approval")}>{(a) => <Input {...a} type="number" min={1} inputMode="numeric" value={d.approval.n} onChange={(ev) => dispatch({ t: "set", patch: { approval: { ...d.approval, n: ev.target.value } } })} />}</Field>}
          </div>
        </CardBody>
      </Card>

      {state.error && <ErrorState error={state.error} />}

      <div className={cn("z-10 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-border bg-bg p-3 shadow-pop sm:sticky sm:bottom-3")}>
        <p role="status" aria-live="polite" className={cn("min-w-0 flex-1 text-sm", submitted && bad ? "font-medium text-bad" : "text-muted")}>
          {submitted && bad ? `${bad} thing${bad === 1 ? "" : "s"} to fix before saving.` : `${d.steps.length} step${d.steps.length === 1 ? "" : "s"}`}
        </p>
        {canPublish && d.trigger.kind === "segment" && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="backfill" checked={backfill} onChange={(ev) => setBackfill(ev.target.checked)} className="size-4 accent-[var(--accent)]" />Skip contacts already in the segment</label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost"><Link href={id ? `/automations/${encodeURIComponent(id)}` : "/automations"}>Cancel</Link></Button>
          {isLive ? <Button type="button" onClick={openConfirm}>Save new version</Button>
            : !canPublish ? <SubmitButton name="intent" value="save">Save new version</SubmitButton>
            : (
              <>
                <SubmitButton variant="secondary" name="intent" value="draft">{locked ? "Save draft" : "Save as draft"}</SubmitButton>
                <SubmitButton name="intent" value="publish">Save and publish</SubmitButton>
              </>
            )}
        </div>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent title="Save a new version of a live automation?" destructive={false} confirmLabel="Save new version"
          description={`New contacts use version ${(version ?? 0) + 1} immediately. Contacts already inside finish on version ${version}.`} onConfirm={() => form.current?.requestSubmit()} />
      </AlertDialog>
    </form>
    {wide && (
      <aside aria-labelledby="flow-preview-h" className="sticky top-16 grid max-h-[calc(100dvh-5rem)] gap-2 overflow-y-auto">
        <h2 id="flow-preview-h" className="text-md font-semibold">Live preview</h2>
        <FlowPreview definition={definition} stats={stats} />
      </aside>
    )}
    </div>
  );
}
