// Wording for "when do my free requests come back". Pure, no imports: the server sends epoch ms, the browser formats it in the viewer's zone.

/** Next 00:00 UTC: when OpenRouter's free-model day (and the local tally) rolls over. */
export const nextUtcMidnight = (now = Date.now()) => (Math.floor(now / 864e5) + 1) * 864e5;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** "in 9h 12m" / "in 12m" / "now". Rounded up, so it never says "now" while a minute is left. */
export function until(at: number, now = Date.now()) {
  const m = Math.max(0, Math.ceil((at - now) / 60_000)), h = Math.floor(m / 60);
  return m === 0 ? "now" : h ? `in ${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `in ${m}m`;
}
/** "resets 05:30 · in 9h 12m" */
export const resetLine = (at: number, now = Date.now()) => `resets ${clock(at)} · ${until(at, now)}`;
/** Same moment in UTC, for the server-rendered text before the browser's zone is known. */
export const utcClock = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

/** The daily-cap 429 as the user reads it. `at` unknown = the next UTC midnight. */
export const dailyCapMessage = (at = nextUtcMidnight(), now = Date.now()) => `Today's free AI requests are used up. They reset at ${clock(at)} (${until(at, now)}).`;
/** An error event as shown: the daily-cap one carries `resetAt`, and its sentence is built here, where the viewer's zone is known. */
export const shown = <E extends { message: string; resetAt?: number }>(e: E): E => (e.resetAt ? { ...e, message: dailyCapMessage(e.resetAt) } : e);
