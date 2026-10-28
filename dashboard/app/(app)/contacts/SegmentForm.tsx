"use client";
import { Plus, Trash2 } from "lucide-react";
import { useActionState, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { toast } from "@/components/ui/toast";
import { formatNumber } from "@/lib/format";
import { addSegmentMembers, previewSegment, saveSegment, type FormState, type Preview } from "./actions";
import { ATTR_TYPES, type AttrType } from "./attrs";
import { FIELDS, SUBJECTS, fromRule, newCond, parseEmails, toRule, valueKind, type Builder, type Cond, type Subject } from "./segmentRules";
import type { Segment } from "./util";

type Suggest = { events: string[]; attrs: string[] };

function ConditionRow({ c, n, set, remove, error }: { c: Cond; n: number; set: (p: Partial<Cond>) => void; remove: () => void; error?: string }) {
  const subject = SUBJECTS.find((s) => s.value === c.subject)!, kind = valueKind(c), eid = `cond-err-${n}`;
  const lbl = (what: string) => `Condition ${n} ${what}`;
  const inv = error ? { "aria-invalid": true as const, "aria-describedby": eid } : {};
  return (
    <div role="group" aria-label={`Condition ${n}`} className="flex flex-wrap items-start gap-2 rounded-md border border-border p-2">
      <Select aria-label={lbl("type")} className="w-full sm:w-36" value={c.subject} onChange={(e) => set(newCond(e.target.value as Subject))}>
        {SUBJECTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </Select>
      {c.subject === "field" && (
        <Select aria-label={lbl("field")} className="w-full sm:w-36" value={c.key} onChange={(e) => set({ key: e.target.value })}>{FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
      )}
      {(c.subject === "attr" || c.subject === "event" || c.subject === "topic") && (
        <Input aria-label={lbl(c.subject === "attr" ? "attribute name" : c.subject === "event" ? "event name" : "topic key")} className="w-full sm:w-40 sm:flex-1" value={c.key} {...inv}
          list={c.subject === "event" ? "seg-events" : c.subject === "attr" ? "seg-attrs" : undefined} autoComplete="off" spellCheck={false}
          placeholder={c.subject === "attr" ? "attribute, e.g. plan" : c.subject === "event" ? "event, e.g. login" : "topic, e.g. digest"} onChange={(e) => set({ key: e.target.value })} />
      )}
      <Select aria-label={lbl("operator")} className="w-full sm:w-auto sm:min-w-44" value={c.op} onChange={(e) => set({ op: e.target.value })}>
        {subject.ops.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
      {kind === "typed" && (
        <>
          <Select aria-label={lbl("value type")} className="w-28" value={c.vtype} onChange={(e) => { const vtype = e.target.value as AttrType; set({ vtype, value: vtype === "boolean" ? "true" : c.value }); }}>
            {ATTR_TYPES.filter((t) => t.value !== "json").map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          {c.vtype === "boolean"
            ? <Select aria-label={lbl("value")} className="w-24" value={c.value} onChange={(e) => set({ value: e.target.value })}><option value="true">Yes</option><option value="false">No</option></Select>
            : <Input aria-label={lbl("value")} className="min-w-28 flex-1" value={c.value} {...inv} placeholder="value" autoComplete="off" onChange={(e) => set({ value: e.target.value })} />}
        </>
      )}
      {kind === "text" && <Input aria-label={lbl("value")} className="min-w-28 flex-1" value={c.value} {...inv} placeholder="value" autoComplete="off" onChange={(e) => set({ value: e.target.value })} />}
      {kind === "date" && <Input type="date" aria-label={lbl("date")} className="w-full sm:w-40" value={c.value} {...inv} onChange={(e) => set({ value: e.target.value })} />}
      {(kind === "days" || kind === "times") && (
        <span className="inline-flex items-center gap-2 text-sm text-muted">
          <Input type="number" min={kind === "times" ? 1 : 0} step={1} inputMode="numeric" aria-label={lbl(kind === "days" ? "number of days" : "number of times")} className="w-20" value={c.value} {...inv} onChange={(e) => set({ value: e.target.value })} />
          {kind === "days" ? "days" : "times"}
        </span>
      )}
      <Button variant="ghost" size="icon" aria-label={`Remove condition ${n}`} className="ml-auto" onClick={remove}><Trash2 aria-hidden /></Button>
      {error && <p id={eid} className="w-full text-xs font-medium text-bad">{error}</p>}
    </div>
  );
}

function Body({ segment, names, suggest, close }: { segment?: Segment; names: string[]; suggest: Suggest; close: () => void }) {
  const editing = !!segment;
  const [state, act] = useActionState<FormState, FormData>(saveSegment, {});
  const initial = useMemo(() => fromRule(segment?.filter), [segment]);
  const [name, setName] = useState(segment?.name ?? "");
  const [manual, setManual] = useState(editing && !segment.filter);
  const [json, setJson] = useState(initial ? "" : JSON.stringify(segment?.filter, null, 2));
  const [mode, setMode] = useState<"builder" | "json">(initial ? "builder" : "json");
  const [b, setB] = useState<Builder>(initial?.conds.length ? initial : { match: "and", conds: [newCond()] });
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState<Preview | "loading" | null>(null);
  const [switchErr, setSwitchErr] = useState("");

  // The filter we would save: null = nothing yet / invalid (with a reason), "manual" = no rules.
  const built = useMemo<{ filter: any; errors: Record<number, string>; message: string }>(() => {
    if (manual) return { filter: "manual", errors: {}, message: "" };
    if (mode === "builder") { const t = toRule(b); return { filter: t.rule, errors: t.errors, message: t.rule ? "" : b.conds.length ? "Finish the conditions to see who matches." : "Add a condition to see who matches." }; }
    if (!json.trim()) return { filter: null, errors: {}, message: "Enter the rules as JSON." };
    try { const v = JSON.parse(json); return v && typeof v === "object" && !Array.isArray(v) ? { filter: v, errors: {}, message: "" } : { filter: null, errors: {}, message: "The rules must be a JSON object." }; }
    catch (e) { return { filter: null, errors: {}, message: `Not valid JSON: ${(e as Error).message}` }; }
  }, [manual, mode, b, json]);

  const seq = useRef(0);
  const key = built.filter === "manual" || built.filter === null ? "" : JSON.stringify(built.filter);
  useEffect(() => {
    if (!key) { setPreview(null); return; }
    const mine = ++seq.current;
    setPreview("loading");
    const t = setTimeout(async () => { const p = await previewSegment(JSON.parse(key)); if (mine === seq.current) setPreview(p); }, 450);
    return () => clearTimeout(t);
  }, [key]);

  useEffect(() => {
    if (!state.ok) return;
    toast.success(state.ok);
    close();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const taken = names.includes(name.trim());
  function onSubmit(ev: FormEvent) {
    setAttempted(true);
    if (!name.trim() || taken || (built.filter === null)) ev.preventDefault();
  }
  const setCond = (i: number, p: Partial<Cond>) => setB({ ...b, conds: b.conds.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  function toBuilder() {
    let v: unknown;
    try { v = JSON.parse(json); } catch { setSwitchErr("Fix the JSON first."); return; }
    const parsed = fromRule(v);
    if (!parsed) { setSwitchErr("The builder cannot show these rules (not, in, or nested groups). Keep editing them as JSON."); return; }
    setSwitchErr(""); setB(parsed.conds.length ? parsed : { ...parsed, conds: [newCond()] }); setMode("builder");
  }
  const nameErr = (state.error?.field === "name" ? `${state.error.message}${state.error.hint ? ` ${state.error.hint}` : ""}` : undefined) ?? (attempted && !name.trim() ? "Give the segment a name." : taken ? "A segment with this name already exists." : undefined);
  const serverErr = state.error && state.error.field !== "name" ? state.error : null;

  return (
    <form action={act} onSubmit={onSubmit} noValidate className="grid gap-4">
      {segment && <input type="hidden" name="id" value={segment.id} />}
      <input type="hidden" name="filter" value={built.filter === "manual" || built.filter === null ? "" : JSON.stringify(built.filter)} />
      <Field label="Name" error={nameErr}>{(a) => <Input {...a} name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro customers" autoComplete="off" autoFocus={!editing} />}</Field>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">Who is in it</span>
        <SegmentedControl label="Segment type" value={manual ? "manual" : "rules"} onValueChange={(v) => setManual(v === "manual")} options={[{ value: "rules", label: "Matches rules" }, { value: "manual", label: "Manual list" }]} className="w-fit" />
        <p className="text-xs text-muted">{manual ? "You add the members yourself, by email address, after saving." : "Everyone who matches the rules is in. It updates as contacts change."}</p>
      </div>
      {!manual && (
        mode === "builder" ? (
          <fieldset className="grid gap-2">
            <legend className="sr-only">Rules</legend>
            {b.conds.length > 1 && (
              <label className="flex flex-wrap items-center gap-2 text-sm">Contacts must match
                <Select aria-label="Match all or any condition" className="w-auto" value={b.match} onChange={(e) => setB({ ...b, match: e.target.value as "and" | "or" })}><option value="and">all</option><option value="or">any</option></Select>
                of these:
              </label>
            )}
            {b.conds.map((c, i) => <ConditionRow key={i} c={c} n={i + 1} set={(p) => setCond(i, p)} error={attempted ? built.errors[i] : undefined} remove={() => setB({ ...b, conds: b.conds.filter((_, j) => j !== i) })} />)}
            <datalist id="seg-events">{suggest.events.map((e) => <option key={e} value={e} />)}</datalist>
            <datalist id="seg-attrs">{suggest.attrs.map((e) => <option key={e} value={e} />)}</datalist>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="secondary" size="sm" onClick={() => setB({ ...b, conds: [...b.conds, newCond()] })}><Plus aria-hidden />Add condition</Button>
              <Button variant="ghost" size="sm" onClick={() => { const r = toRule(b).rule; setJson(JSON.stringify(r ?? {}, null, 2)); setMode("json"); }}>Edit as JSON</Button>
            </div>
          </fieldset>
        ) : (
          <div className="grid gap-2">
            <Field label="Rules (JSON)" description={<>A tree of <code>and</code>, <code>or</code>, <code>not</code> and <code>{"{field, op, value}"}</code> tests. Fields: email, first_name, last_name, timezone, created_at, properties.&lt;key&gt;, topic:&lt;key&gt;, event_count:&lt;event&gt;, days_since:&lt;event&gt;.</>} error={built.filter === null && (attempted || json.trim()) ? built.message : undefined}>
              {(a) => <Textarea {...a} mono rows={8} value={json} spellCheck={false} onChange={(e) => { setJson(e.target.value); setSwitchErr(""); }} />}
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={toBuilder}>Use the builder</Button>
              {switchErr && <p role="alert" className="text-xs font-medium text-bad">{switchErr}</p>}
            </div>
          </div>
        )
      )}
      {!manual && (
        <div role="status" aria-live="polite" className="rounded-md border border-border bg-surface-2 p-3 text-sm">
          {preview === "loading" ? <span className="text-muted">Counting who matches…</span>
            : preview && preview.error ? <span className="text-bad">{preview.error.message}{preview.error.hint ? ` ${preview.error.hint}` : ""}</span>
            : preview ? (
              <>
                <p className="font-medium">{formatNumber(preview.count)} {preview.count === 1 ? "contact matches" : "contacts match"} right now</p>
                {preview.sample.length > 0 && <p className="mt-1 break-words text-xs text-muted">e.g. {preview.sample.map((s) => s.email).join(", ")}{preview.count > preview.sample.length ? ", …" : ""}</p>}
              </>
            ) : <span className="text-muted">{mode === "json" && json.trim() ? "Fix the rules to see who matches." : built.message}</span>}
        </div>
      )}
      {serverErr && <ErrorState error={serverErr} />}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
        <SubmitButton>{editing ? "Save changes" : "Create segment"}</SubmitButton>
      </div>
    </form>
  );
}

/** Create (no `segment`) or edit dialog; `children` is the trigger button. `names` = the other segments' names. */
export function SegmentDialog({ segment, names, events, attrs, children }: { segment?: Segment; names: string[]; events: string[]; attrs: string[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent title={segment ? `Edit ${segment.name}` : "New segment"} description="A saved group of contacts that automations can target." className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        <Body segment={segment} names={names.filter((n) => n !== segment?.name)} suggest={{ events, attrs }} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MembersBody({ segment, close }: { segment: Segment; close: () => void }) {
  const [state, act] = useActionState<FormState, FormData>(addSegmentMembers, {});
  const [text, setText] = useState("");
  const { emails, bad } = parseEmails(text);
  useEffect(() => {
    if (!state.ok) return;
    toast.success(state.ok);
    close();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const fieldErr = state.error?.field === "emails" ? state.error.message : bad.length ? `Not an email address: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ` and ${bad.length - 3} more` : ""}.` : undefined;
  return (
    <form action={act} className="grid gap-4">
      <input type="hidden" name="id" value={segment.id} />
      <Field label="Email addresses" description={`One per line, or separated by commas. ${emails.length ? `${formatNumber(emails.length)} ready to add.` : "People who are not contacts yet are created."}`} error={fieldErr}>
        {(a) => <Textarea {...a} name="emails" rows={6} mono value={text} spellCheck={false} placeholder={"ana@example.com\nben@example.com"} onChange={(e) => setText(e.target.value)} />}
      </Field>
      {state.error && state.error.field !== "emails" && <ErrorState error={state.error} />}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
        <SubmitButton disabled={!emails.length || bad.length > 0}>Add {emails.length || ""} {emails.length === 1 ? "contact" : "contacts"}</SubmitButton>
      </div>
    </form>
  );
}

/** Manual lists only: add members by email address. */
export function AddMembers({ segment, children }: { segment: Segment; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent title={`Add contacts to ${segment.name}`} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <MembersBody segment={segment} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
