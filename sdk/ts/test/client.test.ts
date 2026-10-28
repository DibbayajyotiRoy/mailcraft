import { expect, test, vi } from "vitest";
import { Mailcraft } from "../src/index.js";

const mk = (res: () => Response | Promise<Response>) => {
  const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => res());
  return { f, mc: new Mailcraft("mc_test_k", { baseUrl: "http://api.test/", fetch: f as unknown as typeof fetch }) };
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

test("emails.send posts with auth + Idempotency-Key and returns data", async () => {
  const { f, mc } = mk(() => json({ ok: true, request_id: "req_1", data: { id: "0192f3a0-7b1c-7a10-8000-000000000001", status: "queued" } }, 202));
  const r = await mc.emails.send({ from: "a@b.co", to: ["x@y.co"], subject: "hi", html: "<p>hi</p>" }, { idempotencyKey: "k1" });
  expect(r.error).toBeNull();
  expect(r.data?.id).toBe("0192f3a0-7b1c-7a10-8000-000000000001");
  expect(r.requestId).toBe("req_1");
  const [url, init] = f.mock.calls[0];
  expect(url).toBe("http://api.test/v1/emails");
  expect(init?.method).toBe("POST");
  const h = init?.headers as Record<string, string>;
  expect(h.Authorization).toBe("Bearer mc_test_k");
  expect(h["Idempotency-Key"]).toBe("k1");
  expect(JSON.parse(init?.body as string).to).toEqual(["x@y.co"]);
});

test("API errors come back as {data:null,error} and never throw", async () => {
  const error = { code: "domain_not_verified", message: "m", hint: "h", doc_url: "d", retryable: false };
  const { mc } = mk(() => json({ ok: false, request_id: "req_2", error }, 403));
  const r = await mc.emails.send({ to: ["x@y.co"] });
  expect(r.data).toBeNull();
  expect(r.error).toEqual(error);
});

test("network failure and non-JSON bodies become errors", async () => {
  const a = new Mailcraft("k", { fetch: (async () => { throw new Error("boom"); }) as unknown as typeof fetch });
  expect((await a.killSwitch.get()).error).toMatchObject({ code: "network_error", retryable: true });
  const { mc } = mk(() => new Response("<html>", { status: 502 }));
  expect((await mc.killSwitch.get()).error).toMatchObject({ code: "bad_response", retryable: true });
});

test("list passes query + cursor, path ids are encoded", async () => {
  const { f, mc } = mk(() => json({ ok: true, data: [], next_cursor: "c2" }));
  const r = await mc.emails.list({ status: "queued", limit: 5 });
  expect(r.data).toEqual([]);
  expect(r.error === null && r.nextCursor).toBe("c2");
  expect(f.mock.calls[0][0]).toBe("http://api.test/v1/emails?status=queued&limit=5");
  await mc.contacts.get("a+b@x.co");
  expect(f.mock.calls[1][0]).toBe("http://api.test/v1/contacts/a%2Bb%40x.co");
});

test("domains.verify, events.track, approvals.get hit the assumed routes", async () => {
  const { f, mc } = mk(() => json({ ok: true, data: {} }));
  await mc.domains.verify("0192f3a0-7b1c-7a10-8000-0000000000d1");
  await mc.events.track({ name: "signed_up", contact: { email: "a@b.co" } });
  await mc.approvals.get("0192f3a0-7b1c-7a10-8000-0000000000a1");
  expect(f.mock.calls.map((c) => `${c[1]?.method} ${c[0]}`)).toEqual([
    "POST http://api.test/v1/domains/0192f3a0-7b1c-7a10-8000-0000000000d1/verify", "POST http://api.test/v1/events", "GET http://api.test/v1/approvals/0192f3a0-7b1c-7a10-8000-0000000000a1",
  ]);
});

test("settings.instructions get/set/clear", async () => {
  const { f, mc } = mk(() => json({ ok: true, request_id: "r", data: { custom_instructions: "Be warm." } }));
  expect((await mc.settings.instructions.get()).data).toEqual({ custom_instructions: "Be warm." });
  await mc.settings.instructions.set("Hi");
  await mc.settings.instructions.clear();
  const bodies = f.mock.calls.slice(1).map((c) => [c[1]?.method, JSON.parse(c[1]?.body as string)]);
  expect(bodies).toEqual([["PUT", { custom_instructions: "Hi" }], ["PUT", { custom_instructions: "" }]]);
  const e = mk(() => json({ ok: false, error: { code: "forbidden_scope", message: "m" } }, 403));
  expect((await e.mc.settings.instructions.set("x")).error?.code).toBe("forbidden_scope");
});

// [call, "METHOD path", body]: every route added with broadcasts, the contact/segment/automation/template editors and the list filters.
test.each<[string, (mc: Mailcraft) => Promise<unknown>, string, unknown]>([
  ["emails.list filters", (mc) => mc.emails.list({ q: "ana", from: "2026-10-01", to: "2026-10-31", stream: "marketing", env: "test", limit: 5 }), "GET /v1/emails?q=ana&from=2026-10-01&to=2026-10-31&stream=marketing&env=test&limit=5", undefined],
  ["broadcasts.create", (mc) => mc.broadcasts.create({ template_id: "welcome", from: "a@b.co", recipients: [{ email: "x@y.co", data: { plan: "pro" } }], dry_run: true }, { idempotencyKey: "k" }), "POST /v1/broadcasts", { template_id: "welcome", from: "a@b.co", recipients: [{ email: "x@y.co", data: { plan: "pro" } }], dry_run: true }],
  ["broadcasts.list", (mc) => mc.broadcasts.list({ limit: 2, cursor: "c" }), "GET /v1/broadcasts?limit=2&cursor=c", undefined],
  ["broadcasts.get", (mc) => mc.broadcasts.get("b1", { status: "bounced" }), "GET /v1/broadcasts/b1?status=bounced", undefined],
  ["broadcasts.preview", (mc) => mc.broadcasts.preview({ template_id: "welcome", recipient: { email: "x@y.co" } }), "POST /v1/broadcasts/preview", { template_id: "welcome", recipient: { email: "x@y.co" } }],
  ["contacts.list q", (mc) => mc.contacts.list({ q: "ana" }), "GET /v1/contacts?q=ana", undefined],
  ["contacts.update", (mc) => mc.contacts.update("a+b@x.co", { first_name: "Ana", properties: { plan: null } }), "PATCH /v1/contacts/a%2Bb%40x.co", { first_name: "Ana", properties: { plan: null } }],
  ["contacts.activity", (mc) => mc.contacts.activity("a@x.co"), "GET /v1/contacts/a%40x.co/activity", undefined],
  ["contacts.import", (mc) => mc.contacts.import([{ email: "a@x.co", timezone: "Europe/Berlin" }]), "POST /v1/contacts/import", { contacts: [{ email: "a@x.co", timezone: "Europe/Berlin" }] }],
  ["segments.create", (mc) => mc.segments.create({ name: "pro", filter: { field: "properties.plan", op: "eq", value: "pro" } }), "POST /v1/segments", { name: "pro", filter: { field: "properties.plan", op: "eq", value: "pro" } }],
  ["segments.list", (mc) => mc.segments.list(), "GET /v1/segments", undefined],
  ["segments.preview", (mc) => mc.segments.preview({ field: "email", op: "contains", value: "@x.co" }), "POST /v1/segments/preview", { filter: { field: "email", op: "contains", value: "@x.co" } }],
  ["segments.update", (mc) => mc.segments.update("s1", { name: "everyone" }), "PUT /v1/segments/s1", { name: "everyone" }],
  ["segments.remove", (mc) => mc.segments.remove("s1"), "DELETE /v1/segments/s1", undefined],
  ["segments.addMembers", (mc) => mc.segments.addMembers("s1", ["a@x.co"]), "POST /v1/segments/s1/members", { emails: ["a@x.co"] }],
  ["events.names", (mc) => mc.events.names(), "GET /v1/events/names", undefined],
  ["automations.list status", (mc) => mc.automations.list({ status: "archived" }), "GET /v1/automations?status=archived", undefined],
  ["automations.archive", (mc) => mc.automations.archive("welcome"), "POST /v1/automations/welcome/archive", {}],
  ["automations.unarchive", (mc) => mc.automations.unarchive("welcome"), "POST /v1/automations/welcome/unarchive", {}],
  ["automations.test", (mc) => mc.automations.test("welcome", { email: "a@x.co", properties: { plan: "pro" } }), "POST /v1/automations/welcome/test", { email: "a@x.co", properties: { plan: "pro" } }],
  ["automations.run", (mc) => mc.automations.run("welcome", "r1"), "GET /v1/automations/welcome/runs/r1", undefined],
  ["automations.runs", (mc) => mc.automations.runs("welcome", { status: "failed", limit: 3 }), "GET /v1/automations/welcome/runs?status=failed&limit=3", undefined],
  ["templates.update alias", (mc) => mc.templates.update("t1", { alias: "hello", stream: "marketing", preheader: "" }), "PATCH /v1/templates/t1", { alias: "hello", stream: "marketing", preheader: "" }],
  ["templates.publish version", (mc) => mc.templates.publish("t1", { version: 2 }), "POST /v1/templates/t1/publish", { version: 2 }],
  ["templates.publish newest", (mc) => mc.templates.publish("t1"), "POST /v1/templates/t1/publish", {}],
  ["templates.preview unsaved", (mc) => mc.templates.preview("t1", { first_name: "Ana" }, { html: "<p>{{ first_name }}</p>", subject: "Hi" }), "POST /v1/templates/t1/preview", { variables: { first_name: "Ana" }, html: "<p>{{ first_name }}</p>", subject: "Hi" }],
  ["templates.versions", (mc) => mc.templates.versions("t1"), "GET /v1/templates/t1/versions", undefined],
  ["templates.version", (mc) => mc.templates.version("t1", 3), "GET /v1/templates/t1/versions/3", undefined],
  ["templates.restore", (mc) => mc.templates.restore("t1", 3), "POST /v1/templates/t1/versions/3/restore", {}],
  ["templates.discardDraft", (mc) => mc.templates.discardDraft("t1"), "DELETE /v1/templates/t1/draft", undefined],
  ["approvals.decide reason", (mc) => mc.approvals.decide("a1", "reject", "wrong list"), "POST /v1/approvals/a1/decide", { decision: "reject", reason: "wrong list" }],
  ["transports.create", (mc) => mc.transports.create({ kind: "smtp-relay", config: { host: "smtp.zoho.in", port: 465, username: "me@x.co", password: "pw", mailbox_sender: true } }), "POST /v1/transports", { kind: "smtp-relay", config: { host: "smtp.zoho.in", port: 465, username: "me@x.co", password: "pw", mailbox_sender: true } }],
  ["transports.test", (mc) => mc.transports.test("tr1"), "POST /v1/transports/tr1/test", {}],
  ["transports.remove", (mc) => mc.transports.remove("tr1"), "DELETE /v1/transports/tr1", undefined],
])("%s", async (_n, call, line, body) => {
  const { f, mc } = mk(() => json({ ok: true, data: {} }));
  const r = (await call(mc)) as { error: unknown };
  expect(r.error).toBeNull();
  const [url, init] = f.mock.calls[0];
  expect(`${init?.method} ${url}`).toBe(`${line.replace(" /", " http://api.test/")}`);
  expect(init?.body === undefined ? undefined : JSON.parse(init.body as string)).toEqual(body);
});

test("a broadcast dry run surfaces queued, skipped and schedule; pending_approval carries one approval_id", async () => {
  const dry = { queued: 1, skipped: [{ email: "bad", reason: "invalid_email", detail: null }], schedule: { daily_cap: null, transport_daily_cap: null, spacing_seconds: 0, first_at: "a", last_at: "b" } };
  const a = mk(() => json({ ok: true, request_id: "r", data: dry }));
  const r = await a.mc.broadcasts.create({ template_id: "t", from: "a@b.co", recipients: [{ email: "x@y.co" }, { email: "bad" }], dry_run: true });
  expect(r.data?.skipped?.[0].reason).toBe("invalid_email");
  expect(r.data?.schedule?.daily_cap).toBeNull();
  const b = mk(() => json({ ok: true, data: { id: "b1", status: "pending_approval", queued: 2, skipped: [], approval_id: "ap1" } }, 202));
  expect((await b.mc.broadcasts.create({ template_id: "t", from: "a@b.co", recipients: [{ email: "x@y.co" }] })).data?.approval_id).toBe("ap1");
});
