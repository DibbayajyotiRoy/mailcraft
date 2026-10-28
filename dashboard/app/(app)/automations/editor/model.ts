// The automation editor's model, with no React in it: draft <-> API definition, reducer, validation.
// The draft is a flat, ordered list of steps (the trigger is separate). Every step "falls through" to the next
// one in the list; branches (condition true/false, wait event/timeout) and rare jumps are explicit edges that
// may only point forward, so every draft is an acyclic graph the API accepts.
import { flowSteps } from "../[id]/steps";

export type StepType = "send_email" | "delay" | "condition" | "wait_for_event" | "update_contact" | "add_to_segment" | "exit";
/** "next" = the following step in the list, "end" = the run completes, "to:<key>" = jump to a later step. */
export type Edge = string;
export type EStep = { key: string; type: StepType; config: Record<string, any>; edges: Record<string, Edge> };

export type RuleRow = { field: string; op: string; value: string };
export type RuleDraft = { mode: "and" | "or"; rows: RuleRow[] } | { raw: string };

export type EntryRule = "once" | "always" | "after_days" | "if_no_active_run";
export type Draft = {
  name: string;
  triggerKey: string;
  trigger: { kind: "event" | "segment"; events: string; segment: string; filter: RuleDraft | null };
  entry_rule: EntryRule;
  entry_days: string;
  approval: { mode: "first_n" | "always" | "never"; n: string };
  goal: { events: string; filter: RuleDraft | null } | null;
  /** Not editable here; sent back unchanged so an edit never drops it. */
  caps?: unknown;
  steps: EStep[];
};

export const STEP_TYPES: { type: StepType; label: string; hint: string }[] = [
  { type: "send_email", label: "Send email", hint: "Send a published template" },
  { type: "delay", label: "Wait", hint: "Pause for a fixed time" },
  { type: "wait_for_event", label: "Wait for event", hint: "Pause until the contact does something, or time runs out" },
  { type: "condition", label: "Condition", hint: "Branch on contact or event data" },
  { type: "update_contact", label: "Update contact", hint: "Set a property on the contact" },
  { type: "add_to_segment", label: "Add to segment", hint: "Put the contact in a segment" },
  { type: "exit", label: "End", hint: "Stop the journey here" },
];
export const typeLabel = (t: string) => STEP_TYPES.find((s) => s.type === t)?.label ?? t;

export const EDGE_NAMES: Record<StepType, string[]> = {
  send_email: ["next"], delay: ["next"], update_contact: ["next"], add_to_segment: ["next"],
  condition: ["true", "false"], wait_for_event: ["event", "timeout"], exit: [],
};
export const EDGE_DEFAULT: Record<string, Edge> = { next: "next", true: "next", false: "end", event: "next", timeout: "end" };
export const EDGE_LABEL: Record<string, string> = { next: "Then", true: "If yes", false: "If no", event: "If it happens", timeout: "If time runs out" };

export const MAX_WAIT_SECONDS = 30 * 86400;
export const MAX_INSTRUCTIONS = 1000;

// ---------------------------------------------------------------- durations (mirror of the API's `5m`, `2d`, `1h30m`)

const UNIT_SECS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
export const DURATION_UNITS: [string, string][] = [["m", "minutes"], ["h", "hours"], ["d", "days"], ["w", "weeks"]];

export function durationSecs(s: string): number | null {
  const t = s.trim();
  if (!/^(\d+[smhdw])+$/.test(t)) return null;
  return [...t.matchAll(/(\d+)([smhdw])/g)].reduce((n, m) => n + Number(m[1]) * UNIT_SECS[m[2]], 0);
}
/** `3d` -> {3, d}; anything else (empty, compound like 1h30m, seconds) is not a simple amount + unit. */
export function splitDuration(s: string): { amount: string; unit: string } | null {
  const m = /^(\d*)([mhdw])?$/.exec(s.trim());
  return m ? { amount: m[1], unit: m[2] ?? "d" } : null;
}
export function durationError(s: string): string | undefined {
  const n = durationSecs(s);
  if (n === null) return "Enter a whole number and a unit, like 3 days.";
  if (n > MAX_WAIT_SECONDS) return "The longest wait is 30 days.";
}

// ---------------------------------------------------------------- rules

export const RULE_OPS: [string, string][] = [
  ["eq", "is"], ["neq", "is not"], ["gt", "is greater than"], ["gte", "is at least"], ["lt", "is less than"], ["lte", "is at most"],
  ["in", "is one of"], ["contains", "contains"], ["exists", "exists"], ["not_exists", "does not exist"],
];
const NUMERIC_OPS = ["gt", "gte", "lt", "lte"];

/** Typed like JSON when it parses (42, true, "quoted", [1,2]), plain text otherwise. */
export function textToValue(t: string): unknown {
  const s = t.trim();
  try { return JSON.parse(s); } catch { return s; }
}
export function valueToText(v: unknown): string {
  if (typeof v === "string") return textToValue(v) === v ? v : JSON.stringify(v);
  if (Array.isArray(v)) return v.map(valueToText).join(", ");
  return v === undefined ? "" : JSON.stringify(v);
}
const listValue = (t: string): unknown[] => {
  const v = t.trim().startsWith("[") ? textToValue(t) : null;
  return Array.isArray(v) ? v : t.split(",").map((x) => x.trim()).filter(Boolean).map(textToValue);
};

const emptyRow = (): RuleRow => ({ field: "", op: "eq", value: "" });
export const newRuleDraft = (): RuleDraft => ({ mode: "and", rows: [emptyRow()] });

function rowToRule(r: RuleRow): any {
  if (r.op === "exists" || r.op === "not_exists") return { field: r.field.trim(), op: "exists", value: r.op === "exists" };
  return { field: r.field.trim(), op: r.op, value: r.op === "in" ? listValue(r.value) : textToValue(r.value) };
}
const isCmp = (r: any) => r && typeof r === "object" && typeof r.field === "string" && typeof r.op === "string";
const cmpToRow = (r: any): RuleRow => ({
  field: r.field, op: r.op === "exists" && r.value === false ? "not_exists" : r.op,
  value: r.op === "exists" ? "" : valueToText(r.value),
});

export function ruleToDraft(rule: any): RuleDraft | null {
  if (!rule || typeof rule !== "object") return null;
  if (isCmp(rule)) return { mode: "and", rows: [cmpToRow(rule)] };
  for (const mode of ["and", "or"] as const) {
    if (Array.isArray(rule[mode]) && Object.keys(rule).length === 1 && rule[mode].every(isCmp)) return rule[mode].length ? { mode, rows: rule[mode].map(cmpToRow) } : null;
  }
  return { raw: JSON.stringify(rule, null, 2) };
}
/** null = no rule. Throws on unparsable raw JSON (validate first). */
export function draftToRule(d: RuleDraft | null): any {
  if (!d) return null;
  if ("raw" in d) return JSON.parse(d.raw);
  const rows = d.rows.filter((r) => r.field.trim() || r.value.trim());
  if (!rows.length) return null;
  return rows.length === 1 ? rowToRule(rows[0]) : { [d.mode]: rows.map(rowToRule) };
}
export function ruleError(d: RuleDraft | null, required: boolean): string | undefined {
  if (!d || ("rows" in d && !d.rows.some((r) => r.field.trim() || r.value.trim()))) return required ? "Add at least one rule." : undefined;
  if ("raw" in d) {
    try { const v = JSON.parse(d.raw); return v && typeof v === "object" && !Array.isArray(v) ? undefined : "The rule must be a JSON object."; } catch { return "The rule is not valid JSON."; }
  }
  for (const [i, r] of d.rows.entries()) {
    const n = d.rows.length > 1 ? ` (rule ${i + 1})` : "";
    if (!r.field.trim()) return `Name the field to check${n}.`;
    if (r.op === "exists" || r.op === "not_exists") continue;
    if (!r.value.trim()) return `Give a value to compare with${n}.`;
    if (NUMERIC_OPS.includes(r.op) && typeof textToValue(r.value) !== "number") return `"${r.op === "gt" ? "greater than" : "less than"}" needs a number${n}.`;
    if (r.op === "in" && !listValue(r.value).length) return `List at least one value${n}.`;
  }
}

// ---------------------------------------------------------------- steps

const KEY_BASE: Record<StepType, string> = { send_email: "email", delay: "wait", condition: "check", wait_for_event: "wait_event", update_contact: "update", add_to_segment: "segment", exit: "end" };

export function newKey(d: Pick<Draft, "triggerKey" | "steps">, type: StepType): string {
  const used = new Set([d.triggerKey, ...d.steps.map((s) => s.key)]);
  for (let n = 1; ; n++) if (!used.has(`${KEY_BASE[type]}_${n}`)) return `${KEY_BASE[type]}_${n}`;
}

const defaultConfig = (t: StepType): Record<string, any> => ({
  send_email: { template: "", mode: "static" }, delay: { duration: "1d" }, condition: { rule: newRuleDraft() },
  wait_for_event: { event: "", timeout: "3d", filter: null }, update_contact: { pairs: [["", ""]] }, add_to_segment: { segment: "" }, exit: { reason: "" },
}[t]);
const defaultEdges = (t: StepType) => Object.fromEntries(EDGE_NAMES[t].map((n) => [n, EDGE_DEFAULT[n]]));

export const makeStep = (d: Pick<Draft, "triggerKey" | "steps">, type: StepType, config: Record<string, any> = {}): EStep =>
  ({ key: newKey(d, type), type, config: { ...defaultConfig(type), ...config }, edges: defaultEdges(type) });

export function stepSummary(s: EStep): string {
  const c = s.config;
  switch (s.type) {
    case "send_email": return `Send ${c.template || "email"}`;
    case "delay": return `Wait ${c.duration || "…"}`;
    case "wait_for_event": return `Wait for ${c.event || "event"}`;
    case "condition": return "Condition";
    case "update_contact": return "Update contact";
    case "add_to_segment": return `Add to ${c.segment || "segment"}`;
    default: return "End";
  }
}

// ---------------------------------------------------------------- reducer

export type Action =
  | { t: "set"; patch: Partial<Draft> }
  | { t: "trigger"; patch: Partial<Draft["trigger"]> }
  | { t: "add"; type: StepType; at?: number; config?: Record<string, any> }
  | { t: "remove"; key: string }
  | { t: "move"; key: string; dir: -1 | 1 }
  | { t: "patch"; key: string; config?: Record<string, any>; edges?: Record<string, Edge> };

/** A jump to a step that no longer exists falls back to the default for that edge. */
function repair(steps: EStep[]): EStep[] {
  const keys = new Set(steps.map((s) => s.key));
  return steps.map((s) => {
    const bad = Object.entries(s.edges).filter(([, e]) => e.startsWith("to:") && !keys.has(e.slice(3)));
    return bad.length ? { ...s, edges: { ...s.edges, ...Object.fromEntries(bad.map(([n]) => [n, EDGE_DEFAULT[n]])) } } : s;
  });
}

export function reduce(d: Draft, a: Action): Draft {
  switch (a.t) {
    case "set": return { ...d, ...a.patch };
    case "trigger": return { ...d, trigger: { ...d.trigger, ...a.patch } };
    case "add": {
      const steps = [...d.steps], at = Math.min(Math.max(a.at ?? steps.length, 0), steps.length);
      steps.splice(at, 0, makeStep(d, a.type, a.config));
      return { ...d, steps };
    }
    case "remove": return { ...d, steps: repair(d.steps.filter((s) => s.key !== a.key)) };
    case "move": {
      const i = d.steps.findIndex((s) => s.key === a.key), j = i + a.dir;
      if (i < 0 || j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    }
    case "patch": return { ...d, steps: d.steps.map((s) => (s.key === a.key ? { ...s, config: { ...s.config, ...a.config }, edges: { ...s.edges, ...a.edges } } : s)) };
  }
}

// ---------------------------------------------------------------- validation

export type Errors = { top: Record<string, string>; step: Record<string, Record<string, string>> };
export const countErrors = (e: Errors) => Object.keys(e.top).length + Object.values(e.step).reduce((n, s) => n + Object.keys(s).length, 0);

const eventList = (t: string) => t.split(",").map((x) => x.trim()).filter(Boolean);

export function validate(d: Draft): Errors {
  const top: Errors["top"] = {}, step: Errors["step"] = {};
  if (!d.name.trim()) top.name = "Give the automation a name.";
  else if (d.name.trim().length > 100) top.name = "Keep the name under 100 characters.";
  if (d.trigger.kind === "event") {
    const ev = eventList(d.trigger.events);
    if (!ev.length) top.trigger = "Enter the event that starts the automation.";
    else if (ev.some((e) => e.length > 128)) top.trigger = "Event names are at most 128 characters.";
  } else if (!d.trigger.segment.trim()) top.trigger = "Choose the segment contacts enter.";
  const tf = ruleError(d.trigger.filter, false);
  if (tf) top.trigger_filter = tf;
  if (d.entry_rule === "after_days" && !(Number(d.entry_days) > 0 && Number.isInteger(Number(d.entry_days)))) top.entry_days = "Enter a whole number of days.";
  if (d.approval.mode === "first_n" && !(Number(d.approval.n) >= 1 && Number.isInteger(Number(d.approval.n)))) top.approval = "Enter how many sends to review, 1 or more.";
  if (d.goal) {
    if (!eventList(d.goal.events).length) top.goal = "Enter the event that ends the journey, or turn this off.";
    const gf = ruleError(d.goal.filter, false);
    if (gf) top.goal_filter = gf;
  }
  if (!d.steps.length) top.steps = "Add at least one step.";

  d.steps.forEach((s, i) => {
    const e: Record<string, string> = {}, c = s.config;
    switch (s.type) {
      case "send_email":
        if (!String(c.template ?? "").trim()) e.template = "Choose a template.";
        if (c.from && !String(c.from).includes("@")) e.from = "Use an address like hello@yourdomain.com.";
        if (c.mode === "llm" && String(c.custom_instructions ?? "").trim().length > MAX_INSTRUCTIONS) e.custom_instructions = `Keep instructions under ${MAX_INSTRUCTIONS.toLocaleString("en")} characters.`;
        break;
      case "delay": { const m = durationError(String(c.duration ?? "")); if (m) e.duration = m; break; }
      case "wait_for_event": {
        if (!String(c.event ?? "").trim()) e.event = "Enter the event to wait for.";
        const m = durationError(String(c.timeout ?? "")); if (m) e.timeout = m;
        const f = ruleError(c.filter, false); if (f) e.filter = f;
        if (s.edges.event === "end" && s.edges.timeout === "end") e._ = "At least one outcome must continue; otherwise this is just an end.";
        break;
      }
      case "condition": { const m = ruleError(c.rule, true); if (m) e.rule = m; break; }
      case "update_contact":
        if (!c.pairs.some(([k]: string[]) => k.trim())) e.pairs = "Add a property to set.";
        else if (new Set(c.pairs.map(([k]: string[]) => k.trim()).filter(Boolean)).size < c.pairs.filter(([k]: string[]) => k.trim()).length) e.pairs = "Each property can be set once.";
        break;
      case "add_to_segment": if (!String(c.segment ?? "").trim()) e.segment = "Enter a segment name."; break;
    }
    for (const [name, edge] of Object.entries(s.edges)) {
      if (!edge.startsWith("to:")) continue;
      const j = d.steps.findIndex((x) => x.key === edge.slice(3));
      if (j <= i) e[`edge_${name}`] = j < 0 ? "That step no longer exists." : "Branches can only jump to a step further down.";
    }
    if (Object.keys(e).length) step[s.key] = e;
  });
  return { top, step };
}

/** Steps nothing leads to (their predecessors branch around them): saved, but they never run. */
export function unreachable(d: Draft): Set<string> {
  const reach = new Set<string>(), idx = new Map(d.steps.map((s, i) => [s.key, i]));
  const visit = (i: number) => {
    if (i < 0 || i >= d.steps.length || reach.has(d.steps[i].key)) return;
    reach.add(d.steps[i].key);
    for (const e of Object.values(d.steps[i].edges)) visit(e === "next" ? i + 1 : e.startsWith("to:") ? (idx.get(e.slice(3)) ?? -1) : -1);
  };
  visit(0);
  return new Set(d.steps.filter((s) => !reach.has(s.key)).map((s) => s.key));
}

// ---------------------------------------------------------------- draft -> API definition

const clean = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

function stepConfig(s: EStep): Record<string, any> {
  const c = s.config;
  switch (s.type) {
    case "send_email": {
      const llm = c.mode === "llm", { mode, instructions, custom_instructions, ...rest } = c;
      return clean({ ...rest, mode: llm ? "llm" : undefined, instructions: llm ? String(instructions ?? "").trim() : undefined, custom_instructions: llm ? String(custom_instructions ?? "").trim() : undefined,
        template: String(c.template).trim(), subject: String(c.subject ?? "").trim(), from: String(c.from ?? "").trim(), stream: c.stream });
    }
    case "delay": return { duration: String(c.duration).trim() };
    case "wait_for_event": return clean({ event: String(c.event).trim(), timeout: String(c.timeout).trim(), filter: draftToRule(c.filter) });
    case "condition": return { rule: draftToRule(c.rule) };
    case "update_contact": return { set: Object.fromEntries(c.pairs.filter(([k]: string[]) => k.trim()).map(([k, v]: string[]) => [k.trim(), textToValue(v)])) };
    case "add_to_segment": return { segment: String(c.segment).trim() };
    default: return clean({ reason: String(c.reason ?? "").trim() });
  }
}

export function toDefinition(d: Draft): Record<string, any> {
  const target = (i: number, e: Edge | undefined): string | undefined => (e === "end" ? undefined : e?.startsWith("to:") ? e.slice(3) : d.steps[i + 1]?.key);
  const steps = d.steps.map((s, i) => {
    const out: Record<string, any> = { key: s.key, type: s.type, config: stepConfig(s) };
    if (s.type === "exit") return out;
    if (s.type === "condition" || s.type === "wait_for_event") {
      out.next = Object.fromEntries(EDGE_NAMES[s.type].map((n) => [n, target(i, s.edges[n])]).filter(([, t]) => t));
    } else { const t = target(i, s.edges.next); if (t) out.next = t; }
    return out;
  });
  const ev = eventList(d.trigger.events);
  const tcfg: Record<string, any> = d.trigger.kind === "segment" ? { segment: d.trigger.segment.trim() } : ev.length > 1 ? { events: ev } : { event: ev[0] ?? "" };
  const filter = draftToRule(d.trigger.filter);
  if (filter) tcfg.filter = filter;
  const trigger: Record<string, any> = { key: d.triggerKey, type: "trigger", config: tcfg };
  if (steps[0]) trigger.next = steps[0].key;
  const out: Record<string, any> = {
    name: d.name.trim(), entry_rule: d.entry_rule, steps: [trigger, ...steps],
    approval: d.approval.mode === "first_n" ? `first_n:${Number(d.approval.n)}` : d.approval.mode,
  };
  if (d.entry_rule === "after_days") out.entry_days = Number(d.entry_days);
  if (d.goal) {
    const gev = eventList(d.goal.events), gf = draftToRule(d.goal.filter);
    out.goal = clean({ ...(gev.length > 1 ? { events: gev } : { event: gev[0] }), filter: gf });
  }
  if (d.caps && Object.keys(d.caps as object).length) out.caps = d.caps;
  return out;
}

// ---------------------------------------------------------------- API automation -> draft

const VISIT_ORDER = ["false", "timeout", "true", "event", "next"];

export function fromAutomation(a: any): Draft {
  const all: any[] = flowSteps(a);
  const trig = all.find((s) => s.type === "trigger");
  const rest = all.filter((s) => s !== trig), by = new Map(rest.map((s) => [s.key, s]));
  const cfg = trig?.config ?? {};
  const outs = (s: any): Record<string, string> => (s?.next == null ? {} : typeof s.next === "string" ? { next: s.next } : s.next);
  const root = typeof trig?.next === "string" ? trig.next : a?.steps?.[0]?.type === "trigger" ? undefined : rest[0]?.key;
  // Reverse post-order: each step lands after everything that leads to it, "yes"/"event" branches first.
  const seen = new Set<string>(), post: string[] = [];
  const visit = (k: string | undefined) => {
    if (!k || seen.has(k) || !by.has(k)) return;
    seen.add(k);
    const o = outs(by.get(k));
    for (const n of VISIT_ORDER) visit(o[n]);
    post.push(k);
  };
  visit(root);
  const order = [...post.reverse(), ...rest.map((s) => s.key).filter((k) => !seen.has(k))];
  const steps: EStep[] = order.map((k, i) => {
    const s = by.get(k), type = s.type as StepType, c = s.config ?? {}, o = outs(s);
    // A plain step with nothing after it falls through to "next" (= the end, until a step is added below it).
    const edges = Object.fromEntries(EDGE_NAMES[type].map((n) => [n, o[n] === undefined ? (n === "next" && i === order.length - 1 ? "next" : "end") : o[n] === order[i + 1] ? "next" : `to:${o[n]}`]));
    let config: Record<string, any> = { ...c };
    if (type === "condition") config = { rule: ruleToDraft(c.rule) ?? newRuleDraft() };
    if (type === "wait_for_event") config = { ...c, filter: ruleToDraft(c.filter) };
    if (type === "update_contact") config = { pairs: Object.entries(c.set ?? {}).map(([k2, v]) => [k2, valueToText(v)]) };
    return { key: s.key, type, config, edges };
  });
  const events = [cfg.event, ...(cfg.events ?? [])].filter(Boolean).join(", ");
  const g = a?.goal;
  const ap = String(a?.approval ?? "first_n:5"), n = /^first_n:(\d+)$/.exec(ap);
  return {
    name: a?.name ?? "", triggerKey: trig?.key ?? "trigger",
    trigger: { kind: cfg.segment ? "segment" : "event", events, segment: cfg.segment ?? "", filter: ruleToDraft(cfg.filter) },
    entry_rule: a?.entry_rule ?? "once", entry_days: a?.entry_days ? String(a.entry_days) : "",
    approval: n ? { mode: "first_n", n: n[1] } : { mode: ap === "never" ? "never" : ap === "always" ? "always" : "first_n", n: "5" },
    goal: g ? { events: [g.event, ...(g.events ?? [])].filter(Boolean).join(", "), filter: ruleToDraft(g.filter) } : null,
    caps: a?.caps && Object.keys(a.caps).length ? a.caps : undefined,
    steps,
  };
}

export const blankDraft = (): Draft => ({
  name: "", triggerKey: "trigger", trigger: { kind: "event", events: "", segment: "", filter: null },
  entry_rule: "once", entry_days: "", approval: { mode: "first_n", n: "5" }, goal: null, steps: [],
});

/** The API words its step errors as: step `email_1`: ... Pulls out the key so the message lands on that step. */
export const stepKeyInError = (message: string, keys: string[]): string | undefined => {
  const m = /step `([^`]+)`/.exec(message) ?? /(?:condition|wait_for_event|exit) `([^`]+)`/.exec(message);
  return m && keys.includes(m[1]) ? m[1] : undefined;
};
