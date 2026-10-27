// Serves the real API envelope shapes (docs/contract/fixtures.json) and checks each tool's request line.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

const fx: Record<string, { status: number; body: any }> = JSON.parse(readFileSync(new URL("../../docs/contract/fixtures.json", import.meta.url), "utf8"));
const ID = "0192f3a0-7b1c-7a10-8000-000000000001";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
let last = "";
let fixed: string | undefined;
const srv = createServer((req, res) => {
  const key = fixed ?? `${req.method} ${req.url!.split("?")[0].replace(UUID, "{id}")}`;
  last = `${req.method} ${req.url}`;
  const f = fx[key];
  res.writeHead(f?.status ?? 404, { "content-type": "application/json" }).end(JSON.stringify(f?.body ?? { ok: false, error: { code: "not_found", message: key } }));
});
let url = "";
beforeAll(async () => { await new Promise<void>((r) => srv.listen(0, r)); url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; });
afterAll(() => { srv.close(); });

async function call(name: string, args: Record<string, unknown>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer({ apiUrl: url, apiKey: () => "mc_test_abc" }).connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  const r: any = await c.callTool({ name, arguments: args });
  return { r, body: JSON.parse(r.content[0].text) };
}

const cases: [string, Record<string, unknown>, string, string][] = [
  ["account_status", {}, "GET /v1/account/status", "GET /v1/account/status"],
  ["email_send", { to: ["delivered@test.mailcraft.local"], subject: "s", text: "t" }, "POST /v1/emails", "POST /v1/emails"],
  ["email_get", { id: ID }, `GET /v1/emails/${ID}`, "GET /v1/emails/{id}"],
  ["email_list", { status: "queued", limit: 2 }, "GET /v1/emails?status=queued&limit=2", "GET /v1/emails"],
  ["email_events", { id: ID }, `GET /v1/emails/${ID}/events`, "GET /v1/emails/{id}/events"],
  ["email_cancel", { id: ID }, `POST /v1/emails/${ID}/cancel`, "POST /v1/emails/{id}/cancel"],
  ["approval_list", { status: "pending" }, "GET /v1/approvals?status=pending", "GET /v1/approvals"],
  ["approval_get", { id: ID }, `GET /v1/approvals/${ID}`, "GET /v1/approvals/{id}"],
  ["go_live_request", { note: "ready" }, "POST /v1/go-live-requests", "POST /v1/go-live-requests"],
  ["policy_propose", { key_id: ID, policy: { send: "blocked" } }, "POST /v1/policy/proposals", "POST /v1/policy/proposals"],
  ["kill_switch_status", {}, "GET /v1/kill-switch", "GET /v1/kill-switch"],
  ["kill_switch_engage", {}, "POST /v1/kill-switch", "POST /v1/kill-switch"],
  ["audit_list", { limit: 5, before: 9 }, "GET /v1/audit?limit=5&before=9", "GET /v1/audit"],
];

test.each(cases)("%s: request line and real envelope round-trip", async (tool, args, line, key) => {
  fixed = undefined;
  const { r, body } = await call(tool, args);
  expect(last).toBe(line);
  expect(r.isError).toBeUndefined();
  expect(body).toEqual({ ...fx[key].body, schema: 1 });
});

test("pending_approval send returns approval_id; API errors keep code/hint", async () => {
  fixed = "POST /v1/emails#pending";
  expect((await call("email_send", { to: ["a@example.com"] })).body.data.approval_id).toBe(fx[fixed].body.data.approval_id);
  fixed = "ERROR forbidden_scope";
  const { r, body } = await call("kill_switch_engage", {});
  expect(r.isError).toBe(true);
  expect(body.error).toEqual(fx[fixed].body.error);
  fixed = undefined;
});

test("tool set never exposes human-only actions", () => {
  const names = TOOLS.map((t) => t.name);
  for (const bad of ["approval_decide", "kill_switch_off", "key_create", "policy_set"]) expect(names).not.toContain(bad);
});
