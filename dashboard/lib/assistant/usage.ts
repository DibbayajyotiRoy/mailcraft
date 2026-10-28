// OpenRouter key info for the "AI usage" card and the panel footer. Server-only: the key never leaves this process.
import { BASE } from "./models";
import { nextUtcMidnight } from "./reset";

export type KeyInfo =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "no_key" | "unauthorized" | "unreachable"; message: string };

export const apiKey = () => process.env.OPENROUTER_API_KEY?.trim() || "";

type Cap = { limit: number | null; remaining: number | null; resetAt: number | null; seenAt: number };
const g = globalThis as unknown as { __mcKey?: { at: number; v: KeyInfo }; __mcDay?: { day: string; n: number }; __mcCap?: Cap };
const FIELDS = ["label", "usage", "usage_daily", "usage_weekly", "usage_monthly", "limit", "limit_remaining", "limit_reset", "is_free_tier", "rate_limit", "free_model_daily_requests"];

/** GET /key, cached 60s. Only the documented scalar fields are kept, shown to the user exactly as returned. */
export async function keyInfo(fetchImpl: typeof fetch = fetch): Promise<KeyInfo> {
  const key = apiKey();
  if (!key) return { ok: false, reason: "no_key", message: "OPENROUTER_API_KEY is not set on the dashboard server." };
  if (g.__mcKey && Date.now() - g.__mcKey.at < 60_000) return g.__mcKey.v;
  let v: KeyInfo;
  try {
    const r = await fetchImpl(`${BASE()}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (r.status === 401 || r.status === 403) v = { ok: false, reason: "unauthorized", message: "OpenRouter rejected the key (401). Check OPENROUTER_API_KEY." };
    else if (!r.ok) v = { ok: false, reason: "unreachable", message: `OpenRouter answered HTTP ${r.status}.` };
    else {
      const d = ((await r.json()) as { data?: Record<string, unknown> }).data ?? {};
      v = { ok: true, data: Object.fromEntries(FIELDS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])) };
    }
  } catch (e) {
    v = { ok: false, reason: "unreachable", message: `Cannot reach OpenRouter: ${(e as Error).message}` };
  }
  g.__mcKey = { at: Date.now(), v };
  return v;
}
export const resetKeyInfo = () => { g.__mcKey = undefined; g.__mcCap = undefined; }; // tests

const utc = () => new Date().toISOString().slice(0, 10);
/** Requests this dashboard sent to OpenRouter today (UTC), counted locally: OpenRouter does not report "used today". */
export function countRequest() {
  if (g.__mcDay?.day !== utc()) g.__mcDay = { day: utc(), n: 0 };
  g.__mcDay.n++;
}
export const requestsToday = () => (g.__mcDay?.day === utc() ? g.__mcDay.n : 0);

const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** OpenRouter's X-RateLimit-* values: the response headers, else the copy a 429 body carries in error.metadata.headers. Reset is epoch ms (seconds are scaled up). */
export function readRateLimit(h: Headers, body?: Record<string, unknown>) {
  const get = (n: string) => h.get(n) ?? Object.entries(body ?? {}).find(([k]) => k.toLowerCase() === n)?.[1];
  const reset = num(get("x-ratelimit-reset"));
  return { limit: num(get("x-ratelimit-limit")), remaining: num(get("x-ratelimit-remaining")), resetAt: reset == null ? null : reset < 1e11 ? reset * 1000 : reset };
}
/** Keeps the latest values seen on any OpenRouter response (module-level, per process). Nothing seen = no change. `exhausted`
 *  (a free-models-per-day 429) forces remaining to 0, and the reset to the next UTC midnight if OpenRouter gave none. */
export function noteRateLimit(r: ReturnType<typeof readRateLimit>, exhausted = false, now = Date.now()) {
  if (!exhausted && r.limit == null && r.remaining == null && r.resetAt == null) return;
  g.__mcCap = { limit: r.limit, remaining: exhausted ? 0 : r.remaining, resetAt: r.resetAt ?? (exhausted ? nextUtcMidnight(now) : null), seenAt: now };
}

export type FreeToday = { limit: number | null; remaining: number; resetAt: number; source: "headers" | "key" };
/** Free-model requests left today, from OpenRouter: the X-RateLimit-* of a response newer than the cached /key (a 429 since the last
 *  poll), else /key's free_model_daily_requests (UTC day). null = OpenRouter has not said; the caller shows the local tally. */
export function freeToday(now = Date.now()): FreeToday | null {
  const k = g.__mcKey, c = g.__mcCap;
  const d = k?.v.ok ? (k.v.data.free_model_daily_requests as { limit?: unknown; remaining?: unknown } | undefined) : undefined;
  const dk = d && num(d.remaining) != null ? d : undefined;
  if (c && c.remaining != null && (c.resetAt ?? c.seenAt + 864e5) > now && (!dk || c.seenAt >= k!.at)) return { limit: c.limit ?? num(dk?.limit), remaining: c.remaining, resetAt: c.resetAt ?? nextUtcMidnight(now), source: "headers" };
  return dk ? { limit: num(dk.limit), remaining: num(dk.remaining)!, resetAt: nextUtcMidnight(now), source: "key" } : null;
}
