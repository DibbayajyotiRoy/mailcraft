// The automation flowchart's model and layout, with no React in it.
//   buildFlow(automation, stats)  stored definition (or the editor's toDefinition output) -> nodes + labelled edges
//   layoutFlow(graph)             deterministic top-down layout: rows by longest path, branches as columns
// The connector curve (vertical tangents, handle length 0.55 of the drop, clamped 24..84) is adapted from Beautiful UI's
// Flowchart primitive, MIT License, Copyright (c) 2026 Turbo (https://beautifului.dev); the licence text is in Flowchart.tsx.
import { ruleWords } from "@/lib/rules";
import { durationWords, flowSteps, type Step } from "../[id]/steps";
import { NO_STAT, type StepStat } from "../editor/StepStats";

export type FlowKind = "trigger" | "send_email" | "delay" | "wait_for_event" | "condition" | "update_contact" | "add_to_segment" | "exit" | "unknown";
export type FlowNode = {
  id: string; kind: FlowKind;
  /** The kind pill above the card. */
  label: string;
  title: string; caption?: string;
  /** Machine-ish titles (event names, segments) render in the mono face. */
  mono?: boolean;
  ai?: boolean;
  stat?: StepStat;
  /** A branch that has no edge: the run ends there. Not a real step, so it is not clickable. */
  implicit?: boolean;
  /** Nothing leads here, so it never runs. */
  unreached?: boolean;
};
export type FlowEdge = { from: string; to: string; label?: string };
export type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[]; hasStats: boolean };

const KIND_LABEL: Record<FlowKind, string> = {
  trigger: "Trigger", send_email: "Send email", delay: "Wait", wait_for_event: "Wait for event", condition: "Condition",
  update_contact: "Update contact", add_to_segment: "Add to segment", exit: "End", unknown: "Step",
};
const EDGE_LABEL: Record<string, string> = { true: "Yes", false: "No", event: "Event", timeout: "Timeout" };
/** Left-to-right order of a step's outgoing edges, and the ones a branching step must have (a missing one means the run ends). */
const BRANCH_ORDER = ["true", "false", "event", "timeout"];
const BRANCHING: Partial<Record<FlowKind, string[]>> = { condition: ["true", "false"], wait_for_event: ["event", "timeout"] };

const list = (xs: string[]) => xs.join(", ");
const quoted = (s: unknown) => `“${String(s)}”`;

function describe(s: Step): Omit<FlowNode, "id" | "stat" | "unreached" | "implicit"> {
  const c = s.config ?? {};
  switch (s.type) {
    case "trigger": {
      const evs: string[] = [c.event, ...(c.events ?? [])].filter(Boolean), f = ruleWords(c.filter);
      return {
        kind: "trigger", label: KIND_LABEL.trigger, mono: true,
        title: evs.length ? evs.join(" or ") : c.segment ? String(c.segment) : "Not set yet",
        caption: `${c.segment && !evs.length ? "Contact enters this segment. " : ""}${f ? `Only when ${f}` : "No entry filter"}`.trim(),
      };
    }
    case "send_email":
      return { kind: "send_email", label: KIND_LABEL.send_email, title: c.template ? String(c.template) : "No template yet", mono: !!c.template, ai: c.mode === "llm", caption: c.from ? `From ${c.from}` : "Default sender" };
    case "delay":
      return { kind: "delay", label: KIND_LABEL.delay, title: `Wait ${durationWords(c.duration) || "…"}` };
    case "wait_for_event":
      return { kind: "wait_for_event", label: KIND_LABEL.wait_for_event, title: c.event ? String(c.event) : "No event yet", mono: !!c.event, caption: `Up to ${durationWords(c.timeout) || "…"}${ruleWords(c.filter) ? `, when ${ruleWords(c.filter)}` : ""}` };
    case "condition":
      return { kind: "condition", label: KIND_LABEL.condition, title: `If ${ruleWords(c.rule) ?? "no rule yet"}` };
    case "update_contact": {
      const pairs = Object.entries(c.set ?? {});
      return {
        kind: "update_contact", label: KIND_LABEL.update_contact, title: pairs.length ? `Set ${list(pairs.map(([k]) => k))}` : "Nothing set yet",
        caption: pairs.length ? list(pairs.slice(0, 2).map(([k, v]) => `${k} = ${String(v)}`)) + (pairs.length > 2 ? ` +${pairs.length - 2} more` : "") : undefined,
      };
    }
    case "add_to_segment":
      return { kind: "add_to_segment", label: KIND_LABEL.add_to_segment, title: c.segment ? String(c.segment) : "No segment yet", mono: !!c.segment };
    case "exit":
      return { kind: "exit", label: KIND_LABEL.exit, title: "Run ends", caption: c.reason ? String(c.reason) : undefined };
    default:
      return { kind: "unknown", label: KIND_LABEL.unknown, title: String(s.type ?? "Unknown step") };
  }
}

/** Outgoing edges of a step in display order: [name, target]. A plain string `next` is one unnamed edge. */
function outEdges(s: Step): [string | undefined, string][] {
  if (typeof s.next === "string") return [[undefined, s.next]];
  if (!s.next || typeof s.next !== "object") return [];
  const names = Object.keys(s.next);
  return [...BRANCH_ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !BRANCH_ORDER.includes(n))].map((n) => [n, (s.next as Record<string, string>)[n]]);
}

/**
 * `a` is a stored automation, or the editor's `toDefinition()` output (same shape). `stats` is the per-step map from
 * GET /v1/automations/{id}: pass null/undefined for "no stats" (no footer); a map shows counts, zeros for steps it lacks.
 */
export function buildFlow(a: any, stats?: Record<string, StepStat> | null): FlowGraph {
  const steps = flowSteps(a).filter((s, i, all) => s?.key && all.findIndex((x) => x.key === s.key) === i);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const trigger = steps.find((s) => s.type === "trigger");
  const edges: FlowEdge[] = [], nodes: FlowNode[] = [];
  // Same rule as the editor's fromAutomation: an old row whose trigger names no next step starts at its first step.
  const legacyRoot = trigger && trigger.next == null && a?.steps?.[0]?.type !== "trigger" ? steps.find((s) => s !== trigger)?.key : undefined;

  for (const s of steps) {
    const d = describe(s);
    nodes.push({ id: s.key, ...d, stat: stats ? (stats[s.key] ?? NO_STAT) : undefined });
    const raw: [string | undefined, string | undefined][] = s === trigger && legacyRoot ? [[undefined, legacyRoot]] : outEdges(s);
    // A branching step always shows both outcomes: one with no edge (or one pointing nowhere) is where the run ends,
    // drawn as a "Run ends" stub so a lone "Timeout" edge reads right.
    const names = typeof s.next === "string" ? undefined : BRANCHING[d.kind];
    const outs = names ? [...names.map((n): [string, string | undefined] => [n, (s.next as Record<string, string> | null | undefined)?.[n]]), ...raw.filter(([n]) => !names.includes(n!))] : raw;
    for (const [name, to] of outs) {
      const label = name ? EDGE_LABEL[name] ?? name : undefined;
      if (!to || to === s.key || !byKey.has(to)) {
        if (!names?.includes(name!)) continue;
        const id = `${s.key}:${name}:end`;
        nodes.push({ id, kind: "exit", label: KIND_LABEL.exit, title: "Run ends", implicit: true });
        edges.push({ from: s.key, to: id, label });
        continue;
      }
      const dup = edges.find((e) => e.from === s.key && e.to === to);
      if (dup) dup.label = [dup.label, label].filter(Boolean).join(" / ") || undefined; // both branches lead to the same step
      else edges.push({ from: s.key, to, label });
    }
  }
  // Steps nothing leads to are kept (the API stores them) but marked: they never run.
  const reached = new Set<string>(), walk = (k: string) => { if (reached.has(k)) return; reached.add(k); edges.filter((e) => e.from === k).forEach((e) => walk(e.to)); };
  if (trigger) walk(trigger.key);
  for (const n of nodes) if (trigger && !reached.has(n.id)) n.unreached = true;
  return { nodes, edges, hasStats: !!stats };
}

// ---------------------------------------------------------------- layout

export const NODE_W = 256, PILL_H = 30, GAP_X = 40, GAP_Y = 56, PAD = 24;
export const cardHeight = (hasStats: boolean) => (hasStats ? 118 : 80);
const PITCH = NODE_W + GAP_X;

export type Placed = FlowNode & { x: number; y: number; order: number };
export type PlacedEdge = FlowEdge & { d: string; at: { x: number; y: number } };
export type FlowLayout = { width: number; height: number; cardH: number; nodes: Placed[]; edges: PlacedEdge[] };

const handle = (ay: number, by: number) => Math.min(Math.max(Math.abs(by - ay) * 0.55, 24), 84);
const bez = (ax: number, ay: number, bx: number, by: number) => `C ${ax} ${ay + handle(ay, by)}, ${bx} ${by - handle(ay, by)}, ${bx} ${by}`;
const bezAt = (ax: number, ay: number, bx: number, by: number, t: number) => {
  const k = handle(ay, by), u = 1 - t;
  const f = (p0: number, p1: number, p2: number, p3: number) => u ** 3 * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t ** 3 * p3;
  return { x: f(ax, ax, bx, bx), y: f(ay, ay + k, by - k, by) };
};

/**
 * Rows are longest-path depth (a step sits below everything that leads to it). Each step's "main" parent is the one that
 * sets its row; the tree of main parents is laid out left to right in edge order (Yes before No), a parent centred over
 * its children, so branches become side-by-side columns and no two boxes in a row can touch. Any other edge into a step
 * (a merge) keeps its own lane: it runs straight down a column of its own and curves in at the end, never through a card.
 * Cycles cannot be saved, but a back edge is ignored rather than looping.
 */
export function layoutFlow(g: FlowGraph): FlowLayout {
  const cardH = cardHeight(g.hasStats), rowPitch = PILL_H + cardH + GAP_Y;
  const out = new Map<string, FlowEdge[]>(g.nodes.map((n) => [n.id, g.edges.filter((e) => e.from === n.id)]));
  const hasIn = new Set(g.edges.map((e) => e.to));
  const roots = g.nodes.filter((n, i) => i === 0 || !hasIn.has(n.id)).map((n) => n.id);

  // 1. depth-first from the roots: reading order, forward edges, topological order.
  const seq: string[] = [], post: string[] = [], seen = new Set<string>(), live = new Set<string>(), fwd = new Map<string, FlowEdge[]>();
  const visit = (id: string) => {
    seen.add(id); live.add(id); seq.push(id); fwd.set(id, []);
    for (const e of out.get(id) ?? []) {
      if (live.has(e.to)) continue;
      fwd.get(id)!.push(e);
      if (!seen.has(e.to)) visit(e.to);
    }
    live.delete(id); post.push(id);
  };
  for (const r of roots) if (!seen.has(r)) visit(r);
  for (const n of g.nodes) if (!seen.has(n.id)) { roots.push(n.id); visit(n.id); }

  // 2. rows.
  const row = new Map<string, number>(roots.map((r, i) => [r, i === 0 ? 0 : 1]));
  for (const id of [...post].reverse()) for (const e of fwd.get(id)!) row.set(e.to, Math.max(row.get(e.to) ?? 0, row.get(id)! + 1));

  // 3. main parent edge per step: the first (in reading order) that is exactly one row above.
  const main = new Map<string, FlowEdge>();
  for (const id of seq) for (const e of fwd.get(id)!) if (row.get(e.to) === row.get(id)! + 1 && !main.has(e.to)) main.set(e.to, e);

  // 4. columns: leaves take the next free slot; a parent sits over its first and last child.
  const col = new Map<string, number>(), lane = new Map<FlowEdge, number>();
  let free = 0;
  const place = (id: string): number => {
    const kids: number[] = [];
    for (const e of fwd.get(id)!) {
      if (main.get(e.to) === e) kids.push(place(e.to));
      else if (row.get(e.to)! - row.get(id)! > 1) { const c = free++ + 0.5; lane.set(e, c); kids.push(c); }
    }
    const c = kids.length ? (kids[0] + kids[kids.length - 1]) / 2 : free++ + 0.5;
    col.set(id, c);
    return c;
  };
  for (const r of roots) place(r);

  const cx = (c: number) => PAD + c * PITCH - GAP_X / 2;
  const top = (id: string) => PAD + row.get(id)! * rowPitch;
  const nodes: Placed[] = seq.map((id, order) => ({ ...g.nodes.find((n) => n.id === id)!, x: cx(col.get(id)!) - NODE_W / 2, y: top(id), order }));
  const edges: PlacedEdge[] = [];
  for (const id of seq) for (const e of fwd.get(id)!) {
    const sx = cx(col.get(id)!), sy = top(id) + PILL_H + cardH, ex = cx(col.get(e.to)!), ey = top(e.to) + PILL_H, l = lane.get(e);
    const head = `M ${ex - 4} ${ey - 6} L ${ex} ${ey} L ${ex + 4} ${ey - 6}`;
    if (l === undefined) { edges.push({ ...e, d: `M ${sx} ${sy} ${bez(sx, sy, ex, ey)} ${head}`, at: bezAt(sx, sy, ex, ey, 0.5) }); continue; }
    const lx = cx(l), y1 = top(id) + rowPitch, y2 = top(e.to) - rowPitch + PILL_H + cardH; // lane: first row below the source .. last row above the target
    edges.push({ ...e, d: `M ${sx} ${sy} ${bez(sx, sy, lx, y1)} L ${lx} ${y2} ${bez(lx, y2, ex, ey)} ${head}`, at: bezAt(sx, sy, lx, y1, 0.5) });
  }
  const maxRow = Math.max(0, ...nodes.map((n) => row.get(n.id)!));
  return { width: PAD * 2 + Math.max(1, free) * PITCH - GAP_X, height: PAD * 2 + maxRow * rowPitch + PILL_H + cardH, cardH, nodes, edges };
}

/** The words a screen reader gets for where a step leads: "Yes: Send email welcome. No: Run ends." */
export function leadsTo(g: FlowGraph, id: string): string {
  const title = (k: string) => { const n = g.nodes.find((x) => x.id === k)!; return `${n.label} ${n.title}`; };
  return g.edges.filter((e) => e.from === id).map((e) => `${e.label ? `${e.label}: ` : "Then: "}${title(e.to)}.`).join(" ");
}

/** "412 entered, 3 active, 396 completed, 4 failed, 9 exited." */
export const statWords = (s: StepStat) => `${s.entered} entered, ${s.active} active, ${s.completed} completed, ${s.failed} failed, ${s.exited} exited.`;
