import { beforeEach, describe, expect, it } from "vitest";
import { invalidateReads } from "@/lib/assistant/core";
import { estTokens } from "@/lib/assistant/prompt";
import { mentionedSend, packSendContext, sendContext } from "@/lib/assistant/prefetch";
import { apiFail, ctx, fakeWorld } from "./assistant-kit";

const SENDERS = [
  { address: "hello@example.com", display_name: "Acme", is_default: true, status: "ready" },
  { address: "news@example.com", display_name: "Acme News", is_default: false, status: "ready" },
];
const TEMPLATE = { id: "t1", alias: "welcome", subject: "Welcome {{ first_name }}", variables: ["first_name"], source: "<style>p{color:red}</style><p>Hi {{ first_name }}</p>" };

beforeEach(() => invalidateReads("sid-1"));

describe("sendContext", () => {
  it("reads the template, the recipient, the senders and the workspace with exactly four GETs", async () => {
    const w = fakeWorld([], {
      "GET /v1/templates/welcome": () => TEMPLATE,
      "GET /v1/contacts/bipul%40example.com": () => ({ email: "bipul@example.com", first_name: "Bipul", timezone: "Asia/Kolkata", properties: { plan: "pro" } }),
      "GET /v1/senders": () => SENDERS,
      "GET /v1/account/status": () => ({ name: "Acme Inc", env: "test" }),
    });
    const r: any = await sendContext({ template: "welcome", to: ["bipul@example.com"], from: "News <news@example.com>" }, ctx());
    expect(w.rec.map((x) => `${x.method} ${x.url}`).sort()).toEqual(["GET /v1/account/status", "GET /v1/contacts/bipul%40example.com", "GET /v1/senders?limit=100", "GET /v1/templates/welcome"]);
    expect(r.done).toBe("Read the send context");
    expect(r.ok).toEqual({
      template: { id: "t1", alias: "welcome", subject: "Welcome {{ first_name }}", variables: ["first_name"], excerpt: "Hi {{ first_name }}" },
      contacts: [{ email: "bipul@example.com", known: true, first_name: "Bipul", timezone: "Asia/Kolkata", props: { plan: "pro" } }],
      sender: { address: "news@example.com", name: "Acme News" },
      workspace: "Acme Inc",
    });
  });

  it("a recipient the API does not know is known:false, not a failure", async () => {
    fakeWorld([], { "GET /v1/templates/welcome": () => TEMPLATE, "GET /v1/senders": () => SENDERS, "GET /v1/account/status": () => ({ name: "Acme Inc" }) });
    const r: any = await sendContext({ template: "welcome", to: "ana@example.com, ana@example.com" }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.ok.contacts).toEqual([{ email: "ana@example.com", known: false }]);
  });

  it("looks up at most three recipients", async () => {
    const w = fakeWorld([], { "GET /v1/templates/welcome": () => TEMPLATE });
    await sendContext({ template: "welcome", to: ["a@example.com", "b@example.com", "c@example.com", "d@example.com"] }, ctx());
    expect(w.rec.filter((x) => x.url.startsWith("/v1/contacts/"))).toHaveLength(3);
  });

  it("a missing template is the one hard failure", async () => {
    fakeWorld([], { "GET /v1/templates/nope": () => apiFail(404, "not_found", "no such template"), "GET /v1/senders": () => SENDERS });
    const r: any = await sendContext({ template: "nope", to: ["a@example.com"] }, ctx());
    expect(r.error.code).toBe("not_found");
    expect(r.ok).toBeUndefined();
  });

  it("falls back to the default sender when From is absent or unknown; failed sender and account reads are tolerated", async () => {
    fakeWorld([], { "GET /v1/templates/welcome": () => TEMPLATE, "GET /v1/senders": () => SENDERS });
    const r: any = await sendContext({ template: "welcome", to: ["a@example.com"], from: "ghost@example.com" }, ctx());
    expect(r.ok.sender).toEqual({ address: "hello@example.com", name: "Acme" });
    expect(r.ok.workspace).toBeUndefined();
    invalidateReads("sid-1");
    fakeWorld([], { "GET /v1/templates/welcome": () => TEMPLATE, "GET /v1/senders": () => apiFail(500, "internal", "boom") });
    const r2: any = await sendContext({ template: "welcome" }, ctx());
    expect(r2.ok.sender).toBeUndefined();
    expect(r2.ok.template.alias).toBe("welcome");
  });
});

describe("packSendContext budget", () => {
  it("12 variables + 6 KB source + a 20-property contact stays under 400 est. tokens with no tags in the excerpt", () => {
    const html = "<html><head><style>.a{color:red}</style></head><body>" + "<table><tr><td class=\"x\">Hello {{ first_name }}, thanks for joining us today.</td></tr></table>".repeat(80) + "</body></html>";
    expect(html.length).toBeGreaterThan(6000);
    const t = { id: "t1", alias: "welcome", subject: "Welcome {{ first_name }}", variables: Array.from({ length: 12 }, (_, i) => `variable_name_${i}`), source: html };
    const props = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`property_${i}`, `value number ${i} `.repeat(8)]));
    const p = packSendContext(t, [{ email: "bipul@example.com", contact: { first_name: "Bipul", last_name: "Das", timezone: "Asia/Kolkata", properties: props } }], { address: "hello@example.com", name: "Acme" }, "Acme Inc");
    expect(estTokens(p)).toBeLessThan(400);
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(1200);
    const ex = (p as any).template.excerpt as string;
    expect(ex).toContain("Hello {{ first_name }}");
    expect(ex).not.toContain("<");
    expect(ex).not.toContain("color:red");
    expect(Object.keys((p as any).contacts[0].props).length).toBeLessThanOrEqual(8);
    expect(Math.max(...Object.values((p as any).contacts[0].props).map((v) => String(v).length))).toBeLessThanOrEqual(60);
  });

  it("three contacts with eight properties each still fit: properties are dropped after the excerpt", () => {
    const props = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`property_${i}`, "v".repeat(60)]));
    const cs = ["a", "b", "c"].map((n) => ({ email: `${n}@example.com`, contact: { first_name: n, properties: props } }));
    const p: any = packSendContext({ id: "t1", alias: "w", source: "x".repeat(900) }, cs, undefined);
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(1200);
    expect(p.template.excerpt).toBeUndefined();
    expect(p.contacts.every((c: any) => c.known && c.props)).toBe(true);
  });
});

describe("mentionedSend", () => {
  it("parses a template mention with the addresses in the same text", () => {
    expect(mentionedSend("Send @template:welcome to bipul@example.com and ana@example.com")).toEqual({ template: "welcome", to: ["bipul@example.com", "ana@example.com"] });
    expect(mentionedSend("Use @template:draft-only. Send it to Ana <ana@example.com>, thanks")).toEqual({ template: "draft-only", to: ["ana@example.com"] });
  });
  it("is null unless both a template and an address are present", () => {
    expect(mentionedSend("Send @template:welcome to everyone")).toBeNull();
    expect(mentionedSend("Send a welcome to bipul@example.com")).toBeNull();
  });
});
