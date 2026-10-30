// POST /api/assistant: one agent turn, streamed as NDJSON ChatEvents. The OpenRouter key never leaves the server.
import { allowedModels, resolveModels } from "@/lib/assistant/models";
import { runTurn } from "@/lib/assistant/loop";
import { cleanPath } from "@/lib/assistant/prompt";
import { auth, json } from "@/lib/assistant/server";
import { apiKey } from "@/lib/assistant/usage";
import type { Attachment, ChatMsg } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";
const MAX_MESSAGE = 8000;

function renderAttachment(a: Attachment): string {
  if (a.kind === "csv") return `CSV "${a.name}": ${a.count} rows, columns: ${a.columns.join(", ")}. Sample (emails masked): ${a.summary}`;
  if (a.kind === "json") return `JSON "${a.name}": ${JSON.stringify(a.content).slice(0, 2000)}`;
  return `${a.kind.toUpperCase()} "${a.name}":\n${a.content.slice(0, 2000)}${a.content.length > 2000 ? "…" : ""}`;
}

function injectAttachments(msgs: ChatMsg[]): ChatMsg[] {
  if (!msgs.length) return msgs;
  const last = msgs[msgs.length - 1];
  if (!last.attachments?.length) return msgs;
  const rendered = last.attachments.map(renderAttachment).join("\n\n");
  return msgs.map((m, i) => i === msgs.length - 1 ? { ...m, content: `${m.content || "Attached:"}\n\n${rendered}`.trim() } : m);
}

export async function POST(req: Request) {
  const a = await auth();
  if (!a) return json(401, { code: "unauthenticated", message: "Sign in first." });
  if (!apiKey()) return json(503, { code: "not_configured", message: "The assistant is not enabled.", hint: "Set OPENROUTER_API_KEY on the dashboard server." });
  let body: { messages?: ChatMsg[]; page?: { path?: string } };
  try { body = await req.json(); } catch { return json(400, { code: "invalid_request", message: "Expected JSON." }); }
  const history = injectAttachments((Array.isArray(body.messages) ? body.messages : []).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-60));
  if (history.at(-1)?.role !== "user" || (!history.at(-1)!.content.trim() && !history.at(-1)!.attachments?.length)) return json(400, { code: "invalid_request", message: "The last message must be from the user." });
  if (history.at(-1)!.content.length > MAX_MESSAGE) return json(400, { code: "message_too_long", message: `Messages can be at most ${MAX_MESSAGE} characters.`, hint: "Shorten it, or paste long text into a template instead." });

  const models = resolveModels(process.env, await allowedModels());
  if (!models.ok) return json(400, models);
  const lastAttachments = history.at(-1)?.attachments as Attachment[] | undefined;
  const ctx = { base: a.base, key: a.key, sid: a.sid, env: await a.env(), attachments: lastAttachments };

  const ac = new AbortController(), enc = new TextEncoder();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const stream = new ReadableStream({
    async start(c) {
      try {
        for await (const ev of runTurn({ history, path: cleanPath(body.page?.path), ctx, key: apiKey(), chain: models.chain, signal: ac.signal, log: (l) => console.info(l) })) c.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      } catch (e) {
        c.enqueue(enc.encode(JSON.stringify({ type: "error", code: "internal", message: "The assistant hit an unexpected error.", hint: (e as Error).message.slice(0, 120) }) + "\n"));
      }
      c.close();
    },
    cancel() { ac.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
