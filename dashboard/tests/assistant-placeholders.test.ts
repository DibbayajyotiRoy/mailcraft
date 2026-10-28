// The placeholder detector (what blocks Apply), the pure variable helpers, and the bounds on user-supplied text.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mentionedSend } from "@/lib/assistant/prefetch";
import { findPlaceholders, isReserved, plainValues, varNames } from "@/lib/assistant/variables";
import { text } from "./assistant-kit";

// [value, gaps found]: stand-ins that must block Apply, and ordinary text that must not.
const POSITIVE: [string, string[]][] = [
  ["[add signup link]", ["[add signup link]"]],
  ["Join here: [Add signup link]", ["[Add signup link]"]],
  ["[Your Company]", ["[Your Company]"]],
  ["[insert price]", ["[insert price]"]],
  ["[SIGNUP_LINK]", ["[SIGNUP_LINK]"]],
  ["[name]", ["[name]"]],
  ["[URL]", ["[URL]"]],
  ["[TBD]", ["[TBD]", "TBD"]],
  ["[add\nsignup link]", ["[add\nsignup link]"]], // a newline inside the brackets
  ["［add signup link］", ["[add signup link]"]], // full-width brackets, folded by NFKC
  ["{{ signup_link }}", ["{{ signup_link }}"]], // an unrendered variable
  ["<add signup link>", ["<add signup link>"]],
  ["<Insert URL here>", ["<Insert URL here>"]],
  ["Price: TODO", ["TODO"]],
  ["XXX", ["XXX"]],
  ["see [add a] and [add b]", ["[add a]", "[add b]"]],
];
const NEGATIVE = ["[Beta] Invite", "[URGENT] Your invoice", "Re: [Acme Newsletter] October", "https://example.com/list?filter[type]=1", "[John]", "Hello Bipul", "", "a [b] c", "(add signup link)", "<b>bold</b>", "<p>Hello</p>", "10 < 20 and 30 > 5", "[1]"];

test("placeholder detector: gaps are found, ordinary brackets pass", () => {
  for (const [v, want] of POSITIVE) expect(findPlaceholders(v), v).toEqual(want);
  for (const v of NEGATIVE) expect(findPlaceholders(v), v).toEqual([]);
});

test("worker-injected names are never the assistant's to fill; names come from strings or {name} objects", () => {
  for (const n of ["unsubscribe_url", "preferences_url", "workspace", "workspace.name", "mc_footer"]) expect(isReserved(n), n).toBe(true);
  for (const n of ["first_name", "last_name", "email", "signup_link", "data.city", "workspace_name"]) expect(isReserved(n), n).toBe(false);
  expect(varNames(["first_name", { name: "signup_link" }, "unsubscribe_url", "workspace.name", "first_name", "", 7, null])).toEqual(["first_name", "signup_link"]);
  expect(varNames(undefined)).toEqual([]);
});

test("variable values: scalars pass through unchanged (false stays false), null is empty, objects and lists are an error to correct", () => {
  expect(plainValues({ a: "x", n: 3, off: false, none: null }, "v")).toEqual({ ok: { a: "x", n: 3, off: false, none: "" } });
  expect(plainValues(undefined, "v")).toEqual({ ok: {} });
  expect(plainValues({ a: { b: 1 } }, "template.variables")).toEqual({ error: "template.variables.a must be text, a number or true/false, not an object." });
  expect(plainValues({ a: [1] }, "v")).toEqual({ error: "v.a must be text, a number or true/false, not a list." });
  expect(plainValues(["x"], "v")).toMatchObject({ error: expect.stringContaining("object") });
});

// ---- bounded on user input ------------------------------------------------------------------------------------------------------------------------

const timed = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };
test("a huge message cannot stall the event loop: mention parsing and placeholder scanning stay linear", () => {
  const hostile = ["a".repeat(100_000), "a@".repeat(50_000), "a.".repeat(50_000), "@template:" + "a".repeat(100_000), "a@b" + ".c".repeat(50_000), "[".repeat(100_000), "{{".repeat(50_000), "<add ".repeat(20_000), ("x" + "-".repeat(60) + "@").repeat(2_000)];
  for (const h of hostile) {
    expect(timed(() => mentionedSend(h)), `mentionedSend ${h.slice(0, 12)}`).toBeLessThan(50);
    expect(timed(() => findPlaceholders(h)), `findPlaceholders ${h.slice(0, 12)}`).toBeLessThan(200);
  }
});

test("mention parsing only looks at the first 4000 characters, and bounds each part of an address", () => {
  expect(mentionedSend("x".repeat(4000) + " Send @template:welcome to a@example.com")).toBeNull();
  expect(mentionedSend(`Send @template:welcome to ${"a".repeat(65)}@example.com`)?.to).toEqual([`${"a".repeat(64)}@example.com`]); // only the last 64 characters can be a local part
});

// ---- the route refuses an oversized message -------------------------------------------------------------------------------------------------------

beforeEach(() => { process.env.OPENROUTER_API_KEY = "or-key"; (globalThis as any).__mcModels = { at: Date.now(), v: { ids: ["m1:free"], source: "openrouter" } }; });
afterEach(() => { delete process.env.OPENROUTER_API_KEY; vi.unstubAllGlobals(); vi.resetModules(); });

test("POST /api/assistant: a message over 8000 characters is a 400 before anything runs", async () => {
  vi.doMock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), session: async () => ({ key: "mc_test_key", base: "http://api.test" }) }));
  const f = vi.fn(async () => text("x"));
  vi.stubGlobal("fetch", f);
  const { POST } = await import("@/app/api/assistant/route");
  const post = (content: string) => POST(new Request("http://dash/api/assistant", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content }], page: { path: "/" } }), headers: { "content-type": "application/json" } }));
  const res = await post("x".repeat(8001));
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: "message_too_long", message: expect.stringContaining("8000") });
  expect(f).not.toHaveBeenCalled();
  expect((await post("x".repeat(8000))).status).not.toBe(400); // the limit itself is fine
  vi.doUnmock("@/lib/api");
});
