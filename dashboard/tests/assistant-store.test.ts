import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyProposal, cancelProposal, peekProposal, putProposal, sessionId, TTL_MS } from "@/lib/assistant/proposals";
import { keyInfo, countRequest, requestsToday, resetKeyInfo } from "@/lib/assistant/usage";
import { API, fakeWorld, MUTATING } from "./assistant-kit";

process.env.MAILCRAFT_ASSISTANT_BASE_URL = "http://or.test/api/v1";
const spec = (over: object = {}) => ({ kind: "contacts" as const, title: "t", summary: "s", risk: "safe" as const, warnings: [], calls: [{ method: "PUT", path: "/v1/contacts", body: { email: "a@example.com" }, label: "Upsert" }], ...over });
beforeEach(() => { (globalThis as any).__mcProposals?.clear(); resetKeyInfo(); delete process.env.OPENROUTER_API_KEY; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("a proposal is bound to the session that created it (key + base)", () => {
  const a = sessionId("k1", API), b = sessionId("k2", API);
  const p = putProposal(a, spec());
  expect(peekProposal(a, p.id)).toBeDefined();
  expect(peekProposal(b, p.id)).toBeUndefined();
  expect(cancelProposal(b, p.id)).toBe(false);
  expect(sessionId("k1", "http://other")).not.toBe(a);
});

test("it expires after the TTL", async () => {
  vi.useFakeTimers();
  const p = putProposal("s", spec());
  vi.advanceTimersByTime(TTL_MS - 1000);
  expect(peekProposal("s", p.id)).toBeDefined();
  vi.advanceTimersByTime(2000);
  expect(peekProposal("s", p.id)).toBeUndefined();
  expect((await applyProposal("s", p.id, { base: API, key: "k" }, false)).error?.code).toBe("proposal_expired");
});

test("what is stored cannot be modified after review", () => {
  const p = putProposal("s", spec());
  expect(Object.isFrozen(p)).toBe(true);
  expect(() => { (p as any).title = "changed"; }).toThrow();
  const stored = peekProposal("s", p.id)!;
  expect(() => { (stored.calls[0].body as any).email = "evil@example.com"; }).toThrow();
  expect(() => { (stored.calls as any).push({}); }).toThrow();
});

test("apply runs the stored calls in order, substituting $prev, and stops at the first failure", async () => {
  const w = fakeWorld([], { "POST /v1/segments": () => ({ id: "s9" }), "POST /v1/segments/s9/members": () => ({ added: 1 }) });
  const p = putProposal("s", spec({ calls: [{ method: "POST", path: "/v1/segments", body: { name: "L" }, label: "Create" }, { method: "POST", path: "/v1/segments/$prev.id/members", body: { emails: ["a@example.com"] }, label: "Add" }], linkKind: "contacts" }));
  expect(await applyProposal("s", p.id, { base: API, key: "k" }, false)).toMatchObject({ status: "completed" });
  expect(w.rec.filter(MUTATING).map((r) => r.url)).toEqual(["/v1/segments", "/v1/segments/s9/members"]);

  const w2 = fakeWorld([], {});
  const q = putProposal("s", spec({ calls: [{ method: "POST", path: "/v1/nope", label: "First" }, { method: "POST", path: "/v1/other", label: "Second" }] }));
  const r = await applyProposal("s", q.id, { base: API, key: "k" }, false);
  expect(r).toMatchObject({ status: "failed", error: { code: "not_found" } });
  expect(w2.rec).toHaveLength(1);
});

test("pending approval is reported as such (the human gate still applies)", async () => {
  fakeWorld([], { "POST /v1/emails": () => ({ id: "e1", status: "pending_approval" }) });
  const p = putProposal("s", spec({ calls: [{ method: "POST", path: "/v1/emails", body: {}, label: "Send" }] }));
  expect(await applyProposal("s", p.id, { base: API, key: "k" }, false)).toMatchObject({ status: "pending_approval", detail: expect.stringMatching(/approve/i) });
});

test("cancel drops the proposal without calling the API", () => {
  const w = fakeWorld([]);
  const p = putProposal("s", spec());
  expect(cancelProposal("s", p.id)).toBe(true);
  expect(peekProposal("s", p.id)).toBeUndefined();
  expect(w.f).not.toHaveBeenCalled();
});

// ---- usage ------------------------------------------------------------------------------------------------------
const keyRes = (d: object) => Response.json({ data: d });
test("no key: reported, nothing fetched", async () => {
  const f = vi.fn();
  expect(await keyInfo(f as any)).toMatchObject({ ok: false, reason: "no_key" });
  expect(f).not.toHaveBeenCalled();
});

test("key info keeps the documented fields as returned, sends the key only as a header, and is cached for 60s", async () => {
  process.env.OPENROUTER_API_KEY = "or-secret";
  vi.useFakeTimers();
  const f = vi.fn(async () => keyRes({ label: "sk-or-v1-abc…xyz", usage: 0.5, limit: null, limit_remaining: null, is_free_tier: true, rate_limit: { requests: 20, interval: "10s" }, secret_thing: "x" }));
  const k = await keyInfo(f as any);
  expect(k).toEqual({ ok: true, data: { label: "sk-or-v1-abc…xyz", usage: 0.5, limit: null, limit_remaining: null, is_free_tier: true, rate_limit: { requests: 20, interval: "10s" } } });
  expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Bearer or-secret");
  expect((f.mock.calls[0] as any)[0]).not.toContain("or-secret");
  await keyInfo(f as any);
  expect(f).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_001);
  await keyInfo(f as any);
  expect(f).toHaveBeenCalledTimes(2);
});

test("a 401 and an unreachable OpenRouter are graceful", async () => {
  process.env.OPENROUTER_API_KEY = "bad";
  expect(await keyInfo((async () => new Response("{}", { status: 401 })) as any)).toMatchObject({ ok: false, reason: "unauthorized" });
  resetKeyInfo();
  expect(await keyInfo((async () => { throw new Error("offline"); }) as any)).toMatchObject({ ok: false, reason: "unreachable" });
});

test("requests are counted locally per UTC day", () => {
  const before = requestsToday();
  countRequest(); countRequest();
  expect(requestsToday()).toBe(before + 2);
});
