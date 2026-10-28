import { describe, expect, it } from "vitest";
import {
  blankDraft, countErrors, draftToRule, durationError, durationSecs, fromAutomation, makeStep, reduce, ruleError, ruleToDraft, splitDuration,
  stepKeyInError, textToValue, toDefinition, unreachable, validate, valueToText, type Draft,
} from "@/app/(app)/automations/editor/model";
import { PRESETS, presetById } from "@/app/(app)/automations/editor/presets";
import { isSettled, logLine, stepLabel } from "@/app/(app)/automations/runlog";

// What GET /v1/automations/{id} returns for the "welcome" automation in the mock API.
const WELCOME = {
  id: "a1", name: "welcome", status: "active", current_version: 2, entry_rule: "once", approval: "first_n:5", goal: { event: "upgraded" }, caps: { daily_sends: 50 },
  steps: [
    { key: "start", type: "trigger", config: { event: "signed_up", filter: { field: "contact.plan", op: "eq", value: "free" } }, next: "mail" },
    { key: "mail", type: "send_email", config: { template: "welcome", mode: "llm", from: "hello@example.com", instructions: "Friendly and brief.", custom_instructions: "Never mention pricing." }, next: "wait" },
    { key: "wait", type: "delay", config: { duration: "2d" }, next: "check" },
    { key: "check", type: "condition", config: { rule: { and: [{ field: "contact.plan", op: "eq", value: "free" }, { field: "event_count:login", op: "lte", value: 3 }] } }, next: { true: "nudge", false: "end" } },
    { key: "nudge", type: "send_email", config: { template: "winback", subject: "Need a hand?", vars: { plan: "$event.plan" }, topic: "product" }, next: "tag" },
    { key: "tag", type: "update_contact", config: { set: { nudged: true, plan: "$event.plan" } }, next: "seg" },
    { key: "seg", type: "add_to_segment", config: { segment: "nudged" }, next: "end" },
    { key: "end", type: "exit", config: { reason: "flow complete" } },
  ],
};

describe("durations", () => {
  it("mirror the API's parser", () => {
    expect(durationSecs("5m")).toBe(300);
    expect(durationSecs("1h30m")).toBe(5400);
    expect(durationSecs("2d")).toBe(172800);
    for (const bad of ["", "d", "5", "5 minutes", "-1d", "1.5d"]) expect(durationSecs(bad)).toBeNull();
  });
  it("splits only simple amounts", () => {
    expect(splitDuration("3d")).toEqual({ amount: "3", unit: "d" });
    expect(splitDuration("")).toEqual({ amount: "", unit: "d" });
    expect(splitDuration("1h30m")).toBeNull();
    expect(splitDuration("45s")).toBeNull();
  });
  it("rejects nonsense and anything over 30 days", () => {
    expect(durationError("30d")).toBeUndefined();
    expect(durationError("31d")).toMatch(/30 days/);
    expect(durationError("4w3d")).toMatch(/30 days/);
    expect(durationError("soon")).toMatch(/whole number/);
  });
});

describe("rules", () => {
  it("types values like JSON and falls back to text", () => {
    expect(textToValue("42")).toBe(42);
    expect(textToValue("true")).toBe(true);
    expect(textToValue("pro")).toBe("pro");
    expect(textToValue('"42"')).toBe("42");
    expect(valueToText("42")).toBe('"42"');
    expect(valueToText("pro")).toBe("pro");
    expect(valueToText(["a", 2])).toBe("a, 2");
  });
  it.each([
    { field: "contact.plan", op: "eq", value: "pro" },
    { field: "event_count:login", op: "gte", value: 3 },
    { field: "contact.country", op: "in", value: ["DE", "FR"] },
    { field: "contact.name", op: "exists", value: true },
    { field: "contact.name", op: "exists", value: false },
    { and: [{ field: "a", op: "eq", value: 1 }, { field: "b", op: "contains", value: "x" }] },
    { or: [{ field: "a", op: "neq", value: "y" }, { field: "b", op: "lt", value: 2 }] },
  ])("round-trips %j through the draft", (rule) => {
    expect(draftToRule(ruleToDraft(rule))).toEqual(rule);
  });
  it("keeps nested rules as JSON instead of flattening them", () => {
    const nested = { and: [{ field: "a", op: "eq", value: 1 }, { not: { field: "b", op: "eq", value: 2 } }] };
    const d = ruleToDraft(nested);
    expect(d).toHaveProperty("raw");
    expect(draftToRule(d)).toEqual(nested);
  });
  it("validates rows", () => {
    expect(ruleError(null, true)).toMatch(/at least one/);
    expect(ruleError(null, false)).toBeUndefined();
    expect(ruleError({ mode: "and", rows: [{ field: "", op: "eq", value: "x" }] }, true)).toMatch(/field/);
    expect(ruleError({ mode: "and", rows: [{ field: "a", op: "eq", value: "" }] }, true)).toMatch(/value/);
    expect(ruleError({ mode: "and", rows: [{ field: "a", op: "gt", value: "lots" }] }, true)).toMatch(/number/);
    expect(ruleError({ mode: "and", rows: [{ field: "a", op: "exists", value: "" }] }, true)).toBeUndefined();
    expect(ruleError({ raw: "{nope" }, true)).toMatch(/JSON/);
  });
});

describe("draft <-> definition", () => {
  it("an existing automation survives load -> save unchanged", () => {
    const d = fromAutomation(WELCOME);
    expect(d.steps.map((s) => s.key)).toEqual(["mail", "wait", "check", "nudge", "tag", "seg", "end"]);
    expect(d.steps[2].edges).toEqual({ true: "next", false: "to:end" });
    expect(d.caps).toEqual({ daily_sends: 50 });
    const out = toDefinition(d);
    expect(out.steps).toEqual(WELCOME.steps);
    expect(out).toMatchObject({ name: "welcome", entry_rule: "once", approval: "first_n:5", goal: { event: "upgraded" }, caps: { daily_sends: 50 } });
  });
  it("keeps fields the editor has no control for (vars, topic) on a send step", () => {
    const d = fromAutomation(WELCOME);
    expect(toDefinition(d).steps[4].config).toEqual({ template: "winback", subject: "Need a hand?", vars: { plan: "$event.plan" }, topic: "product" });
  });
  it("orders a diamond so every jump points forward", () => {
    const a = { name: "d", steps: [
      { key: "t", type: "trigger", config: { event: "e" }, next: "c" },
      { key: "c", type: "condition", config: { rule: { field: "contact.x", op: "exists" } }, next: { true: "b", false: "c2" } },
      { key: "b", type: "delay", config: { duration: "1d" }, next: "d" },
      { key: "c2", type: "delay", config: { duration: "2d" }, next: "d" },
      { key: "d", type: "exit" },
    ] };
    const d = fromAutomation(a);
    expect(d.steps.map((s) => s.key)).toEqual(["c", "b", "c2", "d"]);
    expect(d.steps[1].edges.next).toBe("to:d");
    expect(validate(d).step).toEqual({});
    const out: { key: string }[] = toDefinition(d).steps;
    expect(out.find((s) => s.key === "b")).toMatchObject({ next: "d" });
    expect(out.find((s) => s.key === "c")).toMatchObject({ next: { true: "b", false: "c2" } });
  });
  it("loads old rows that only have a top-level trigger", () => {
    const d = fromAutomation({ name: "old", trigger: "signed_up", steps: [{ key: "m", type: "send_email", config: { template: "w" } }] });
    expect(d.trigger.events).toBe("signed_up");
    expect(toDefinition(d).steps[0]).toEqual({ key: "trigger", type: "trigger", config: { event: "signed_up" }, next: "m" });
  });
  it("a loaded last step just falls through, so a step added under it follows it", () => {
    let d = fromAutomation({ name: "x", steps: [{ key: "t", type: "trigger", config: { event: "e" }, next: "m" }, { key: "m", type: "send_email", config: { template: "w" } }] });
    expect(d.steps[0].edges).toEqual({ next: "next" });
    d = reduce(d, { t: "add", type: "delay" });
    expect(toDefinition(d).steps[1]).toMatchObject({ key: "m", next: "wait_1" });
  });
  it("sends several trigger events as `events` and a segment as `segment`", () => {
    const d = blankDraft();
    d.trigger.events = "a, b";
    expect(toDefinition(d).steps[0].config).toEqual({ events: ["a", "b"] });
    d.trigger = { ...d.trigger, kind: "segment", segment: "vip" };
    expect(toDefinition(d).steps[0].config).toEqual({ segment: "vip" });
  });
  it("omits AI-only fields on static sends and trims what it keeps", () => {
    const d = blankDraft();
    d.steps = [makeStep(d, "send_email", { template: " w ", mode: "static", custom_instructions: "left over", subject: "" })];
    expect(toDefinition(d).steps[1].config).toEqual({ template: "w" });
    d.steps[0].config.mode = "llm";
    expect(toDefinition(d).steps[1].config).toEqual({ template: "w", mode: "llm", custom_instructions: "left over" });
  });
});

describe("reducer", () => {
  const base = (): Draft => {
    let d = blankDraft();
    for (const t of ["send_email", "delay", "send_email"] as const) d = reduce(d, { t: "add", type: t });
    return d;
  };
  it("adds at the end, or inserts at an index, with unique keys", () => {
    let d = base();
    expect(d.steps.map((s) => s.key)).toEqual(["email_1", "wait_1", "email_2"]);
    d = reduce(d, { t: "add", type: "delay", at: 1 });
    expect(d.steps.map((s) => s.key)).toEqual(["email_1", "wait_2", "wait_1", "email_2"]);
    expect(reduce(d, { t: "add", type: "exit", at: 99 }).steps.at(-1)?.type).toBe("exit");
  });
  it("moves up and down, and ignores moves off the ends", () => {
    const d = base();
    expect(reduce(d, { t: "move", key: "wait_1", dir: -1 }).steps.map((s) => s.key)).toEqual(["wait_1", "email_1", "email_2"]);
    expect(reduce(d, { t: "move", key: "wait_1", dir: 1 }).steps.map((s) => s.key)).toEqual(["email_1", "email_2", "wait_1"]);
    expect(reduce(d, { t: "move", key: "email_1", dir: -1 })).toBe(d);
    expect(reduce(d, { t: "move", key: "email_2", dir: 1 })).toBe(d);
  });
  it("deleting a jump target resets the jump", () => {
    let d = blankDraft();
    for (const t of ["condition", "delay", "exit"] as const) d = reduce(d, { t: "add", type: t });
    d = reduce(d, { t: "patch", key: "check_1", edges: { false: "to:end_1" } });
    expect(d.steps[0].edges.false).toBe("to:end_1");
    d = reduce(d, { t: "remove", key: "end_1" });
    expect(d.steps[0].edges.false).toBe("end");
  });
  it("a branch that ends up pointing upward is reported, not saved", () => {
    let d = blankDraft();
    for (const t of ["condition", "delay", "delay"] as const) d = reduce(d, { t: "add", type: t });
    d = reduce(d, { t: "patch", key: "check_1", edges: { false: "to:wait_2" } });
    expect(validate(d).step.check_1?.edge_false).toBeUndefined();
    d = reduce(d, { t: "move", key: "wait_2", dir: -1 }); // wait_2 now sits right under the condition... still below
    d = reduce(d, { t: "move", key: "wait_2", dir: -1 }); // ...and now above it
    expect(validate(d).step.check_1?.edge_false).toMatch(/further down/);
  });
  it("flags steps that branches skip", () => {
    let d = blankDraft();
    for (const t of ["condition", "delay", "exit"] as const) d = reduce(d, { t: "add", type: t });
    d = reduce(d, { t: "patch", key: "check_1", edges: { true: "to:end_1" } });
    expect([...unreachable(d)]).toEqual(["wait_1"]);
  });
});

describe("validate", () => {
  it("asks for the basics on a blank draft", () => {
    const e = validate(blankDraft());
    expect(Object.keys(e.top).sort()).toEqual(["name", "steps", "trigger"]);
  });
  it("checks each step type", () => {
    let d: Draft = { ...blankDraft(), name: "x", trigger: { kind: "event", events: "e", segment: "", filter: null } };
    for (const t of ["send_email", "delay", "wait_for_event", "condition", "update_contact", "add_to_segment"] as const) d = reduce(d, { t: "add", type: t });
    d = reduce(d, { t: "patch", key: "wait_1", config: { duration: "40d" } });
    d = reduce(d, { t: "patch", key: "email_1", config: { from: "nobody", mode: "llm", custom_instructions: "x".repeat(1001) } });
    const e = validate(d).step;
    expect(e.email_1).toMatchObject({ template: expect.any(String), from: expect.stringMatching(/address/), custom_instructions: expect.stringMatching(/1,000/) });
    expect(e.wait_1.duration).toMatch(/30 days/);
    expect(e.wait_event_1).toMatchObject({ event: expect.any(String) });
    expect(e.check_1.rule).toBeTruthy();
    expect(e.update_1.pairs).toBeTruthy();
    expect(e.segment_1.segment).toBeTruthy();
  });
  it("refuses a wait whose outcomes both end", () => {
    let d: Draft = { ...blankDraft(), name: "x", trigger: { kind: "event", events: "e", segment: "", filter: null } };
    d = reduce(d, { t: "add", type: "wait_for_event", config: { event: "go" } });
    d = reduce(d, { t: "patch", key: "wait_event_1", edges: { event: "end", timeout: "end" } });
    expect(validate(d).step.wait_event_1._).toMatch(/continue/);
  });
  it("only wants a day count for after_days, and a positive review count", () => {
    const d: Draft = { ...blankDraft(), entry_rule: "after_days", approval: { mode: "first_n", n: "0" } };
    const e = validate(d).top;
    expect(e.entry_days).toBeTruthy();
    expect(e.approval).toBeTruthy();
    expect(validate({ ...d, entry_rule: "once", approval: { mode: "never", n: "" } }).top.entry_days).toBeUndefined();
  });
  it("counts problems", () => {
    expect(countErrors(validate(blankDraft()))).toBe(3);
  });
});

describe("starter templates", () => {
  it("there are three, each complete except for a template it could not pick", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["welcome", "nudge", "reengage"]);
    for (const p of PRESETS) {
      const d = p.build([]);
      expect(d.name).toBeTruthy();
      const e = validate(d);
      expect(Object.keys(e.top)).toEqual([]);
      for (const [key, fields] of Object.entries(e.step)) expect(Object.keys(fields), key).toEqual(["template"]);
    }
  });
  it("pick a published template by name and then validate clean", () => {
    for (const [id, alias] of [["welcome", "welcome"], ["nudge", "onboarding-nudge"], ["reengage", "winback"]] as const) {
      const d = presetById(id)!.build(["receipt", alias]);
      expect(countErrors(validate(d)), id).toBe(0);
      const out = toDefinition(d);
      expect(out.steps[0]).toMatchObject({ type: "trigger", next: d.steps[0].key });
      expect(out.steps.some((s: { config: { template?: string } }) => s.config.template === alias)).toBe(true);
    }
  });
  it("welcome sends one email on signed_up", () => {
    expect(toDefinition(presetById("welcome")!.build(["welcome"]))).toEqual({
      name: "welcome", entry_rule: "once", approval: "first_n:5",
      steps: [{ key: "trigger", type: "trigger", config: { event: "signed_up" }, next: "email_1" }, { key: "email_1", type: "send_email", config: { template: "welcome" } }],
    });
  });
  it("the nudge ends when the event happens and sends when time runs out", () => {
    const steps = toDefinition(presetById("nudge")!.build(["nudge"])).steps;
    expect(steps[1]).toEqual({ key: "wait_event_1", type: "wait_for_event", config: { event: "activated", timeout: "3d" }, next: { timeout: "email_1" } });
  });
});

describe("api errors", () => {
  it("finds the step an error names", () => {
    const keys = ["email_1", "wait_1"];
    expect(stepKeyInError("automation `x`: step `email_1`: template `t` does not exist", keys)).toBe("email_1");
    expect(stepKeyInError("automation `x`: condition `wait_1` needs next {true, false} edges", keys)).toBe("wait_1");
    expect(stepKeyInError("automation `x`: step `gone`: nope", keys)).toBeUndefined();
    expect(stepKeyInError("rate limited", keys)).toBeUndefined();
  });
});

describe("run log", () => {
  it("explains each engine decision in a sentence", () => {
    expect(logLine({ step_key: "m", at: "", result: { decision: "enqueued", email_id: "em_1", status: "queued", subject: "Hi" } })).toEqual({ status: "queued", text: "Email queued: “Hi”", href: "/emails/em_1" });
    expect(logLine({ step_key: "m", at: "", result: { decision: "enqueued", email_id: "em_1", status: "pending_approval", subject: "Hi" } })).toMatchObject({ status: "pending_approval", href: "/approvals" });
    expect(logLine({ step_key: "m", at: "", result: { decision: "deferred", gate: "quiet_hours", until: "2026-10-28T08:00:00Z" } }).text).toBe("Held by quiet hours until 2026-10-28 08:00:00 UTC");
    expect(logLine({ step_key: "c", at: "", result: { outcome: false } }).text).toBe("Condition was no");
    expect(logLine({ step_key: "w", at: "", result: { outcome: "timeout" } }).text).toMatch(/Timed out/);
    expect(logLine({ step_key: "w", at: "", result: { decision: "error", error: "boom", failed: false } }).text).toBe("Error: boom (will retry)");
    expect(logLine({ step_key: "_goal", at: "", result: { decision: "exit", reason: "goal" } })).toEqual({ status: "exited", text: "Exited: goal" });
  });
  it("names steps by key and type, and system rows plainly", () => {
    expect(stepLabel("m", { m: "send_email" })).toBe("m · send email");
    expect(stepLabel("_end", {})).toBe("end");
  });
  it("stops polling once finished or parked on a timer", () => {
    const now = Date.parse("2026-10-28T10:00:00Z");
    expect(isSettled({ state: "completed" }, now)).toBe(true);
    expect(isSettled({ state: "waiting", next_wake_at: "2026-10-30T10:00:00Z" }, now)).toBe(true);
    expect(isSettled({ state: "active", next_wake_at: "2026-10-28T10:00:01Z" }, now)).toBe(false);
    expect(isSettled({ state: "active", next_wake_at: "2026-10-28T18:00:00Z" }, now)).toBe(true);
  });
});
