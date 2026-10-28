import { expect, test, vi } from "vitest";
import { Mailcraft } from "../src/index.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const mk = (data: unknown = {}) => {
  const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => json({ ok: true, request_id: "r", data }));
  return { f, mc: new Mailcraft("mc_test_k", { baseUrl: "http://api.test", fetch: f as unknown as typeof fetch }) };
};
const sent = (f: ReturnType<typeof mk>["f"]) => f.mock.calls.map((c) => [`${c[1]?.method} ${c[0]}`, c[1]?.body ? JSON.parse(c[1].body as string) : undefined]);

test("lists hit the right routes with the right bodies", async () => {
  const { f, mc } = mk();
  await mc.lists.create({ name: "Acme customers", description: "paying" });
  await mc.lists.list();
  await mc.lists.get("l/1");
  await mc.lists.update("l1", { description: "" });
  await mc.lists.remove("l1");
  await mc.lists.addMembers("l1", { emails: ["ana@example.com"] }, { idempotencyKey: "k1" });
  await mc.lists.removeMembers("l1", { contact_ids: ["c1"] });
  expect(sent(f)).toEqual([
    ["POST http://api.test/v1/lists", { name: "Acme customers", description: "paying" }],
    ["GET http://api.test/v1/lists", undefined],
    ["GET http://api.test/v1/lists/l%2F1", undefined],
    ["PATCH http://api.test/v1/lists/l1", { description: "" }],
    ["DELETE http://api.test/v1/lists/l1", undefined],
    ["POST http://api.test/v1/lists/l1/members", { emails: ["ana@example.com"] }],
    ["POST http://api.test/v1/lists/l1/members/remove", { contact_ids: ["c1"] }],
  ]);
  expect((f.mock.calls[5][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("k1");
});

test("contactSources hit the right routes with the right bodies", async () => {
  const { f, mc } = mk();
  await mc.contactSources.create({ name: "Acme app", url: "https://app.example.com/api/contacts", key: "sk_1", list_name: "Acme app users" });
  await mc.contactSources.list();
  await mc.contactSources.get("s1");
  await mc.contactSources.update("s1", { enabled: false, interval_minutes: 30 });
  await mc.contactSources.test({ id: "s1" });
  await mc.contactSources.sync("s1");
  await mc.contactSources.preview("s1");
  await mc.contactSources.remove("s1");
  await mc.contactSources.remove("s1", { deleteList: true });
  expect(sent(f)).toEqual([
    ["POST http://api.test/v1/contact-sources", { name: "Acme app", url: "https://app.example.com/api/contacts", key: "sk_1", list_name: "Acme app users" }],
    ["GET http://api.test/v1/contact-sources", undefined],
    ["GET http://api.test/v1/contact-sources/s1", undefined],
    ["PATCH http://api.test/v1/contact-sources/s1", { enabled: false, interval_minutes: 30 }],
    ["POST http://api.test/v1/contact-sources/test", { id: "s1" }],
    ["POST http://api.test/v1/contact-sources/s1/sync", undefined],
    ["POST http://api.test/v1/contact-sources/s1/sync?dry_run=true", undefined],
    ["DELETE http://api.test/v1/contact-sources/s1", undefined],
    ["DELETE http://api.test/v1/contact-sources/s1?delete_list=true", undefined],
  ]);
});

test("a failed sync is data (ok:false), a busy one is an error; neither throws", async () => {
  const a = mk({ id: "s1", ok: false, error: "source returned 500", counts: null, watermark: null, duration_ms: 12 });
  const r = await a.mc.contactSources.sync("s1");
  expect(r.error).toBeNull();
  expect(r.data?.ok === false && r.data.error).toBe("source returned 500");
  const f = vi.fn(async () => json({ ok: false, error: { code: "sync_in_progress", message: "busy", retryable: true } }, 409));
  const busy = new Mailcraft("k", { fetch: f as unknown as typeof fetch });
  expect((await busy.contactSources.sync("s1")).error?.code).toBe("sync_in_progress");
});
