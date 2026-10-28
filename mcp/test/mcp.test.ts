import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

let seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let respond: (url: string) => [number, unknown] = () => [200, { ok: true, data: {}, request_id: "req_1" }];
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const [code, json] = respond(req.url!);
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(json));
  });
});
let url = "";
beforeAll(async () => { await new Promise<void>((r) => srv.listen(0, r)); url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; });
afterAll(() => { srv.close(); });

async function client(o: { readOnly?: boolean; only?: string[] } = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer({ apiUrl: url, apiKey: () => "mc_test_abc", ...o }).connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  return c;
}

test("lists all tools, none of the forbidden ones", async () => {
  const names = (await (await client()).listTools()).tools.map((t) => t.name);
  expect(names.length).toBe(TOOLS.length);
  for (const bad of ["approval_decide", "policy_set", "kill_switch_off", "go_live_approve"]) expect(names).not.toContain(bad);
  expect(names).toContain("kill_switch_engage");
});

test("--read-only drops mutating tools; --tools filters", async () => {
  const ro = (await (await client({ readOnly: true })).listTools()).tools;
  expect(ro.length).toBeGreaterThan(10);
  expect(ro.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  expect(ro.map((t) => t.name)).not.toContain("email_send");
  expect(ro.map((t) => t.name)).toContain("template_preview");
  const only = (await (await client({ only: ["email_send", "doctor"] })).listTools()).tools.map((t) => t.name).sort();
  expect(only).toEqual(["doctor", "email_send"]);
});

test("annotations: destructive and read-only", async () => {
  const tools = (await (await client()).listTools()).tools;
  const by = (n: string) => tools.find((t) => t.name === n)!.annotations!;
  expect(by("contact_delete").destructiveHint).toBe(true);
  expect(by("email_send").destructiveHint).toBe(false);
  expect(by("email_send").readOnlyHint).toBe(false);
  expect(by("email_get").readOnlyHint).toBe(true);
  expect(by("contact_upsert").idempotentHint).toBe(true);
});

test("email_send hits POST /v1/emails with auth + Idempotency-Key and returns envelope + schema:1", async () => {
  seen = [];
  const c = await client();
  const r: any = await c.callTool({ name: "email_send", arguments: { to: ["a@b.co"], subject: "hi", text: "x", idempotency_key: "k-1", dry_run: true } });
  const s = seen[0];
  expect(s.method).toBe("POST");
  expect(s.url).toBe("/v1/emails");
  expect(s.headers.authorization).toBe("Bearer mc_test_abc");
  expect(s.headers["idempotency-key"]).toBe("k-1");
  expect(JSON.parse(s.body)).toEqual({ to: ["a@b.co"], subject: "hi", text: "x", dry_run: true });
  expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, schema: 1, request_id: "req_1" });
  expect(r.isError).toBeUndefined();
});

test("path params are encoded, GET args go to the query, kill switch body fixed", async () => {
  seen = [];
  const c = await client();
  await c.callTool({ name: "contact_get", arguments: { id_or_email: "a+b@x.co" } });
  await c.callTool({ name: "email_list", arguments: { status: "queued", limit: 5 } });
  await c.callTool({ name: "kill_switch_engage", arguments: {} });
  expect(seen[0].url).toBe("/v1/contacts/a%2Bb%40x.co");
  expect(seen[1].url).toBe("/v1/emails?status=queued&limit=5");
  expect(seen[2].url).toBe("/v1/kill-switch");
  expect(JSON.parse(seen[2].body)).toEqual({ on: true });
});

test("API errors pass through as isError with code/hint intact", async () => {
  const error = { code: "domain_not_verified", message: "m", hint: "run domain_check", doc_url: "d", retryable: false };
  respond = () => [403, { ok: false, error, request_id: "req_9" }];
  const r: any = await (await client()).callTool({ name: "email_send", arguments: { to: ["a@b.co"] } });
  respond = () => [200, { ok: true, data: {}, request_id: "req_1" }];
  expect(r.isError).toBe(true);
  expect(JSON.parse(r.content[0].text)).toEqual({ ok: false, error, request_id: "req_9", schema: 1 });
});

test("network failure is an isError result without leaking the key", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer({ apiUrl: "http://127.0.0.1:1", apiKey: () => "mc_test_secret" }).connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  const r: any = await c.callTool({ name: "doctor", arguments: {} });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).not.toContain("mc_test_secret");
  expect(JSON.parse(r.content[0].text).error.code).toBe("network_error");
});

test("settings_set_instructions PUTs /v1/settings, is destructive, and honours API errors", async () => {
  seen = [];
  const c = await client();
  const tools = (await c.listTools()).tools;
  expect(tools.find((t) => t.name === "settings_set_instructions")!.annotations!.destructiveHint).toBe(true);
  expect(tools.find((t) => t.name === "settings_get_instructions")!.annotations!.readOnlyHint).toBe(true);
  await c.callTool({ name: "settings_set_instructions", arguments: { custom_instructions: "Be warm." } });
  expect(seen[0].method).toBe("PUT");
  expect(seen[0].url).toBe("/v1/settings");
  expect(JSON.parse(seen[0].body)).toEqual({ custom_instructions: "Be warm." });
  respond = () => [403, { ok: false, error: { code: "forbidden_scope", message: "admin", hint: "use admin" }, request_id: "r" }];
  const r: any = await c.callTool({ name: "settings_set_instructions", arguments: { custom_instructions: "x" } });
  respond = () => [200, { ok: true, data: {}, request_id: "req_1" }];
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("forbidden_scope");
});

// [tool, args, "METHOD path", body sent]: the routes added with broadcasts, the contact/segment/automation/template editors and the list filters.
test.each<[string, Record<string, unknown>, string, unknown]>([
  ["email_list", { q: "ana", from: "2026-10-01", to: "2026-10-31", stream: "marketing", env: "test", limit: 5 }, "GET /v1/emails?stream=marketing&env=test&q=ana&from=2026-10-01&to=2026-10-31&limit=5", undefined],
  ["broadcast_send", { template_id: "welcome", from: "a@b.co", recipients: [{ email: "x@y.co", data: { plan: "pro" } }], dry_run: true, idempotency_key: "k" }, "POST /v1/broadcasts", { template_id: "welcome", from: "a@b.co", recipients: [{ email: "x@y.co", data: { plan: "pro" } }], dry_run: true }],
  ["broadcast_preview", { template_id: "welcome", recipient: { email: "x@y.co", first_name: "Xi" } }, "POST /v1/broadcasts/preview", { template_id: "welcome", recipient: { email: "x@y.co", first_name: "Xi" } }],
  ["broadcast_list", { limit: 2 }, "GET /v1/broadcasts?limit=2", undefined],
  ["broadcast_get", { id: "b1", status: "bounced", limit: 10 }, "GET /v1/broadcasts/b1?status=bounced&limit=10", undefined],
  ["contact_list", { q: "ana" }, "GET /v1/contacts?q=ana", undefined],
  ["contact_update", { id_or_email: "a+b@x.co", first_name: "Ana", properties: { plan: null } }, "PATCH /v1/contacts/a%2Bb%40x.co", { first_name: "Ana", properties: { plan: null } }],
  ["contact_activity", { id_or_email: "a@x.co" }, "GET /v1/contacts/a%40x.co/activity", undefined],
  ["contact_import", { contacts: [{ email: "a@x.co", timezone: "Europe/Berlin" }] }, "POST /v1/contacts/import", { contacts: [{ email: "a@x.co", timezone: "Europe/Berlin" }] }],
  ["segment_create", { name: "pro", filter: { field: "properties.plan", op: "eq", value: "pro" } }, "POST /v1/segments", { name: "pro", filter: { field: "properties.plan", op: "eq", value: "pro" } }],
  ["segment_list", {}, "GET /v1/segments", undefined],
  ["segment_preview", { filter: { field: "email", op: "contains", value: "@x.co" } }, "POST /v1/segments/preview", { filter: { field: "email", op: "contains", value: "@x.co" } }],
  ["segment_update", { id: "s1", name: "everyone", filter: null }, "PUT /v1/segments/s1", { name: "everyone", filter: null }],
  ["segment_delete", { id: "s1" }, "DELETE /v1/segments/s1", undefined],
  ["segment_add_members", { id: "s1", emails: ["a@x.co"] }, "POST /v1/segments/s1/members", { emails: ["a@x.co"] }],
  ["event_names", {}, "GET /v1/events/names", undefined],
  ["automation_list", { status: "archived" }, "GET /v1/automations?status=archived", undefined],
  ["automation_archive", { id: "welcome" }, "POST /v1/automations/welcome/archive", {}],
  ["automation_unarchive", { id: "welcome" }, "POST /v1/automations/welcome/unarchive", {}],
  ["automation_test", { id: "welcome", email: "a@x.co", properties: { plan: "pro" } }, "POST /v1/automations/welcome/test", { email: "a@x.co", properties: { plan: "pro" } }],
  ["automation_run_get", { id: "welcome", run: "r1" }, "GET /v1/automations/welcome/runs/r1", undefined],
  ["automation_runs", { id: "welcome", status: "failed" }, "GET /v1/automations/welcome/runs?status=failed", undefined],
  ["template_create", { name: "Hello", alias: "hello", stream: "marketing", content: "<p>hi</p>", format: "html" }, "POST /v1/templates", { name: "Hello", alias: "hello", stream: "marketing", content: "<p>hi</p>", format: "html" }],
  ["template_update", { id: "hello", alias: "hi", preheader: "", html: "<p>x</p>" }, "PATCH /v1/templates/hello", { alias: "hi", preheader: "", html: "<p>x</p>" }],
  ["template_publish", { id: "hello", version: 2 }, "POST /v1/templates/hello/publish", { version: 2 }],
  ["template_preview", { id: "hello", variables: { first_name: "Ana" }, html: "<p>{{ first_name }}</p>", subject: "Hi" }, "POST /v1/templates/hello/preview", { variables: { first_name: "Ana" }, html: "<p>{{ first_name }}</p>", subject: "Hi" }],
  ["template_versions", { id: "hello" }, "GET /v1/templates/hello/versions", undefined],
  ["template_version_get", { id: "hello", version: 3 }, "GET /v1/templates/hello/versions/3", undefined],
  ["template_restore", { id: "hello", version: 3 }, "POST /v1/templates/hello/versions/3/restore", {}],
  ["template_discard_draft", { id: "hello" }, "DELETE /v1/templates/hello/draft", undefined],
])("%s hits the route", async (tool, args, line, body) => {
  seen = [];
  const r: any = await (await client()).callTool({ name: tool, arguments: args });
  expect(r.isError).toBeUndefined();
  expect(`${seen[0].method} ${seen[0].url}`).toBe(line);
  expect(seen[0].body ? JSON.parse(seen[0].body) : undefined).toEqual(body);
});

test("sending and destructive tools keep their safety conventions", async () => {
  const tools = (await (await client()).listTools()).tools;
  const by = (n: string) => tools.find((t) => t.name === n)!;
  for (const n of ["segment_delete", "segment_update", "template_discard_draft"]) expect(by(n).annotations!.destructiveHint).toBe(true);
  for (const n of ["broadcast_send", "automation_test", "contact_import", "template_restore"]) {
    expect(by(n).annotations!.destructiveHint).toBe(false);
    expect(by(n).annotations!.readOnlyHint).toBe(false);
    expect(by(n).inputSchema.properties).toHaveProperty("idempotency_key");
  }
  for (const n of ["broadcast_send", "automation_test"]) expect(by(n).description).toMatch(/test key/i);
  expect(by("broadcast_send").description).toMatch(/dry_run/);
  expect(by("broadcast_send").inputSchema.properties).toHaveProperty("dry_run");
  for (const n of ["broadcast_preview", "broadcast_list", "broadcast_get", "segment_preview", "contact_activity", "event_names", "automation_run_get", "template_versions", "template_version_get"]) expect(by(n).annotations!.readOnlyHint).toBe(true);
  // --read-only drops every new mutating tool and keeps the previews
  const ro = (await (await client({ readOnly: true })).listTools()).tools.map((t) => t.name);
  for (const n of ["broadcast_send", "automation_test", "contact_import", "segment_delete", "template_discard_draft", "automation_archive"]) expect(ro).not.toContain(n);
  for (const n of ["broadcast_preview", "segment_preview", "automation_run_get"]) expect(ro).toContain(n);
});

test("broadcast_send caps recipients at 5000 and requires from + template", async () => {
  const c = await client();
  seen = [];
  const big: any = await c.callTool({ name: "broadcast_send", arguments: { template_id: "t", from: "a@b.co", recipients: Array.from({ length: 5001 }, (_, i) => ({ email: `u${i}@x.co` })) } });
  const none: any = await c.callTool({ name: "broadcast_send", arguments: { template_id: "t", recipients: [{ email: "a@x.co" }] } });
  expect(big.isError).toBe(true);
  expect(none.isError).toBe(true);
  expect(seen).toEqual([]);
});
