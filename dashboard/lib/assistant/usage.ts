// OpenRouter key info for the "AI usage" card and the panel footer. Server-only: the key never leaves this process.
import { BASE } from "./models";

export type KeyInfo =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "no_key" | "unauthorized" | "unreachable"; message: string };

export const apiKey = () => process.env.OPENROUTER_API_KEY?.trim() || "";

const g = globalThis as unknown as { __mcKey?: { at: number; v: KeyInfo }; __mcDay?: { day: string; n: number } };
const FIELDS = ["label", "usage", "usage_daily", "usage_weekly", "usage_monthly", "limit", "limit_remaining", "limit_reset", "is_free_tier", "rate_limit"];

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
export const resetKeyInfo = () => { g.__mcKey = undefined; };

const utc = () => new Date().toISOString().slice(0, 10);
/** Requests this dashboard sent to OpenRouter today (UTC), counted locally: OpenRouter does not report "used today". */
export function countRequest() {
  if (g.__mcDay?.day !== utc()) g.__mcDay = { day: utc(), n: 0 };
  g.__mcDay.n++;
}
export const requestsToday = () => (g.__mcDay?.day === utc() ? g.__mcDay.n : 0);
