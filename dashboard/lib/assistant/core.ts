// Shared by the read tools and the proposal builders: one API-call helper with a short per-session read cache.
import { request } from "@/lib/api";
import { clip } from "./compact";
import type { Proposal } from "./types";

export type Ctx = { base: string; key: string; sid: string; env: "test" | "live" };
/** A tool's result: an error, data for the model, or a proposal (`model` is the short text the model gets back). */
export type Out =
  | { error: { code: string; message: string; hint?: string } }
  | { ok: unknown; done?: string; total?: number }
  | { proposal: Proposal; model: unknown };

// 60s per-session cache for reads; applying a proposal invalidates it.
const cache = ((globalThis as any).__mcReads ??= new Map<string, { at: number; r: any }>()) as Map<string, { at: number; r: any }>;
export const invalidateReads = (sid: string) => { for (const k of cache.keys()) if (k.startsWith(sid)) cache.delete(k); };
export async function read(ctx: Ctx, method: string, path: string, body?: unknown, ttl = 60_000) {
  const k = `${ctx.sid}|${method}|${path}|${body ? JSON.stringify(body) : ""}`, hit = cache.get(k);
  if (hit && Date.now() - hit.at < ttl) return hit.r;
  const r = await request(ctx.base, ctx.key, method, path, body, 15_000);
  if (!r.error) { if (cache.size > 400) cache.delete(cache.keys().next().value!); cache.set(k, { at: Date.now(), r }); }
  return r;
}
export const fail = (code: string, message: string, hint?: string): Out => ({ error: { code, message: clip(message, 300), ...(hint && { hint: clip(hint, 200) }) } });
export const apiErr = (e: { code: string; message: string; hint?: string }) => fail(e.code, e.message, e.hint);
