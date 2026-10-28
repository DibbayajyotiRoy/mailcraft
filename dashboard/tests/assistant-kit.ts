// Test kit for the assistant: a fake mailcraft API and a fake OpenRouter behind one stubbed global fetch.
import { vi } from "vitest";
import type { Ctx } from "@/lib/assistant/core";

export const API = "http://api.test", OR = "http://or.test/api/v1";
export const ctx = (over: Partial<Ctx> = {}): Ctx => ({ base: API, key: "mc_test_key", sid: "sid-1", env: "test", ...over });

const enc = new TextEncoder();
export const sse = (...chunks: unknown[]) => new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
export const text = (t: string, usage = { prompt_tokens: 900, completion_tokens: 40 }) => sse({ choices: [{ delta: { content: t } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage });
export const calls = (...cs: [string, unknown][]) => sse(
  ...cs.map(([name, args], i) => ({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name, arguments: JSON.stringify(args) } }] } }] })),
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 700, completion_tokens: 30 } });
export const orError = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });
export const env = (data: unknown, extra: object = {}) => new Response(JSON.stringify({ ok: true, data, ...extra }), { status: 200 });
export const apiFail = (status: number, code: string, message: string) => new Response(JSON.stringify({ ok: false, error: { code, message } }), { status });

export type Rec = { url: string; method: string; body: any };
/** `model` answers each OpenRouter request in turn; `routes` answers the mailcraft API by "METHOD /path". */
export function fakeWorld(model: (Response | ((body: any, signal?: AbortSignal | null) => Response))[], routes: Record<string, (b: any, q: URLSearchParams) => Response | unknown> = {}) {
  const rec: Rec[] = [], orBodies: any[] = [];
  let next = 0, inflight = 0, maxInflight = 0;
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url)), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (u.host === "or.test") {
      if (u.pathname.endsWith("/chat/completions")) { orBodies.push(body); const m = model[Math.min(next++, model.length - 1)]; return typeof m === "function" ? m(body, init?.signal) : m.clone(); }
      return new Response("{}", { status: 404 });
    }
    rec.push({ url: u.pathname + u.search, method, body });
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    const h = routes[`${method} ${u.pathname}`];
    if (!h) return apiFail(404, "not_found", `no route ${method} ${u.pathname}`);
    const out = h(body, u.searchParams);
    return out instanceof Response ? out : env(out);
  });
  vi.stubGlobal("fetch", f);
  return { rec, orBodies, f, maxInflight: () => maxInflight };
}

export const TEMPLATES = [
  { id: "t1", alias: "welcome", name: "Welcome", stream: "transactional", status: "published", version: 3, published_version: 3, subject: "Welcome {{ first_name }}", html: "<h1>BIG HTML</h1>" },
  { id: "t2", alias: "receipt", name: "Receipt", stream: "transactional", status: "published", version: 5, published_version: 4, subject: "Your receipt", source_format: "mjml", source: "<mjml><mj-body><mj-text>Hi {{ first_name }}</mj-text><mj-text>Hi {{ first_name }}!</mj-text></mj-body></mjml>", variables: ["first_name"] },
  { id: "t3", alias: "draft-only", name: "Draft only", stream: "marketing", status: "draft", version: 1, published_version: null },
];
export const MUTATING = (r: Rec) => r.method !== "GET" && !/\/preview$|\/lint$|\/simulate$/.test(r.url) && !(r.body && r.body.dry_run === true);

/** Inner JSON of an `<untrusted>…</untrusted>` tool message. */
export const un = (s: string) => JSON.parse(s.slice("<untrusted>".length, -"</untrusted>".length));
