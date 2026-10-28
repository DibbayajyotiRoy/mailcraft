// One streamed chat-completions call to OpenRouter (OpenAI-compatible). Server-only: carries the API key.
import { BASE } from "./models";
import { noteRateLimit, readRateLimit } from "./usage";

export class UpstreamError extends Error {
  /** `resetAt` (epoch ms): only on the daily free-request cap, when the free requests come back. */
  constructor(public code: string, message: string, public status = 0, public resetAt?: number) { super(message); }
}
export const isDailyCap = (message: string) => /per-day|daily/i.test(message);
export type ToolCall = { id: string; name: string; args: string };
export type Usage = { prompt: number; completion: number };
export type Streamed = { content: string; calls: ToolCall[]; usage?: Usage; finish?: string };

export type Req = { key: string; body: Record<string, unknown>; signal?: AbortSignal; fetchImpl?: typeof fetch; firstTokenMs: number; onText: (d: string) => void; onFirst: () => void };

/** Streams one completion. `onFirst` fires on the first real data chunk (text, reasoning or tool call), not on keep-alives. */
export async function streamChat(r: Req): Promise<Streamed> {
  const ac = new AbortController(), kill = () => ac.abort();
  r.signal?.addEventListener("abort", kill, { once: true });
  let first = false;
  const timer = setTimeout(() => { if (!first) ac.abort(new UpstreamError("first_token_timeout", `No response within ${Math.round(r.firstTokenMs / 1000)}s`)); }, r.firstTokenMs);
  try {
    let res: Response;
    try {
      res = await (r.fetchImpl ?? fetch)(`${BASE()}/chat/completions`, {
        method: "POST", signal: ac.signal, cache: "no-store",
        headers: { Authorization: `Bearer ${r.key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/DibbayajyotiRoy/mailcraft", "X-Title": "mailcraft" },
        body: JSON.stringify({ ...r.body, stream: true }),
      });
    } catch (e) { throw abortReason(ac, e); }
    if (res.ok) noteRateLimit(readRateLimit(res.headers)); // OpenRouter documents them on 429s only; kept if they ever appear on a success
    else {
      let msg = `HTTP ${res.status}`, meta: Record<string, unknown> | undefined;
      try { const j = await res.json(); msg = j?.error?.message ? String(j.error.message) : msg; meta = j?.error?.metadata?.headers; } catch { /* keep status text */ }
      let resetAt: number | undefined;
      if (res.status === 429 && !/per-min|minute/i.test(msg)) { // a per-minute 429 says nothing about today
        const rl = readRateLimit(res.headers, meta), day = isDailyCap(msg);
        noteRateLimit(rl, day);
        if (day) resetAt = rl.resetAt ?? undefined;
      }
      throw new UpstreamError(res.status === 401 ? "unauthorized" : res.status === 402 ? "payment_required" : res.status === 429 ? "rate_limited" : res.status === 404 ? "model_unavailable" : "upstream_error", msg.slice(0, 300), res.status, resetAt);
    }
    const out: Streamed = { content: "", calls: [] };
    const calls = new Map<number, ToolCall>();
    const dec = new TextDecoder();
    let buf = "";
    const handle = (line: string) => {
      if (!line.startsWith("data:")) return; // ": OPENROUTER PROCESSING" keep-alives
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let j: any;
      try { j = JSON.parse(data); } catch { return; }
      if (j.error) throw new UpstreamError("upstream_error", String(j.error.message ?? "stream error").slice(0, 300), Number(j.error.code) || 0);
      if (j.usage) out.usage = { prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0 };
      const c = j.choices?.[0];
      if (!c) return;
      if (c.finish_reason) out.finish = c.finish_reason;
      const d = c.delta ?? {};
      if (!first && (d.content || d.reasoning || d.reasoning_content || d.tool_calls)) { first = true; clearTimeout(timer); r.onFirst(); }
      if (typeof d.content === "string" && d.content) { out.content += d.content; r.onText(d.content); }
      for (const t of d.tool_calls ?? []) {
        const cur = calls.get(t.index ?? 0) ?? { id: "", name: "", args: "" };
        if (t.id) cur.id = t.id;
        if (t.function?.name) cur.name += t.function.name;
        if (t.function?.arguments) cur.args += t.function.arguments;
        calls.set(t.index ?? 0, cur);
      }
    };
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
      }
      handle(buf.trim());
    } catch (e) { throw abortReason(ac, e); }
    out.calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ ...c, id: c.id || `call_${i}` })).filter((c) => c.name);
    return out;
  } finally {
    clearTimeout(timer);
    r.signal?.removeEventListener("abort", kill);
  }
}
const abortReason = (ac: AbortController, e: unknown) => (e instanceof UpstreamError ? e : ac.signal.reason instanceof UpstreamError ? ac.signal.reason : e);
