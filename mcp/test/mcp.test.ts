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
