// Real OpenRouter smoke test (skipped unless ASSISTANT_SMOKE=1). Free-tier keys allow only a handful of requests a day:
//   node scripts/mock-api.mjs 18461 &
//   ASSISTANT_SMOKE=1 SMOKE_API=http://127.0.0.1:18461 npx vitest run tests/assistant-smoke.test.ts
// The key is read from OPENROUTER_API_KEY or the file named by OPENROUTER_KEY_FILE and is never printed.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { runTurn } from "@/lib/assistant/loop";
import { allowedModels, resolveModels } from "@/lib/assistant/models";
import { keyInfo } from "@/lib/assistant/usage";
import type { ChatEvent } from "@/lib/assistant/types";

const on = process.env.ASSISTANT_SMOKE === "1";
const key = () => (process.env.OPENROUTER_API_KEY || readFileSync(process.env.OPENROUTER_KEY_FILE || "/home/roy/.config/mailcraft/openrouter-key", "utf8")).trim();

async function run(text: string, path: string) {
  process.env.OPENROUTER_API_KEY = key();
  const m = resolveModels(process.env, await allowedModels());
  if (!m.ok) throw new Error(m.message);
  const ev: ChatEvent[] = [];
  for await (const e of runTurn({ history: [{ role: "user", content: text }], path, ctx: { base: process.env.SMOKE_API!, key: "mc_test_smoke", sid: "smoke-" + Date.now(), env: "test" }, key: key(), chain: m.chain, log: () => {} })) ev.push(e);
  const done = ev.find((e) => e.type === "done") as Extract<ChatEvent, { type: "done" }> | undefined;
  console.log(JSON.stringify({ ask: text, page: path, chain: m.chain.slice(0, 3), stats: done?.stats, tools: ev.filter((e) => e.type === "tool" && e.status !== "running").map((e: any) => `${e.name}:${e.status}`), proposals: ev.filter((e) => e.type === "proposal").map((e: any) => e.proposal.title), error: ev.find((e) => e.type === "error"), text: ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("").slice(0, 400) }, null, 1));
  return ev;
}

test.skipIf(!on)("key info is readable (free tier?)", async () => {
  process.env.OPENROUTER_API_KEY = key();
  const k = await keyInfo();
  console.log(JSON.stringify(k.ok ? { ok: true, is_free_tier: k.data.is_free_tier, usage: k.data.usage, limit_remaining: k.data.limit_remaining, rate_limit: k.data.rate_limit } : k));
  expect(k.ok).toBe(true);
}, 30_000);

test.skipIf(!on)("drafts an automation", async () => {
  const ev = await run("Draft an automation that sends the welcome template 5 minutes after someone signs up (event signed_up).", "/");
  expect(ev.at(-1)?.type).toBe("done");
  expect(ev.some((e) => e.type === "proposal")).toBe(true);
}, 150_000);

test.skipIf(!on)("fixes a template with a lint error from the page context", async () => {
  const ev = await run("Fix the lint errors in this template.", "/templates/t4");
  expect(ev.at(-1)?.type).toBe("done");
  expect(ev.some((e) => e.type === "proposal")).toBe(true);
}, 150_000);
