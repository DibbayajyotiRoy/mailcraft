import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { API, calls, fakeWorld, text } from "./assistant-kit";

process.env.MAILCRAFT_ASSISTANT_BASE_URL = "http://or.test/api/v1";
let signedIn = true;
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), session: async () => (signedIn ? { key: "mc_test_key", base: "http://api.test" } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const post = (url: string, body: unknown) => new Request(`http://dash${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const lines = async (r: Response) => (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
beforeEach(() => { signedIn = true; delete process.env.OPENROUTER_API_KEY; delete process.env.MAILCRAFT_ASSISTANT_MODEL; (globalThis as any).__mcModels = { at: Date.now(), v: { ids: ["m1:free", "m2:free"], source: "openrouter" } }; });
afterEach(() => vi.unstubAllGlobals());

test("no OPENROUTER_API_KEY: the chat route explains how to enable it and calls nobody", async () => {
  const w = fakeWorld([text("x")]);
  const { POST } = await import("@/app/api/assistant/route");
  const res = await POST(post("/api/assistant", { messages: [{ role: "user", content: "hi" }], page: { path: "/" } }));
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ code: "not_configured", hint: expect.stringContaining("OPENROUTER_API_KEY") });
  expect(w.f).not.toHaveBeenCalled();
  const { GET } = await import("@/app/api/assistant/status/route");
  expect(await (await GET()).json()).toEqual({ configured: false });
});

test("signed-out requests are refused on every route", async () => {
  signedIn = false;
  const { POST } = await import("@/app/api/assistant/route");
  const { POST: apply } = await import("@/app/api/assistant/apply/route");
  expect((await POST(post("/api/assistant", { messages: [] }))).status).toBe(401);
  expect((await apply(post("/api/assistant/apply", { id: "x", action: "apply" }))).status).toBe(401);
});

test("a paid MAILCRAFT_ASSISTANT_MODEL is rejected with a clear error and nothing is sent to OpenRouter", async () => {
  process.env.OPENROUTER_API_KEY = "or-key";
  process.env.MAILCRAFT_ASSISTANT_MODEL = "anthropic/claude-sonnet-4";
  const w = fakeWorld([text("x")]);
  const { POST } = await import("@/app/api/assistant/route");
  const res = await POST(post("/api/assistant", { messages: [{ role: "user", content: "hi" }], page: { path: "/" } }));
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: "model_not_free" });
  expect(w.orBodies).toHaveLength(0);
});

test("a turn streams NDJSON; the proposal arrives as an event and Apply goes through the second route with only an id", async () => {
  process.env.OPENROUTER_API_KEY = "or-key";
  const w = fakeWorld([calls(["propose_contacts", { contacts: [{ email: "ana@example.com", first_name: "Ana" }] }]), text("Ready.")], { "GET /v1/account/status": () => ({ env: "test" }), "PUT /v1/contacts": () => ({ id: "c1" }) });
  const { POST } = await import("@/app/api/assistant/route");
  const ev = await lines(await POST(post("/api/assistant", { messages: [{ role: "user", content: "add ana@example.com" }], page: { path: "/contacts" } })));
  const p = ev.find((e) => e.type === "proposal").proposal;
  expect(ev.at(-1).type).toBe("done");
  expect(w.orBodies[0].messages.at(-1).content).toBe("add ana@example.com");
  expect(w.rec.some((r) => r.method === "PUT")).toBe(false);

  const { POST: apply } = await import("@/app/api/assistant/apply/route");
  expect((await (await apply(post("/api/assistant/apply", { id: p.id, action: "cancel" }))).json())).toEqual({ cancelled: true });
  expect((await (await apply(post("/api/assistant/apply", { id: p.id, action: "apply" }))).json()).result.error.code).toBe("proposal_expired"); // cancelled stays cancelled
  expect(w.rec.some((r) => r.method === "PUT")).toBe(false);
});

test("the OpenRouter key never appears in anything sent to the browser", async () => {
  process.env.OPENROUTER_API_KEY = "or-key-SECRET";
  fakeWorld([text("hello")], { "GET /v1/account/status": () => ({ env: "test" }) });
  const { POST } = await import("@/app/api/assistant/route");
  const body = await (await POST(post("/api/assistant", { messages: [{ role: "user", content: "hi" }], page: { path: "/" } }))).text();
  expect(body).not.toContain("SECRET");
  const { GET } = await import("@/app/api/assistant/status/route");
  fakeWorld([], {});
  expect(JSON.stringify(await (await GET()).json())).not.toContain("SECRET");
});
