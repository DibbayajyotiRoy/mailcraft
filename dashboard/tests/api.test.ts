import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "@/lib/api";

const reply = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("unwraps data and next_cursor, sends bearer", async () => {
    const f = reply({ ok: true, data: [1], next_cursor: "c2" });
    vi.stubGlobal("fetch", f);
    const r = await request("http://x/", "mc_k", "GET", "/v1/emails");
    expect(r).toEqual({ data: [1], error: null, next_cursor: "c2" });
    expect(f.mock.calls[0][0]).toBe("http://x/v1/emails");
    expect(f.mock.calls[0][1].headers.Authorization).toBe("Bearer mc_k");
  });
  it("adds an Idempotency-Key to mutations only", async () => {
    const f = reply({ ok: true, data: {} });
    vi.stubGlobal("fetch", f);
    await request("http://x", "k", "POST", "/v1/kill-switch", { on: true });
    expect(f.mock.calls[0][1].headers["Idempotency-Key"]).toBeTruthy();
  });
  it("returns the error envelope", async () => {
    vi.stubGlobal("fetch", reply({ ok: false, error: { code: "forbidden", message: "no", hint: "h" } }, 403));
    const r = await request("http://x", "k", "GET", "/v1/keys");
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe("forbidden");
  });
  it("turns network failure into an unreachable error, not a throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const r = await request("http://x", "k", "GET", "/v1/keys");
    expect(r.error?.code).toBe("unreachable");
  });
  it("handles non-JSON bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 502 })));
    expect((await request("http://x", "k", "GET", "/v1/keys")).error?.code).toBe("bad_response");
  });
});

// ---- contract: real envelope shapes (docs/contract/fixtures.json) ----
import { readFileSync } from "node:fs";
import { keyBody } from "@/lib/api";
const fx = JSON.parse(readFileSync("../docs/contract/fixtures.json", "utf8"));

describe("contract", () => {
  it.each(["GET /v1/emails", "GET /v1/approvals", "GET /v1/keys", "GET /v1/kill-switch", "GET /v1/account/status", "GET /v1/emails/{id}/events"])("unwraps %s", async (k) => {
    vi.stubGlobal("fetch", reply(fx[k].body, fx[k].status));
    const r = await request("http://x", "mc_test_k", "GET", "/v1/anything");
    expect(r.error).toBeNull();
    expect(r.data).toEqual(fx[k].body.data);
  });
  it("pages carry next_cursor", async () => {
    vi.stubGlobal("fetch", reply(fx["GET /v1/emails"].body));
    expect((await request("http://x", "k", "GET", "/v1/emails")).next_cursor).toBe(fx["GET /v1/emails"].body.next_cursor);
  });
  it("pages read the fields the API really sends", () => {
    const e = fx["GET /v1/emails"].body.data[0];
    expect(e.to_addr).toBeTypeOf("string");
    expect(fx["GET /v1/approvals"].body.data[0].payload.preview.subject).toBeTypeOf("string");
    expect(fx["POST /v1/keys"].body.data.token).toMatch(/^mc_test_/);
    expect(fx["GET /v1/kill-switch"].body.data.on).toBe(false);
  });
  it("structured error is passed through", async () => {
    vi.stubGlobal("fetch", reply(fx["ERROR forbidden_scope"].body, 403));
    expect((await request("http://x", "k", "POST", "/v1/approvals/x/decide", { decision: "approve" })).error?.code).toBe("forbidden_scope");
  });
  it("key create body always has env and scopes", () => {
    expect(keyBody("a", "", "")).toEqual({ name: "a", env: "test", scopes: ["read", "send"] });
    expect(keyBody("a", "read,manage", "live")).toEqual({ name: "a", env: "live", scopes: ["read", "manage"] });
  });
});
