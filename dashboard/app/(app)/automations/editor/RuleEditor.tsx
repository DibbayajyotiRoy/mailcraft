"use client";
import { useId } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/field";
import { newRuleDraft, RULE_OPS, type RuleDraft, type RuleRow } from "./model";

/** Contact / event fields the rules can read; the editor adds `clicked_step:<key>` and `event_count:<event>` for what the automation has. */
export const BASE_FIELDS = ["contact.email", "contact.first_name", "contact.last_name", "contact.timezone", "contact.plan", "event.plan", "sent_count:7d"];

/** Rows of `field · operator · value`, joined by all/any. A rule with nesting or `not` opens as JSON instead of losing its shape. */
export function RuleEditor({ label, value, onChange, fields, error, optional }: {
  label: string; value: RuleDraft | null; onChange: (v: RuleDraft | null) => void; fields: string[]; error?: string; optional?: boolean;
}) {
  const id = useId(), list = `${id}-fields`, err = error ? `${id}-err` : undefined;
  const setRow = (d: Extract<RuleDraft, { rows: RuleRow[] }>, i: number, patch: Partial<RuleRow>) => onChange({ ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <fieldset className="grid gap-2" aria-describedby={err}>
      <legend className="text-sm font-medium">{label}</legend>
      <datalist id={list}>{fields.map((f) => <option key={f} value={f} />)}</datalist>
      {!value && <div><Button size="sm" variant="secondary" onClick={() => onChange(newRuleDraft())}><Plus aria-hidden />{optional ? "Add a filter" : "Add a rule"}</Button></div>}
      {value && "raw" in value && (
        <>
          <p className="text-xs text-muted">This rule uses nested logic, so it is edited as JSON.</p>
          <Textarea mono rows={6} aria-label={`${label} (JSON)`} aria-invalid={error ? true : undefined} value={value.raw} onChange={(e) => onChange({ raw: e.target.value })} />
        </>
      )}
      {value && "rows" in value && (
        <>
          {value.rows.length > 1 && (
            <label className="flex flex-wrap items-center gap-2 text-sm">Match
              <Select className="w-auto" value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as "and" | "or" })}><option value="and">all</option><option value="or">any</option></Select>
              of these:
            </label>
          )}
          <ul className="grid gap-3 sm:gap-2">
            {value.rows.map((r, i) => (
              <li key={i} className="grid gap-1.5 rounded-md border border-border p-2 sm:grid-cols-[minmax(0,1fr)_9.5rem_minmax(0,1fr)_auto] sm:items-center sm:border-0 sm:p-0">
                <Input list={list} aria-label={`Field, rule ${i + 1}`} placeholder="contact.plan" mono value={r.field} onChange={(e) => setRow(value, i, { field: e.target.value })} />
                <Select aria-label={`Operator, rule ${i + 1}`} value={r.op} onChange={(e) => setRow(value, i, { op: e.target.value })}>{RULE_OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                {r.op === "exists" || r.op === "not_exists" ? <span className="hidden sm:block" /> : (
                  <Input aria-label={`Value, rule ${i + 1}`} placeholder={r.op === "in" ? "free, trial" : "pro"} value={r.value} onChange={(e) => setRow(value, i, { value: e.target.value })} />
                )}
                <Button size="icon" variant="ghost" aria-label={`Remove rule ${i + 1}`} onClick={() => onChange(value.rows.length > 1 ? { ...value, rows: value.rows.filter((_, j) => j !== i) } : null)}><X aria-hidden /></Button>
              </li>
            ))}
          </ul>
          <div><Button size="sm" variant="ghost" className="-ml-2" onClick={() => onChange({ ...value, rows: [...value.rows, { field: "", op: "eq", value: "" }] })}><Plus aria-hidden />Add rule</Button></div>
        </>
      )}
      {value && "raw" in value && <div><Button size="sm" variant="ghost" className="-ml-2" onClick={() => onChange(null)}><X aria-hidden />Remove {optional ? "filter" : "rule"}</Button></div>}
      {error && <p id={err} className="text-xs font-medium text-bad">{error}</p>}
    </fieldset>
  );
}
