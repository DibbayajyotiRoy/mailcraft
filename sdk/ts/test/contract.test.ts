// Serves the real API envelope shapes (docs/contract/fixtures.json) through the SDK's fetch hook.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { Mailcraft } from "../src/index.js";

const fx: Record<string, { status: number; body: any }> = JSON.parse(readFileSync(new URL("../../../docs/contract/fixtures.json", import.meta.url), "utf8"));
const ID = "0192f3a0-7b1c-7a10-8000-000000000001";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const seen: { line: string; body?: any }[] = [];
let fixed: string | undefined;
const fetchFn = (async (u: string, i?: RequestInit) => {
  const path = new URL(u).pathname;
  const f = fx[fixed ?? `${i?.method} ${path.replace(UUID, "{id}")}`];
  seen.push({ line: `${i?.method} ${new URL(u).pathname + new URL(u).search}`, body: i?.body ? JSON.parse(i.body as string) : undefined });
  return new Response(JSON.stringify(f?.body ?? { ok: false, error: { code: "not_found", message: "no fixture" } }), { status: f?.status ?? 404 });
}) as unknown as typeof fetch;
const mc = new Mailcraft("mc_test_k", { baseUrl: "http://api.test", fetch: fetchFn });

// [call, request line, fixture key]
const cases: [() => Promise<{ data: unknown; error: unknown; requestId?: string }>, string, string][] = [
  [() => mc.emails.send({ to: ["delivered@test.mailcraft.local"], subject: "s", text: "t" }), "POST /v1/emails", "POST /v1/emails"],
  [() => mc.emails.get(ID), `GET /v1/emails/${ID}`, "GET /v1/emails/{id}"],
  [() => mc.emails.list({ status: "queued", limit: 2 }), "GET /v1/emails?status=queued&limit=2", "GET /v1/emails"],
  [() => mc.emails.events(ID), `GET /v1/emails/${ID}/events`, "GET /v1/emails/{id}/events"],
  [() => mc.emails.cancel(ID), `POST /v1/emails/${ID}/cancel`, "POST /v1/emails/{id}/cancel"],
  [() => mc.keys.create({ name: "agent", env: "test", scopes: ["read", "send"] }), "POST /v1/keys", "POST /v1/keys"],
  [() => mc.keys.list(), "GET /v1/keys", "GET /v1/keys"],
  [() => mc.keys.revoke(ID), `DELETE /v1/keys/${ID}`, "DELETE /v1/keys/{id}"],
  [() => mc.approvals.list({ status: "pending" }), "GET /v1/approvals?status=pending", "GET /v1/approvals"],
  [() => mc.approvals.get(ID), `GET /v1/approvals/${ID}`, "GET /v1/approvals/{id}"],
  [() => mc.approvals.decide(ID, "approve"), `POST /v1/approvals/${ID}/decide`, "POST /v1/approvals/{id}/decide"],
  [() => mc.goLive.request("ready"), "POST /v1/go-live-requests", "POST /v1/go-live-requests"],
  [() => mc.policy.propose(ID, { send: "blocked" }), "POST /v1/policy/proposals", "POST /v1/policy/proposals"],
  [() => mc.killSwitch.get(), "GET /v1/kill-switch", "GET /v1/kill-switch"],
  [() => mc.killSwitch.set(true), "POST /v1/kill-switch", "POST /v1/kill-switch"],
  [() => mc.account.status(), "GET /v1/account/status", "GET /v1/account/status"],
  [() => mc.audit.list({ limit: 5, before: 9 }), "GET /v1/audit?limit=5&before=9", "GET /v1/audit"],
];

test.each(cases)("request line + real envelope: %#", async (call, line, key) => {
  fixed = undefined;
  seen.length = 0;
  const r = await call();
  expect(seen[0].line).toBe(line);
  expect(r.error).toBeNull();
  expect(r.data).toEqual(fx[key].body.data);
  expect(r.requestId).toBe(fx[key].body.request_id);
});

test("list pages expose next_cursor; kill-switch body; request body shapes", async () => {
  fixed = undefined;
  expect(((await mc.emails.list()) as { nextCursor?: string | null }).nextCursor).toBe(fx["GET /v1/emails"].body.next_cursor);
  seen.length = 0;
  await mc.killSwitch.set(true);
  await mc.policy.propose(ID, { send: "blocked" });
  expect(seen.map((s) => s.body)).toEqual([{ on: true }, { key_id: ID, policy: { send: "blocked" } }]);
});

test("typed fields exist on real fixtures (type drift check)", async () => {
  fixed = undefined;
  const e = (await mc.emails.get(ID)).data!;
  expect([e.from_addr, e.to_addr, e.attempts]).toEqual(["hi@example.com", "delivered@test.mailcraft.local", 0]);
  expect((await mc.account.status()).data!.key.env).toBe("test");
  expect((await mc.keys.create({ name: "a", env: "test", scopes: ["read"] })).data!.token).toMatch(/^mc_test_/);
});

test("errors keep the real structured shape", async () => {
  fixed = "ERROR forbidden_scope";
  const r = await mc.approvals.decide(ID, "approve");
  fixed = undefined;
  expect(r.data).toBeNull();
  expect(r.error).toEqual(fx["ERROR forbidden_scope"].body.error);
});
