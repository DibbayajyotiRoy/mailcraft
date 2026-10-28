// POST /api/compose/write: "Write with AI" in the New email dialog. One free-model call, streamed as NDJSON WriteEvents
// (lib/compose-ai/events.ts): { field, delta } while a field grows, { field, done } when it is complete, then { done, usage }.
// Same OpenRouter client, free-model allowlist and fallback chain as the assistant; the key never leaves this process.
// Nothing is sent or saved here: the dialog fills its own fields and Send stays the user's action.
import { clip } from "@/lib/assistant/compact";
import { failure } from "@/lib/assistant/loop";
import { allowedModels, recordModel, resolveModels } from "@/lib/assistant/models";
import { openai } from "@/lib/assistant/openai-shape";
import { streamChat, UpstreamError } from "@/lib/assistant/openrouter";
import { auth, json } from "@/lib/assistant/server";
import { apiKey, countRequest } from "@/lib/assistant/usage";
import { request } from "@/lib/api";
import { askableVars } from "@/lib/compose";
import { TONES, type FieldEvent, type WriteEvent, type WriteRequest } from "@/lib/compose-ai/events";
import { FieldStream } from "@/lib/compose-ai/fields";
import { askedVars, fieldsFor, maxTokens, MAX_PROMPT, systemPrompt, userPrompt } from "@/lib/compose-ai/prompt";

export const dynamic = "force-dynamic";
const FIRST_TOKEN_MS = 25_000, TOTAL_MS = 90_000, TRIES = 3;
/** Provider text can echo request headers: drop the key and any bearer token before it is logged. */
const redact = (s: string) => clip((apiKey() ? s.split(apiKey()).join("[key]") : s).replace(/Bearer\s+\S+/gi, "Bearer [key]"), 200);

export async function POST(req: Request) {
  const a = await auth();
  if (!a) return json(401, { code: "unauthenticated", message: "Sign in first." });
  if (!apiKey()) return json(503, { code: "not_configured", message: "Write with AI is not enabled.", hint: "Set OPENROUTER_API_KEY on the dashboard server." });
  let b: Partial<WriteRequest>;
  try { b = await req.json(); } catch { return json(400, { code: "invalid_request", message: "Expected JSON." }); }
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT) return json(400, { code: "invalid_request", message: prompt ? `Keep the request under ${MAX_PROMPT} characters.` : "Say what the email should be about." });
  if (b.mode !== "text" && b.mode !== "html" && b.mode !== "template") return json(400, { code: "invalid_request", message: "mode must be text, html or template." });
  const mode = b.mode;

  // A model is never taken from the request: free ones only, and a paid MAILCRAFT_ASSISTANT_MODEL is refused, exactly as for the assistant.
  const models = resolveModels(process.env, await allowedModels());
  if (!models.ok) return json(400, models);

  let vars: string[] = [], tpl: { name?: unknown; subject?: unknown; variables: string[]; source?: unknown } | undefined;
  if (mode === "template") {
    if (typeof b.template !== "string" || !b.template || b.template.length > 120) return json(400, { code: "invalid_request", message: "Choose a template first." });
    const r = await request(a.base, a.key, "GET", `/v1/templates/${encodeURIComponent(b.template)}`, undefined, 8000);
    if (r.error || !r.data) return json(r.error?.code === "not_found" ? 404 : 502, { code: "template_unavailable", message: r.error ? `Could not read the template: ${r.error.message}` : "Could not read the template.", hint: r.error?.hint });
    vars = askedVars(askableVars(r.data.variables));
    tpl = { name: r.data.name ?? r.data.alias, subject: r.data.subject, variables: vars, source: r.data.source ?? r.data.content };
  }
  const allowed = new Set(fieldsFor(mode, vars));
  const messages = [{ role: "system", content: systemPrompt(mode, vars) }, { role: "user", content: userPrompt({ ...b, prompt, tone: TONES.includes(b.tone as never) ? b.tone : undefined, names: Array.isArray(b.names) ? b.names : [], fromName: typeof b.fromName === "string" ? b.fromName : undefined }, tpl) }];

  const ac = new AbortController(), enc = new TextEncoder(), t0 = Date.now();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(TOTAL_MS)]);
  const stream = new ReadableStream({
    async start(c) {
      const send = (e: WriteEvent) => { try { c.enqueue(enc.encode(JSON.stringify(e) + "\n")); } catch { /* the client went away */ } };
      let wrote = false, last: UpstreamError | undefined;
      try {
        for (let i = 0; i < Math.min(models.chain.length, TRIES) && !wrote && !signal.aborted; i++) {
          const model = models.chain[i], started = Date.now(), fs = new FieldStream(), done = new Set<string>(), held: FieldEvent[] = [];
          // Nothing reaches the browser until the model has written something: an answer with every field empty is no answer, and the next model gets its turn.
          const emit = (evs: FieldEvent[]) => {
            for (const e of evs) {
              if (!allowed.has(e.field) || done.has(e.field)) continue;
              if ("done" in e) done.add(e.field);
              if (wrote) send(e);
              else if ("delta" in e && e.delta) { wrote = true; held.splice(0).forEach(send); send(e); }
              else held.push(e);
            }
          };
          countRequest();
          try {
            const res = await streamChat({
              key: apiKey(), signal, firstTokenMs: FIRST_TOKEN_MS, body: openai(model, models.chain.slice(i + 1, i + 3), messages, [], maxTokens(mode)),
              onFirst: () => recordModel(model, Date.now() - started), onText: (d) => emit(fs.push(d)),
            });
            if (signal.aborted) return;
            if (!wrote) { last = new UpstreamError("empty_completion", "The model returned nothing usable."); recordModel(model, null); continue; }
            if (res.finish === "length") { last = new UpstreamError("truncated", "The model ran out of room before it finished."); break; } // the cut-off field is never reported as complete
            emit(fs.end());
            const u = res.usage;
            send({ done: true, usage: { tokens: u ? u.prompt + u.completion : Math.ceil(res.content.length / 4), prompt: u?.prompt ?? 0, completion: u?.completion ?? Math.ceil(res.content.length / 4), ms: Date.now() - t0, model, ...(u ? {} : { estimated: true }) } });
            return;
          } catch (e) {
            if (signal.aborted && !(e instanceof UpstreamError)) return; // stopped by the user: what was written stays in the form
            last = e instanceof UpstreamError ? e : new UpstreamError("upstream_error", (e as Error).message);
            if (!wrote) recordModel(model, null);
            if (wrote || last.code === "unauthorized" || last.code === "payment_required") break; // already showing text, or retrying cannot help
          }
        }
        if (signal.aborted) return;
        // The browser only ever sees messages written here; what the provider said goes to the server log, scrubbed.
        if (last) console.warn(JSON.stringify({ evt: "compose_write_failed", code: last.code, status: last.status, detail: redact(last.message) }));
        if (last?.code === "truncated") send({ error: { code: "truncated", message: last.message, hint: "What was written is kept. Edit it, or Regenerate (a shorter request helps)." } });
        else {
          const f = failure(last ?? new UpstreamError("upstream_error", "No model answered.")) as { code: string; message: string; hint?: string }; // always an error event
          send({ error: { code: f.code, message: clip(f.message, 200), hint: f.hint } });
        }
      } finally {
        try { c.close(); } catch { /* already closed */ }
      }
    },
    cancel() { ac.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
