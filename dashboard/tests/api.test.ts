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
