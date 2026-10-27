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
