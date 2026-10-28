import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { allowedModels, freeToolModels, PREFERRED, recordModel, resetScores, resolveModels } from "@/lib/assistant/models";

const m = (id: string, o: any = {}) => ({ id, hugging_face_id: "org/x", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "temperature"], ...o });
beforeEach(() => { (globalThis as any).__mcModels = undefined; resetScores(); });
afterEach(() => vi.useRealTimers());

test("allowlist = :free AND zero price AND open weights AND tools, nothing else", () => {
  const ids = freeToolModels([
    m("a/ok:free"),
    m("b/paid-but-free-suffix:free", { pricing: { prompt: "0.000001", completion: "0" } }),
    m("c/no-tools:free", { supported_parameters: ["temperature"] }),
    m("d/closed:free", { hugging_face_id: "" }),
    m("e/paid", { pricing: { prompt: "0", completion: "0" } }), // zero price but not :free
    m("f/expired:free", { expiration_date: "2020-01-01" }),
    m("g/ok2:free", { expiration_date: "2999-01-01" }),
  ]);
  expect(ids).toEqual(["a/ok:free", "g/ok2:free"]);
});

test("a paid override is rejected with a clear error, never silently swapped", () => {
  const r = resolveModels({ MAILCRAFT_ASSISTANT_MODEL: "deepseek/deepseek-v4-flash" }, { ids: ["a/ok:free"], source: "openrouter" });
  expect(r).toMatchObject({ ok: false, code: "model_not_free" });
  expect((r as any).message).toContain("deepseek/deepseek-v4-flash");
});

test("a free override pins the first model, the rest follow in preference order", () => {
  const ids = [...PREFERRED, "z/extra:free"];
  const r = resolveModels({ MAILCRAFT_ASSISTANT_MODEL: PREFERRED[3] }, { ids, source: "openrouter" });
  expect(r).toMatchObject({ ok: true, overridden: true });
  if (r.ok) { expect(r.chain[0]).toBe(PREFERRED[3]); expect(r.chain.slice(1, 4)).toEqual([PREFERRED[0], PREFERRED[1], PREFERRED[2]]); expect(r.chain.at(-1)).toBe("z/extra:free"); }
});

test("MAILCRAFT_LLM_MODEL is used only when it qualifies; an unfit one is ignored, not an error", () => {
  const allowed = { ids: [...PREFERRED], source: "openrouter" as const };
  expect(resolveModels({ MAILCRAFT_LLM_MODEL: PREFERRED[2] }, allowed)).toMatchObject({ ok: true, chain: expect.arrayContaining([PREFERRED[2]]) });
  const r = resolveModels({ MAILCRAFT_LLM_MODEL: "deepseek/deepseek-v4-flash" }, allowed);
  expect(r.ok && r.chain[0]).toBe(PREFERRED[0]);
  expect(r.ok && r.chain.every((x) => x.endsWith(":free"))).toBe(true);
});

test("default order is the preference list; measured latency and errors reorder it", () => {
  const allowed = { ids: [...PREFERRED], source: "openrouter" as const };
  expect((resolveModels({}, allowed) as any).chain.slice(0, 2)).toEqual(PREFERRED.slice(0, 2));
  recordModel(PREFERRED[0], null); recordModel(PREFERRED[0], null); // keeps failing
  recordModel(PREFERRED[3], 400); // fast
  const chain = (resolveModels({}, allowed) as any).chain;
  expect(chain[0]).toBe(PREFERRED[3]);
  expect(chain.indexOf(PREFERRED[0])).toBeGreaterThan(1);
});

test("the model list is fetched from OpenRouter, filtered, and cached for an hour", async () => {
  vi.useFakeTimers();
  const f = vi.fn(async () => Response.json({ data: [m("a/ok:free"), m("b/paid", { pricing: { prompt: "1", completion: "1" } })] }));
  expect((await allowedModels(f as any)).ids).toEqual(["a/ok:free"]);
  await allowedModels(f as any);
  expect(f).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3_600_001);
  await allowedModels(f as any);
  expect(f).toHaveBeenCalledTimes(2);
});

test("when the list cannot be fetched the built-in list (all :free) is used, or the stale cache", async () => {
  const down = vi.fn(async () => { throw new Error("offline"); });
  const a = await allowedModels(down as any);
  expect(a.source).toBe("builtin");
  expect(a.ids.every((x) => x.endsWith(":free"))).toBe(true);
  expect(resolveModels({ MAILCRAFT_ASSISTANT_MODEL: "some/other:free" }, a)).toMatchObject({ ok: false }); // cannot verify it
});
