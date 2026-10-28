// The server-side agent loop for one user turn: stream a completion, run the tool calls it asks for (in parallel), feed
// compact results back, repeat up to MAX_ROUNDS. Write tools only ever produce proposals; nothing here can execute one.
import { openai } from "./openai-shape";
import { recordModel } from "./models";
import { isDailyCap, streamChat, UpstreamError, type Streamed } from "./openrouter";
import { nextUtcMidnight } from "./reset";
import { buildHistory, estTokens, pageContext, system } from "./prompt";
import { routeGroups, runTool, toolsFor, type Group, type Outcome } from "./tools";
import { countRequest } from "./usage";
import type { Ctx } from "./core";
import type { ChatEvent, ChatMsg } from "./types";
import { activity } from "./tools";

export const MAX_ROUNDS = 8;
const FIRST_TOKEN_MS = 20_000, TURN_MS = 120_000, MAX_CALLS = 6;

export type TurnInput = {
  history: ChatMsg[]; path: string; ctx: Ctx; key: string; chain: string[];
  signal?: AbortSignal; fetchImpl?: typeof fetch; log?: (line: string) => void; firstTokenMs?: number;
};

export const failure = (e: UpstreamError): ChatEvent => {
  const day = isDailyCap(e.message);
  switch (e.code) {
    case "unauthorized": return { type: "error", code: e.code, message: "OpenRouter rejected the API key.", hint: "Check OPENROUTER_API_KEY on the dashboard server." };
    // The daily-cap sentence is finished in the browser (shown() in reset.ts), which knows the viewer's time zone; resetAt is epoch ms.
    case "rate_limited": return day
      ? { type: "error", code: e.code, message: "Today's free AI requests are used up.", hint: "Settings → AI usage shows where your key stands.", resetAt: e.resetAt ?? nextUtcMidnight() }
      : { type: "error", code: e.code, message: "Free models are rate-limited right now.", hint: "Wait a minute and try again." };
    case "payment_required": return { type: "error", code: e.code, message: "OpenRouter asked for credits, which free models should not need.", hint: "Check the key on openrouter.ai." };
    // Only messages written here reach the browser: an upstream body can echo headers, so it is never relayed.
    default: return { type: "error", code: e.code, message: e.code === "first_token_timeout" || e.code === "empty_completion" ? e.message || "The model could not be reached." : "The model could not be reached.", hint: "Try again; the assistant moves to the next free model automatically." };
  }
};

export async function* runTurn(i: TurnInput): AsyncGenerator<ChatEvent> {
  const t0 = Date.now(), deadline = AbortSignal.timeout(TURN_MS);
  const signal = i.signal ? AbortSignal.any([i.signal, deadline]) : deadline;
  const last = [...i.history].reverse().find((m) => m.role === "user")?.content ?? "";
  const sendOpen = i.history.slice(-6).some((m) => m.note && /proposed \(not applied\): (Send "|Broadcast ")/.test(m.note)); // "make it friendlier" has no send keyword but needs propose_email again
  const groups = routeGroups(last, i.path, sendOpen ? ["broadcasts"] : []);
  yield { type: "phase", phase: "thinking", label: "Thinking…" };

  const page = await pageContext(i.path, last, i.ctx);
  const messages: any[] = [{ role: "system", content: system(i.ctx.env, i.path) + page }, ...buildHistory(i.history)];
  const estInput = () => estTokens(messages) + estTokens(toolsFor(groups));
  const stats = { prompt: 0, completion: 0, rounds: 0, ttft: 0 };
  let mi = 0, model = i.chain[0];
  const names: string[] = [], failed: string[] = [];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) return;
    const finalRound = round === MAX_ROUNDS;
    if (finalRound) messages.push({ role: "user", content: "Tool budget used. Answer now with what you have." });
    const tools = finalRound ? [] : toolsFor(groups);
    let res: Streamed | undefined, lastErr: UpstreamError | undefined;
    for (let tries = 0; tries < Math.min(i.chain.length, 4) && !res; tries++) {
      model = i.chain[mi % i.chain.length];
      const started = Date.now(), q: string[] = [];
      let sawFirst = false, wake: (() => void) | undefined, out: { r?: Streamed; e?: unknown } | undefined;
      countRequest();
      stats.rounds++;
      const p = streamChat({
        key: i.key, signal, fetchImpl: i.fetchImpl, firstTokenMs: i.firstTokenMs ?? FIRST_TOKEN_MS,
        body: openai(model, i.chain.slice(mi % i.chain.length + 1, mi % i.chain.length + 3), messages, tools, groups.has("templates") ? 3000 : 1500),
        onFirst: () => { sawFirst = true; if (!stats.ttft) stats.ttft = Date.now() - t0; recordModel(model, Date.now() - started); },
        onText: (d) => { q.push(d); wake?.(); },
      }).then((r) => (out = { r }), (e) => (out = { e }));
      while (!out) { // forward text as it arrives
        while (q.length) yield { type: "text", delta: q.shift()! };
        await Promise.race([p, new Promise<void>((r) => (wake = r))]);
      }
      while (q.length) yield { type: "text", delta: q.shift()! };
      if (signal.aborted) return;
      const r = out.r;
      if (r && (r.content.trim() || r.calls.length)) {
        res = r;
        if (r.usage) { stats.prompt += r.usage.prompt; stats.completion += r.usage.completion; }
        continue;
      }
      lastErr = out.e instanceof UpstreamError ? out.e : new UpstreamError(r ? "empty_completion" : "upstream_error", r ? "The model returned nothing." : (out.e as Error)?.message);
      if (!sawFirst) recordModel(model, null);
      failed.push(`${model}:${lastErr.code}${lastErr.status ? lastErr.status : ""}`);
      if (lastErr.code === "unauthorized" || lastErr.code === "payment_required") break;
      mi++; // next free model
    }
    if (!res) { yield failure(lastErr ?? new UpstreamError("upstream_error", "No model answered.")); return; }
    if (!res.calls.length) break;

    const calls = res.calls.slice(0, MAX_CALLS);
    messages.push({ role: "assistant", content: res.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) });
    const a0 = (() => { try { return JSON.parse(calls[0].args || "{}"); } catch { return {}; } })();
    const act = activity(calls[0].name, a0);
    yield { type: "phase", phase: act.phase, label: calls.length > 1 ? `${act.label.replace(/…$/, "")} +${calls.length - 1} more…` : act.label };
    for (const c of calls) yield { type: "tool", id: c.id, name: c.name, label: activity(c.name, safe(c.args)).label, status: "running" };

    const runs = new Map<string, Promise<[string, Outcome]>>(calls.map((c) => [c.id, runTool(c.name, c.args, i.ctx, groups as Set<Group>).then((o) => [c.id, o] as [string, Outcome])]));
    const results = new Map<string, Outcome>();
    while (runs.size) {
      const [id, o] = await Promise.race(runs.values());
      runs.delete(id); results.set(id, o);
      const c = calls.find((x) => x.id === id)!;
      yield { type: "tool", id, name: c.name, label: o.done, status: o.error ? "error" : "done", detail: o.detail };
      if (o.proposal) yield { type: "proposal", proposal: o.proposal };
    }
    for (const c of calls) { names.push(c.name); messages.push({ role: "tool", tool_call_id: c.id, content: results.get(c.id)!.content }); }
    yield { type: "phase", phase: "thinking", label: "Thinking…" };
  }

  const total = Date.now() - t0;
  i.log?.(JSON.stringify({ evt: "assistant_turn", model, rounds: stats.rounds, prompt_tokens: stats.prompt, completion_tokens: stats.completion, ttft_ms: stats.ttft, total_ms: total, tools: names.length, est_input: estInput(), failed }));
  yield { type: "done", stats: { model, prompt: stats.prompt, completion: stats.completion, rounds: stats.rounds, ttft_ms: stats.ttft, total_ms: total, est_input: estInput(), failed } };
}
const safe = (s: string) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
