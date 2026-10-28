// Rule builder model for segments. The backend filter language (crates/mailcraft-automations/src/rules.rs):
//   {and:[..]} | {or:[..]} | {not:..} | {field, op, value}
//   fields: email first_name last_name timezone created_at, properties.<key>, topic:<key>, event_count:<name>, days_since:<name>
//   ops:    eq neq lt lte gt gte in contains exists
// The builder covers the common shapes (a flat all/any list of conditions) and round-trips them; anything else
// (not, in, nesting) is edited as JSON, so `fromRule` returns null for it.
import { type AttrType, coerce } from "./attrs";

export type Subject = "field" | "created" | "attr" | "event" | "topic";
export type Cond = { subject: Subject; key: string; op: string; value: string; vtype: AttrType };
export type Builder = { match: "and" | "or"; conds: Cond[] };

export const FIELDS = [["email", "Email"], ["first_name", "First name"], ["last_name", "Last name"], ["timezone", "Time zone"]] as const;
const TEXT_OPS = [["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["set", "is set"], ["unset", "is not set"]] as const;
const ATTR_OPS = [["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["gt", "is greater than"], ["gte", "is at least"], ["lt", "is less than"], ["lte", "is at most"], ["set", "is set"], ["unset", "is not set"]] as const;

export const SUBJECTS: { value: Subject; label: string; ops: readonly (readonly [string, string])[] }[] = [
  { value: "field", label: "Contact field", ops: TEXT_OPS },
  { value: "attr", label: "Attribute", ops: ATTR_OPS },
  { value: "event", label: "Event", ops: [["atleast", "happened at least N times"], ["within", "happened in the last N days"], ["notwithin", "has not happened in the last N days"], ["never", "has never happened"]] },
  { value: "created", label: "Added", ops: [["gt", "on or after"], ["lt", "before"]] },
  { value: "topic", label: "Topic", ops: [["subscribed", "is subscribed"], ["unsubscribed", "is unsubscribed"]] },
];

export const newCond = (subject: Subject = "attr"): Cond => ({
  subject, vtype: "text", value: "", key: subject === "field" ? "email" : "",
  op: SUBJECTS.find((s) => s.value === subject)!.ops[0][0],
});

export const needsValue = (c: Cond) => !["set", "unset", "never", "subscribed", "unsubscribed"].includes(c.op);
/** Which kind of value input the condition wants. */
export const valueKind = (c: Cond): "none" | "text" | "date" | "days" | "times" | "typed" =>
  !needsValue(c) ? "none" : c.subject === "created" ? "date" : c.subject === "event" ? (c.op === "atleast" ? "times" : "days") : c.subject === "attr" ? "typed" : "text";

type Rule = Record<string, unknown>;
const cmp = (field: string, op: string, value?: unknown): Rule => (value === undefined ? { field, op } : { field, op, value });

/** One condition -> rule, or an error message for the first field that is not usable yet. */
export function condToRule(c: Cond): { rule: Rule } | { error: string } {
  const k = c.key.trim();
  if ((c.subject === "attr" || c.subject === "event" || c.subject === "topic") && !k) return { error: c.subject === "attr" ? "Name the attribute." : c.subject === "event" ? "Name the event." : "Name the topic." };
  const field = c.subject === "created" ? "created_at" : c.subject === "field" ? k : c.subject === "attr" ? `properties.${k}` : c.subject === "topic" ? `topic:${k}` : "";
  if (c.op === "set" || c.op === "unset") return { rule: cmp(field, "exists", c.op === "set") };
  if (c.subject === "topic") return { rule: cmp(field, "eq", c.op === "subscribed") };
  if (c.subject === "event") {
    if (c.op === "never") return { rule: cmp(`event_count:${k}`, "eq", 0) };
    const n = Number(c.value);
    if (c.value.trim() === "" || !Number.isInteger(n) || n < (c.op === "atleast" ? 1 : 0)) return { error: c.op === "atleast" ? "Enter a whole number of times, 1 or more." : "Enter a whole number of days." };
    if (c.op === "atleast") return { rule: cmp(`event_count:${k}`, "gte", n) };
    const d = `days_since:${k}`;
    return { rule: c.op === "within" ? cmp(d, "lte", n) : { or: [cmp(d, "exists", false), cmp(d, "gt", n)] } };
  }
  if (c.subject === "created") return /^\d{4}-\d{2}-\d{2}$/.test(c.value) ? { rule: cmp(field, c.op, c.value) } : { error: "Pick a date." };
  if (c.subject === "field" && !c.value.trim()) return { error: "Enter a value." };
  const v = c.subject === "attr" ? coerce(c.value, c.vtype) : { value: c.value };
  if ("error" in v) return { error: v.error };
  if (c.subject === "attr" && c.vtype === "text" && !c.value) return { error: "Enter a value." };
  return { rule: cmp(field, c.op, v.value) };
}

/** `null` rule = no conditions yet. Errors are per condition index. */
export function toRule(b: Builder): { rule: Rule | null; errors: Record<number, string> } {
  const rules: Rule[] = [], errors: Record<number, string> = {};
  b.conds.forEach((c, i) => { const r = condToRule(c); if ("error" in r) errors[i] = r.error; else rules.push(r.rule); });
  if (Object.keys(errors).length || !rules.length) return { rule: null, errors };
  return { rule: rules.length === 1 ? rules[0] : { [b.match]: rules }, errors };
}

const isObj = (v: unknown): v is Rule => !!v && typeof v === "object" && !Array.isArray(v);
const isCmp = (r: unknown): r is { field: string; op: string; value?: unknown } => isObj(r) && typeof r.field === "string" && typeof r.op === "string" && Object.keys(r).every((k) => ["field", "op", "value"].includes(k));
const vtypeOf = (v: unknown): AttrType => (typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "text");

function condFrom(r: unknown): Cond | null {
  if (isObj(r) && Array.isArray(r.or) && r.or.length === 2) { // has-not-happened-in-N-days is {or:[missing, gt N]}
    const [a, b] = r.or;
    if (isCmp(a) && isCmp(b) && a.field === b.field && a.field.startsWith("days_since:") && a.op === "exists" && a.value === false && b.op === "gt" && Number.isInteger(b.value))
      return { ...newCond("event"), key: a.field.slice(11), op: "notwithin", value: String(b.value) };
  }
  if (!isCmp(r)) return null;
  const { field, op, value } = r;
  const text = (v: unknown) => (typeof v === "string" ? v : String(v));
  if (op === "exists" && typeof value === "boolean") {
    const base = field.startsWith("properties.") ? { ...newCond("attr"), key: field.slice(11) } : (["email", "first_name", "last_name", "timezone"] as string[]).includes(field) ? { ...newCond("field"), key: field } : null;
    return base && { ...base, op: value ? "set" : "unset" };
  }
  if (field.startsWith("properties.") && ATTR_OPS.some(([o]) => o === op) && !["set", "unset"].includes(op) && ["string", "number", "boolean"].includes(typeof value))
    return { ...newCond("attr"), key: field.slice(11), op, value: text(value), vtype: vtypeOf(value) };
  if ((["email", "first_name", "last_name", "timezone"] as string[]).includes(field) && ["eq", "neq", "contains"].includes(op) && typeof value === "string")
    return { ...newCond("field"), key: field, op, value };
  if (field === "created_at" && (op === "gt" || op === "lt") && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { ...newCond("created"), op, value };
  if (field.startsWith("topic:") && op === "eq" && typeof value === "boolean") return { ...newCond("topic"), key: field.slice(6), op: value ? "subscribed" : "unsubscribed" };
  if (field.startsWith("event_count:")) {
    const key = field.slice(12);
    if (op === "eq" && value === 0) return { ...newCond("event"), key, op: "never" };
    if (op === "gte" && Number.isInteger(value) && (value as number) >= 1) return { ...newCond("event"), key, op: "atleast", value: String(value) };
  }
  if (field.startsWith("days_since:") && op === "lte" && Number.isInteger(value)) return { ...newCond("event"), key: field.slice(11), op: "within", value: String(value) };
  return null;
}

/** null = this filter needs the JSON editor. A missing filter is an empty builder. */
export function fromRule(filter: unknown): Builder | null {
  if (filter == null) return { match: "and", conds: [] };
  if (isObj(filter) && (Array.isArray(filter.and) || Array.isArray(filter.or)) && Object.keys(filter).length === 1) {
    const match = Array.isArray(filter.and) ? "and" : "or";
    const items = (filter[match] as unknown[]);
    const single = items.length === 2 && match === "or" ? condFrom(filter) : null; // the not-within pair on its own
    if (single) return { match: "and", conds: [single] };
    const conds = items.map(condFrom);
    return conds.length && conds.every(Boolean) ? { match, conds: conds as Cond[] } : null;
  }
  const one = condFrom(filter);
  return one ? { match: "and", conds: [one] } : null;
}

/** "a@x.com, b@y.org" or one per line -> unique, lower-cased-for-comparison addresses; `bad` keeps what is not an address. */
export function parseEmails(text: string): { emails: string[]; bad: string[] } {
  const seen = new Set<string>(), emails: string[] = [], bad: string[] = [];
  for (const t of text.split(/[\s,;]+/).filter(Boolean)) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) bad.push(t);
    else if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); emails.push(t); }
  }
  return { emails, bad };
}
