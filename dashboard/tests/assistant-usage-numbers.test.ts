// OpenRouter's free-request numbers: where they come from (X-RateLimit-* on responses, /key's free_model_daily_requests), which
// one wins, and how the reset is worded. The key's credit limit is spend and is covered by the UI tests, not here.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { failure } from "@/lib/assistant/loop";
import { streamChat, UpstreamError } from "@/lib/assistant/openrouter";
import { dailyCapMessage, nextUtcMidnight, resetLine, shown, until, utcClock } from "@/lib/assistant/reset";
import { freeToday, keyInfo, readRateLimit, resetKeyInfo } from "@/lib/assistant/usage";

process.env.MAILCRAFT_ASSISTANT_BASE_URL = "http://or.test/api/v1";
const NOW = Date.UTC(2026, 9, 28, 12, 0), RESET = Date.UTC(2026, 9, 28, 17, 0), MIDNIGHT = Date.UTC(2026, 9, 29, 0, 0);

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); resetKeyInfo(); process.env.OPENROUTER_API_KEY = "or-key"; });
afterEach(() => { vi.useRealTimers(); delete process.env.OPENROUTER_API_KEY; });

const RL = { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "31", "X-RateLimit-Reset": String(RESET) };
const ok = (headers: Record<string, string> = {}) => new Response(new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) + "\n\ndata: [DONE]\n\n").body, { status: 200, headers });
const err429 = (message: string, headers: Record<string, string> = {}, metadataHeaders?: Record<string, string>) =>
  new Response(JSON.stringify({ error: { message, code: 429, ...(metadataHeaders && { metadata: { headers: metadataHeaders } }) } }), { status: 429, headers });
const call = (res: Response) => streamChat({ key: "k", body: {}, firstTokenMs: 1000, onText() {}, onFirst() {}, fetchImpl: (async () => res) as never });
const fail = async (res: Response) => (await call(res).then(() => undefined, (e) => e)) as UpstreamError;
const keyWith = (data: object) => keyInfo((async () => Response.json({ data })) as never);

describe("capturing X-RateLimit-* from OpenRouter responses", () => {
  test("a successful response that carries them is recorded", async () => {
    expect(freeToday()).toBeNull();
    await call(ok(RL));
    expect(freeToday()).toEqual({ limit: 50, remaining: 31, resetAt: RESET, source: "headers" });
  });

  test("a successful response without them (what OpenRouter documents) changes nothing", async () => {
    await call(ok());
    expect(freeToday()).toBeNull();
    await call(ok(RL));
    await call(ok());
    expect(freeToday()?.remaining).toBe(31); // the last numbers seen stay until something newer or the reset
  });

  test("the latest response wins", async () => {
    await call(ok(RL));
    await call(ok({ ...RL, "X-RateLimit-Remaining": "30" }));
    expect(freeToday()?.remaining).toBe(30);
  });

  test("a free-models-per-day 429: remaining is 0, the reset comes from the headers and rides on the error", async () => {
    const e = await fail(err429("Rate limit exceeded: free-models-per-day", { ...RL, "X-RateLimit-Remaining": "0" }));
    expect(e).toMatchObject({ code: "rate_limited", status: 429, resetAt: RESET });
    expect(freeToday()).toEqual({ limit: 50, remaining: 0, resetAt: RESET, source: "headers" });
  });

  test("the same numbers in the 429 body's error.metadata.headers are read too, whatever their case", async () => {
    const e = await fail(err429("Rate limit exceeded: free-models-per-day", {}, { "x-ratelimit-limit": "1000", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(RESET) }));
    expect(e.resetAt).toBe(RESET);
    expect(freeToday()).toMatchObject({ limit: 1000, remaining: 0, resetAt: RESET });
  });

  test("free-models-per-day with no headers at all still means 0 left, until the next UTC midnight", async () => {
    const e = await fail(err429("Rate limit exceeded: free-models-per-day"));
    expect(e.resetAt).toBeUndefined(); // failure() falls back to the UTC midnight
    expect(freeToday()).toEqual({ limit: null, remaining: 0, resetAt: MIDNIGHT, source: "headers" });
  });

  test("a reset in epoch seconds is scaled to ms", () => {
    expect(readRateLimit(new Headers({ "X-RateLimit-Reset": String(RESET / 1000) })).resetAt).toBe(RESET);
  });

  test("a per-minute 429 says nothing about today and records nothing", async () => {
    const e = await fail(err429("Rate limit exceeded: free-models-per-min", { "X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(NOW + 20_000) }));
    expect(e).toMatchObject({ code: "rate_limited", resetAt: undefined });
    expect(freeToday()).toBeNull();
  });

  test("a 429 from a provider with no OpenRouter headers records nothing", async () => {
    await fail(err429("Provider returned error"));
    expect(freeToday()).toBeNull();
  });
});

describe("which number is shown", () => {
  test("/key's free_model_daily_requests, reset at the next UTC midnight", async () => {
    await keyWith({ is_free_tier: true, limit_remaining: 50, free_model_daily_requests: { used: 8, limit: 50, remaining: 42 } });
    expect(freeToday()).toEqual({ limit: 50, remaining: 42, resetAt: MIDNIGHT, source: "key" });
  });

  test("/key without it (an older API, an exempt account): nothing is claimed", async () => {
    await keyWith({ is_free_tier: true, limit_remaining: 50 });
    expect(freeToday()).toBeNull();
  });

  test("a 429 seen after the last /key poll beats the cached /key; the next poll takes over again", async () => {
    await keyWith({ free_model_daily_requests: { used: 8, limit: 50, remaining: 42 } });
    vi.setSystemTime(NOW + 5_000);
    await fail(err429("Rate limit exceeded: free-models-per-day", { ...RL, "X-RateLimit-Remaining": "0" }));
    expect(freeToday()).toMatchObject({ remaining: 0, resetAt: RESET, source: "headers" });
    vi.setSystemTime(NOW + 61_000); // /key is cached for 60s, then polled again
    await keyWith({ free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } });
    expect(freeToday()).toMatchObject({ remaining: 0, source: "key" });
  });

  test("a 429 before a newer /key poll is superseded by it (the header numbers are older)", async () => {
    await fail(err429("Rate limit exceeded: free-models-per-day", { ...RL, "X-RateLimit-Remaining": "0" }));
    vi.setSystemTime(NOW + 1_000);
    await keyWith({ free_model_daily_requests: { used: 20, limit: 1000, remaining: 980 } }); // credits were bought since
    expect(freeToday()).toMatchObject({ limit: 1000, remaining: 980, source: "key" });
  });

  test("without /key's counter, the 429's numbers stay until their reset, then nothing is claimed", async () => {
    await fail(err429("Rate limit exceeded: free-models-per-day", { ...RL, "X-RateLimit-Remaining": "0" }));
    vi.setSystemTime(NOW + 10 * 60_000);
    await keyWith({ is_free_tier: true });
    expect(freeToday()).toMatchObject({ remaining: 0, resetAt: RESET });
    vi.setSystemTime(RESET + 1);
    expect(freeToday()).toBeNull();
  });
});

describe("what the user is told", () => {
  beforeEach(() => { process.env.TZ = "Asia/Kolkata"; }); // UTC+5:30: 12:00 UTC is 17:30, the next UTC midnight is 05:30
  afterEach(() => { delete process.env.TZ; });

  test("until: rounded up, never 'now' while a minute is left", () => {
    expect(until(NOW + (9 * 60 + 12) * 60_000, NOW)).toBe("in 9h 12m");
    expect(until(NOW + 9 * 3_600_000, NOW)).toBe("in 9h");
    expect(until(NOW + 12 * 60_000 + 1, NOW)).toBe("in 13m");
    expect(until(NOW + 1, NOW)).toBe("in 1m");
    expect(until(NOW, NOW)).toBe("now");
    expect(until(NOW - 5, NOW)).toBe("now");
  });

  test("nextUtcMidnight is the coming 00:00 UTC, also exactly at midnight and one ms before it", () => {
    expect(nextUtcMidnight(NOW)).toBe(MIDNIGHT);
    expect(nextUtcMidnight(MIDNIGHT)).toBe(MIDNIGHT + 864e5);
    expect(nextUtcMidnight(MIDNIGHT - 1)).toBe(MIDNIGHT);
    vi.setSystemTime(Date.UTC(2026, 11, 31, 23, 59)); // year end
    expect(new Date(nextUtcMidnight()).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  test("resetLine is the viewer's local clock plus the relative time", () => {
    expect(resetLine(MIDNIGHT, NOW)).toMatch(/^resets 05:30.* · in 12h$/);
    expect(utcClock(MIDNIGHT)).toBe("00:00 UTC");
  });

  test("the daily-cap sentence uses resetAt when known, else the next UTC midnight", () => {
    expect(dailyCapMessage(RESET, NOW)).toMatch(/^Today's free AI requests are used up\. They reset at 10:30 PM \(in 5h\)\.$/);
    expect(dailyCapMessage(undefined, NOW)).toMatch(/^Today's free AI requests are used up\. They reset at 05:30.* \(in 12h\)\.$/);
  });

  test("shown() finishes only the errors that carry a resetAt", () => {
    expect(shown({ message: "Rate limited", resetAt: undefined })).toEqual({ message: "Rate limited", resetAt: undefined });
    expect(shown({ code: "x", message: "Today's free AI requests are used up.", resetAt: RESET }).message).toMatch(/They reset at 10:30 PM/);
  });

  test("failure(): the daily cap carries resetAt (from OpenRouter, else UTC midnight); a per-minute 429 does not claim 'today'", () => {
    expect(failure(new UpstreamError("rate_limited", "Rate limit exceeded: free-models-per-day", 429, RESET))).toMatchObject({ type: "error", code: "rate_limited", message: "Today's free AI requests are used up.", resetAt: RESET });
    expect(failure(new UpstreamError("rate_limited", "Rate limit exceeded: free-models-per-day", 429))).toMatchObject({ resetAt: MIDNIGHT });
    const minute = failure(new UpstreamError("rate_limited", "Rate limit exceeded: free-models-per-min", 429)) as { message: string; resetAt?: number };
    expect(minute.message).toBe("Free models are rate-limited right now.");
    expect(minute.resetAt).toBeUndefined();
  });
});
