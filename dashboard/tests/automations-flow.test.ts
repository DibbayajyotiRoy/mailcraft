import { describe, expect, it } from "vitest";
import { buildFlow, layoutFlow, leadsTo, NODE_W, PAD, statWords, type FlowGraph, type FlowLayout } from "@/app/(app)/automations/flow/flow";
import { toDefinition } from "@/app/(app)/automations/editor/model";
import { presetById } from "@/app/(app)/automations/editor/presets";

const stat = (entered: number, active: number, completed: number, exited: number, failed: number) => ({ entered, active, completed, exited, failed });
const trig = { key: "t", type: "trigger", config: { event: "signed_up" }, next: "a" };
const mail = (key: string, next?: any, config: any = {}) => ({ key, type: "send_email", config: { template: key, ...config }, ...(next ? { next } : {}) });
const placed = (l: FlowLayout, id: string) => l.nodes.find((n) => n.id === id)!;
const cx = (l: FlowLayout, id: string) => placed(l, id).x + NODE_W / 2;
const edge = (l: FlowLayout, from: string, to: string) => l.edges.find((e) => e.from === from && e.to === to)!;
/** No two boxes in a row overlap, and nothing sits outside the canvas. */
function expectClean(l: FlowLayout) {
  for (const a of l.nodes) {
    expect(a.x).toBeGreaterThanOrEqual(PAD);
    expect(a.x + NODE_W).toBeLessThanOrEqual(l.width - PAD + 0.001);
    for (const b of l.nodes) if (a !== b && a.y === b.y) expect(a.x + NODE_W <= b.x || b.x + NODE_W <= a.x).toBe(true);
  }
}

describe("buildFlow", () => {
  it("describes each step type in one line", () => {
    const g = buildFlow({ steps: [
      { key: "t", type: "trigger", config: { event: "signed_up", filter: { field: "contact.plan", op: "eq", value: "free" } }, next: "m" },
      { key: "m", type: "send_email", config: { template: "welcome", mode: "llm", from: "hello@x.dev" }, next: "d" },
      { key: "d", type: "delay", config: { duration: "2d" }, next: "u" },
      { key: "u", type: "update_contact", config: { set: { nudged: true, plan: "pro" } }, next: "s" },
      { key: "s", type: "add_to_segment", config: { segment: "nudged" }, next: "x" },
      { key: "x", type: "exit", config: { reason: "done" } },
    ] });
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.t).toMatchObject({ label: "Trigger", title: "signed_up" });
    expect(by.t.caption).toMatch(/^Only when .*plan.*free/);
    expect(by.m).toMatchObject({ label: "Send email", title: "welcome", caption: "From hello@x.dev", ai: true });
    expect(by.d).toMatchObject({ label: "Wait", title: "Wait 2 days" });
    expect(by.u).toMatchObject({ title: "Set nudged, plan", caption: "nudged = true, plan = pro" });
    expect(by.s).toMatchObject({ label: "Add to segment", title: "nudged" });
    expect(by.x).toMatchObject({ label: "End", title: "Run ends", caption: "done" });
    expect(g.nodes.every((n) => n.stat === undefined)).toBe(true);
    expect(g.hasStats).toBe(false);
  });

  it("covers a segment trigger, a missing template and a static email", () => {
    const g = buildFlow({ steps: [{ key: "t", type: "trigger", config: { segment: "vip" }, next: "a" }, mail("a", undefined, { template: "", mode: "static" })] });
    expect(g.nodes[0]).toMatchObject({ title: "vip" });
    expect(g.nodes[0].caption).toContain("enters this segment");
    expect(g.nodes[1]).toMatchObject({ title: "No template yet", caption: "Default sender", ai: false });
  });

  it("labels condition and wait_for_event edges, in Yes/No and Event/Timeout order", () => {
    const g = buildFlow({ steps: [
      { ...trig, next: "c" },
      { key: "c", type: "condition", config: { rule: { field: "plan", op: "eq", value: "free" } }, next: { false: "b", true: "a" } },
      mail("a", "w"), mail("b"),
      { key: "w", type: "wait_for_event", config: { event: "upgraded", timeout: "3d" }, next: { timeout: "b", event: "a2" } },
      mail("a2"),
    ] });
    expect(g.edges.filter((e) => e.from === "c").map((e) => [e.label, e.to])).toEqual([["Yes", "a"], ["No", "b"]]);
    expect(g.edges.filter((e) => e.from === "w").map((e) => [e.label, e.to])).toEqual([["Event", "a2"], ["Timeout", "b"]]);
    expect(g.nodes.find((n) => n.id === "w")).toMatchObject({ label: "Wait for event", title: "upgraded", caption: "Up to 3 days" });
  });

  it("draws a missing branch as an implicit end, so a lone timeout edge reads right", () => {
    const g = buildFlow({ steps: [{ ...trig, next: "w" }, { key: "w", type: "wait_for_event", config: { event: "x", timeout: "1d" }, next: { timeout: "m" } }, mail("m")] });
    const stub = g.nodes.find((n) => n.implicit)!;
    expect(stub).toMatchObject({ id: "w:event:end", title: "Run ends" });
    expect(g.edges.find((e) => e.to === stub.id)).toMatchObject({ from: "w", label: "Event" });
    // a plain step with nothing after it is just the last card: no stub
    expect(buildFlow({ steps: [trig, mail("a")] }).nodes.filter((n) => n.implicit)).toEqual([]);
  });

  it("merges two branches that lead to the same step into one edge", () => {
    const g = buildFlow({ steps: [{ ...trig, next: "c" }, { key: "c", type: "condition", config: {}, next: { true: "a", false: "a" } }, mail("a")] });
    expect(g.edges.filter((e) => e.from === "c")).toEqual([{ from: "c", to: "a", label: "Yes / No" }]);
  });

  it("maps stats by step key, zeros for steps the map lacks, and none at all when null", () => {
    const a = { steps: [trig, mail("a")] };
    const g = buildFlow(a, { t: stat(5, 0, 5, 0, 0), a: stat(5, 2, 2, 0, 1) });
    expect(g.hasStats).toBe(true);
    expect(g.nodes.map((n) => n.stat)).toEqual([stat(5, 0, 5, 0, 0), stat(5, 2, 2, 0, 1)]);
    expect(buildFlow(a, {}).nodes.map((n) => n.stat)).toEqual([stat(0, 0, 0, 0, 0), stat(0, 0, 0, 0, 0)]);
    expect(buildFlow(a, null).hasStats).toBe(false);
    expect(statWords(stat(412, 3, 396, 9, 4))).toBe("412 entered, 3 active, 396 completed, 4 failed, 9 exited.");
  });

  it("marks steps nothing leads to, and reads an old row whose trigger is top-level", () => {
    const g = buildFlow({ steps: [trig, mail("a"), mail("lost")] });
    expect(g.nodes.map((n) => !!n.unreached)).toEqual([false, false, true]);
    const old = buildFlow({ trigger: "signed_up", steps: [mail("a", "b"), mail("b")] });
    expect(old.nodes.map((n) => n.id)).toEqual(["trigger", "a", "b"]);
    expect(old.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["trigger>a", "a>b"]);
    expect(old.nodes.some((n) => n.unreached)).toBe(false);
  });

  it("ignores edges to steps that do not exist and to itself", () => {
    const g = buildFlow({ steps: [{ ...trig, next: "ghost" }, { ...mail("a"), next: "a" }] });
    expect(g.edges).toEqual([]);
  });

  it("describes where a step leads for screen readers", () => {
    const g = buildFlow({ steps: [{ ...trig, next: "c" }, { key: "c", type: "condition", config: {}, next: { true: "a", false: "b" } }, mail("a"), mail("b")] });
    expect(leadsTo(g, "c")).toBe("Yes: Send email a. No: Send email b.");
    expect(leadsTo(g, "t")).toBe("Then: Condition If no rule yet.");
    expect(leadsTo(g, "a")).toBe("");
  });

  it("reads the editor's draft through toDefinition, with end edges as run-ends", () => {
    const d = presetById("nudge")!.build(["winback"]);
    const g = buildFlow(toDefinition(d));
    expect(g.nodes.map((n) => n.label)).toEqual(["Trigger", "Wait for event", "End", "Send email"]);
    expect(g.nodes.filter((n) => n.implicit).map((n) => n.id)).toEqual(["wait_event_1:event:end"]); // the "event" outcome ends the run
  });
});

describe("layoutFlow", () => {
  it("stacks a linear flow in one column, one row per step, trigger at the top", () => {
    const l = layoutFlow(buildFlow({ steps: [trig, mail("a", "b"), mail("b", "c"), mail("c")] }));
    expect(l.nodes.map((n) => n.id)).toEqual(["t", "a", "b", "c"]);
    expect(new Set(l.nodes.map((n) => n.x)).size).toBe(1);
    const ys = l.nodes.map((n) => n.y);
    expect(ys).toEqual([...ys].sort((p, q) => p - q));
    expect(new Set(ys).size).toBe(4);
    expect(ys[0]).toBe(PAD);
    expect(l.width).toBe(PAD * 2 + NODE_W);
    expect(l.height).toBeGreaterThan(ys[3]);
    expect(l.edges).toHaveLength(3);
    expectClean(l);
  });

  it("puts condition branches side by side, Yes left of No, the condition centred over them", () => {
    const l = layoutFlow(buildFlow({ steps: [{ ...trig, next: "c" }, { key: "c", type: "condition", config: {}, next: { true: "y", false: "n" } }, mail("y"), mail("n")] }));
    expect(placed(l, "y").y).toBe(placed(l, "n").y);
    expect(cx(l, "y")).toBeLessThan(cx(l, "n"));
    expect(cx(l, "c")).toBeCloseTo((cx(l, "y") + cx(l, "n")) / 2);
    expect(cx(l, "t")).toBeCloseTo(cx(l, "c"));
    expect(l.nodes.map((n) => n.id)).toEqual(["t", "c", "y", "n"]); // reading order: the Yes branch before the No branch
    expect(edge(l, "c", "y").label).toBe("Yes");
    expect(edge(l, "c", "n").label).toBe("No");
    expect(edge(l, "c", "y").at.x).toBeLessThan(edge(l, "c", "n").at.x);
    expectClean(l);
  });

  it("lays a wait_for_event out with the timeout edge as its own column", () => {
    const l = layoutFlow(buildFlow({ steps: [{ ...trig, next: "w" }, { key: "w", type: "wait_for_event", config: { event: "x", timeout: "1d" }, next: { event: "a", timeout: "b" } }, mail("a"), mail("b")] }));
    expect(cx(l, "a")).toBeLessThan(cx(l, "b"));
    expect(edge(l, "w", "b").label).toBe("Timeout");
    expect(edge(l, "w", "a").label).toBe("Event");
    expectClean(l);
  });

  it("gives an implicit end its own column under the step", () => {
    const l = layoutFlow(buildFlow({ steps: [{ ...trig, next: "w" }, { key: "w", type: "wait_for_event", config: { event: "x", timeout: "1d" }, next: { timeout: "m" } }, mail("m")] }));
    expect(cx(l, "w:event:end")).toBeLessThan(cx(l, "m"));
    expect(placed(l, "w:event:end").y).toBe(placed(l, "m").y);
    expectClean(l);
  });

  it("keeps end steps at the bottom of their branch, one row below what leads to them", () => {
    const l = layoutFlow(buildFlow({ steps: [{ ...trig, next: "c" }, { key: "c", type: "condition", config: {}, next: { true: "a", false: "bye" } }, mail("a", "end"), { key: "end", type: "exit", config: {} }, { key: "bye", type: "exit", config: {} }] }));
    expect(placed(l, "end").y).toBeGreaterThan(placed(l, "a").y);
    expect(placed(l, "bye").y).toBe(placed(l, "a").y);
    expectClean(l);
  });

  it("sends a merge down its own lane, keeps the main column straight, and never overlaps a card", () => {
    // c: yes -> a -> b -> c2 -> end, no -> end (a long edge past three rows)
    const g = buildFlow({ steps: [{ ...trig, next: "c" }, { key: "c", type: "condition", config: {}, next: { true: "a", false: "end" } }, mail("a", "b"), mail("b", "c2"), mail("c2", "end"), { key: "end", type: "exit", config: {} }] });
    const l = layoutFlow(g);
    expect(cx(l, "a")).toBe(cx(l, "b"));
    expect(cx(l, "b")).toBe(cx(l, "c2"));
    expect(cx(l, "c2")).toBe(cx(l, "end")); // end hangs under the step that sets its row
    expect(placed(l, "end").y).toBeGreaterThan(placed(l, "c2").y);
    const no = edge(l, "c", "end");
    expect(no.d).toContain(" L "); // the lane: a straight run between two curves
    expect(no.at.x).toBeGreaterThan(cx(l, "c")); // No leaves to the right
    expectClean(l);
  });

  it("shares a merge step between branches without drawing it twice", () => {
    const l = layoutFlow(buildFlow({ steps: [{ ...trig, next: "c" }, { key: "c", type: "condition", config: {}, next: { true: "a", false: "b" } }, mail("a", "m"), mail("b", "m"), mail("m")] }));
    expect(l.nodes.filter((n) => n.id === "m")).toHaveLength(1);
    expect(l.edges.filter((e) => e.to === "m")).toHaveLength(2);
    expect(placed(l, "m").y).toBeGreaterThan(placed(l, "a").y);
    expectClean(l);
  });

  it("puts a step nothing leads to in its own column to the right", () => {
    const l = layoutFlow(buildFlow({ steps: [trig, mail("a"), mail("lost")] }));
    expect(cx(l, "lost")).toBeGreaterThan(cx(l, "a"));
    expectClean(l);
  });

  it("survives a cycle (never saved, but never an infinite loop)", () => {
    const g: FlowGraph = { hasStats: false, nodes: ["a", "b"].map((id) => ({ id, kind: "delay", label: "Wait", title: id })), edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    expect(layoutFlow(g).nodes).toHaveLength(2);
  });

  it("uses a taller card, and so a taller canvas, when stats show", () => {
    const plain = layoutFlow(buildFlow({ steps: [trig, mail("a")] })), withStats = layoutFlow(buildFlow({ steps: [trig, mail("a")] }, {}));
    expect(withStats.cardH).toBeGreaterThan(plain.cardH);
    expect(withStats.height).toBeGreaterThan(plain.height);
  });

  it("is deterministic and never overlaps on random acyclic graphs", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 40; round++) {
      const n = 3 + Math.floor(rnd() * 12);
      const steps: any[] = [{ key: "s0", type: "trigger", config: { event: "e" }, next: "s1" }];
      for (let i = 1; i < n; i++) {
        const fwd = () => `s${i + 1 + Math.floor(rnd() * Math.min(5, n - i))}`;
        const r = rnd();
        steps.push(r < 0.3 && i < n - 1 ? { key: `s${i}`, type: "condition", config: {}, next: { true: `s${i + 1}`, false: fwd() } }
          : r < 0.4 && i < n - 1 ? { key: `s${i}`, type: "wait_for_event", config: { event: "x", timeout: "1d" }, next: { timeout: fwd() } }
          : mail(`s${i}`, i < n - 1 && rnd() < 0.9 ? (rnd() < 0.7 ? `s${i + 1}` : fwd()) : undefined));
      }
      const g = buildFlow({ steps });
      const a = layoutFlow(g), b = layoutFlow(g);
      expect(b).toEqual(a);
      expectClean(a);
      for (const e of a.edges) expect(e.d).not.toContain("NaN");
      expect(a.nodes).toHaveLength(g.nodes.length);
    }
  });
});
