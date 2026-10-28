import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
class Redirect extends Error { constructor(public to: string) { super(to); } }
vi.mock("@/lib/api", () => ({ api: (...a: unknown[]) => api(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirect(to); } }));

import { deleteSource, previewSource, saveSource, syncSource, testSource, toggleSource } from "@/app/(app)/settings/actions";

const form = (o: Record<string, string>) => {
  const d = new FormData();
  for (const [k, v] of Object.entries(o)) d.append(k, v);
  return d;
};
const ok = (data: unknown) => ({ data, error: null });
const fail = (code: string, message: string, extra = {}) => ({ data: null, error: { code, message, ...extra } });
const redirected = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof Redirect) return e.to; throw e; } throw new Error("no redirect"); };

beforeEach(() => api.mockReset());

describe("saveSource", () => {
  const typed = { name: " Acme app ", url: " https://app.example.com/api/contacts ", key: " sk_live_1 ", interval_minutes: "15", full_sync_hours: "24", list_name: " Acme app users " };
  it("create POSTs the typed values, with the key and the list name", async () => {
    api.mockResolvedValueOnce(ok({ id: "s1" }));
    const r = await saveSource({}, form(typed));
    expect(api).toHaveBeenCalledWith("POST", "/v1/contact-sources", { name: "Acme app", url: "https://app.example.com/api/contacts", interval_minutes: 15, full_sync_hours: 24, key: "sk_live_1", list_name: "Acme app users" });
    expect(r.ok).toMatch(/^Added Acme app\./);
  });
  it("create leaves out a blank list name and blank numbers", async () => {
    api.mockResolvedValueOnce(ok({ id: "s1" }));
    await saveSource({}, form({ ...typed, list_name: "", interval_minutes: "", full_sync_hours: " " }));
    const body = api.mock.calls[0][2] as Record<string, unknown>;
    expect(body.interval_minutes).toBeUndefined();
    expect(body.full_sync_hours).toBeUndefined();
    expect("list_name" in body).toBe(false);
  });
  it("edit PATCHes by id and never sends list_name (the list is chosen at creation)", async () => {
    api.mockResolvedValueOnce(ok({ id: "s1" }));
    const r = await saveSource({}, form({ ...typed, id: "s/1" }));
    expect(api).toHaveBeenCalledWith("PATCH", "/v1/contact-sources/s%2F1", { name: "Acme app", url: "https://app.example.com/api/contacts", interval_minutes: 15, full_sync_hours: 24, key: "sk_live_1" });
    expect(r).toEqual({ ok: "Saved Acme app." });
  });
  it("a blank key is omitted so the stored one stays; a typed key rotates it", async () => {
    api.mockResolvedValue(ok({ id: "s1" }));
    await saveSource({}, form({ ...typed, id: "s1", key: "   " }));
    expect("key" in (api.mock.calls[0][2] as object)).toBe(false);
    await saveSource({}, form({ ...typed, id: "s1", key: "sk_live_2" }));
    expect((api.mock.calls[1][2] as { key: string }).key).toBe("sk_live_2");
  });
  it("an API error comes back as text with its hint", async () => {
    api.mockResolvedValueOnce(fail("invalid_request", "url must be https", { hint: "Use https://" }));
    expect(await saveSource({}, form(typed))).toEqual({ error: "url must be https (Use https://)" });
  });
});

describe("toggleSource", () => {
  it("PATCHes enabled=true / false from the form value", async () => {
    api.mockResolvedValue(ok({}));
    expect((await toggleSource({}, form({ id: "s1", enabled: "true" }))).ok).toBe("Syncing is on.");
    expect(api).toHaveBeenLastCalledWith("PATCH", "/v1/contact-sources/s1", { enabled: true });
    expect((await toggleSource({}, form({ id: "s1", enabled: "false" }))).ok).toBe("Syncing is paused.");
    expect(api).toHaveBeenLastCalledWith("PATCH", "/v1/contact-sources/s1", { enabled: false });
  });
  it("returns the API error", async () => {
    api.mockResolvedValueOnce(fail("not_found", "source not found"));
    expect(await toggleSource({}, form({ id: "s1", enabled: "true" }))).toEqual({ error: "source not found" });
  });
});

describe("testSource", () => {
  it("sends typed values, and the saved id for what is blank", async () => {
    api.mockResolvedValueOnce(ok({ ok: true, sample_count: 1, fields: ["email", "first_name"], property_keys: ["plan"] }));
    const r = await testSource({}, form({ id: "s1", url: "https://app.example.com/c", key: "" }));
    expect(api).toHaveBeenCalledWith("POST", "/v1/contact-sources/test", { id: "s1", url: "https://app.example.com/c", key: undefined });
    expect(r.ok).toBe("Connected. Fields: email, first_name; attributes: plan.");
  });
  it("omits the attributes part when the source has none", async () => {
    api.mockResolvedValueOnce(ok({ ok: true, sample_count: 1, fields: ["email"], property_keys: [] }));
    expect((await testSource({}, form({ url: "https://app.example.com/c", key: "k" }))).ok).toBe("Connected. Fields: email.");
    expect(api).toHaveBeenCalledWith("POST", "/v1/contact-sources/test", { id: undefined, url: "https://app.example.com/c", key: "k" });
  });
  it("connected but empty is still a success", async () => {
    api.mockResolvedValueOnce(ok({ ok: true, sample_count: 0 }));
    expect((await testSource({}, form({ id: "s1" }))).ok).toBe("Connected, but the source returned no contacts yet.");
  });
  it("a failed test shows the source's own error, or a default", async () => {
    api.mockResolvedValueOnce(ok({ ok: false, error: "401 from the source: bad key" }));
    expect(await testSource({}, form({ id: "s1" }))).toEqual({ error: "401 from the source: bad key" });
    api.mockResolvedValueOnce(ok({ ok: false }));
    expect(await testSource({}, form({ id: "s1" }))).toEqual({ error: "The test failed." });
  });
  it("an API error is returned as text", async () => {
    api.mockResolvedValueOnce(fail("forbidden_scope", "needs manage", { hint: "Use a manage key." }));
    expect(await testSource({}, form({ id: "s1" }))).toEqual({ error: "needs manage (Use a manage key.)" });
  });
});

describe("syncSource", () => {
  it("POSTs with no body and waits up to 120 seconds", async () => {
    api.mockResolvedValueOnce(ok({ ok: true, counts: { created: 3, updated: 2, skipped: 1, deleted: 0 } }));
    const r = await syncSource({}, form({ id: "s1" }));
    expect(api).toHaveBeenCalledWith("POST", "/v1/contact-sources/s1/sync", undefined, 120_000);
    expect(r).toEqual({ ok: "Synced: 3 new, 2 updated, 1 skipped, 0 deleted." });
  });
  it("counts missing from the response read as zero", async () => {
    api.mockResolvedValueOnce(ok({ ok: true, counts: { created: 4 } }));
    expect((await syncSource({}, form({ id: "s1" }))).ok).toBe("Synced: 4 new, 0 updated, 0 skipped, 0 deleted.");
  });
  it("a sync that ran and failed shows its error, or a default", async () => {
    api.mockResolvedValueOnce(ok({ ok: false, error: "source returned 500" }));
    expect(await syncSource({}, form({ id: "s1" }))).toEqual({ error: "source returned 500" });
    api.mockResolvedValueOnce(ok({ ok: false }));
    expect(await syncSource({}, form({ id: "s1" }))).toEqual({ error: "The sync failed." });
  });
  it("an API error (a sync already running, say) is returned as text", async () => {
    api.mockResolvedValueOnce(fail("conflict", "a sync is already running", { hint: "Try again shortly." }));
    expect(await syncSource({}, form({ id: "s1" }))).toEqual({ error: "a sync is already running (Try again shortly.)" });
  });
});

describe("previewSource", () => {
  it("is a dry run with a 60 second budget and returns the first page's diff", async () => {
    const rows = [{ email: "a@b.co", action: "new" }];
    api.mockResolvedValueOnce(ok({ ok: true, rows, summary: { new: 1 }, list: { name: "Acme app users" }, has_more: true }));
    expect(await previewSource("s/1")).toEqual({ rows, summary: { new: 1 }, list: { name: "Acme app users" }, hasMore: true });
    expect(api).toHaveBeenCalledWith("POST", "/v1/contact-sources/s%2F1/sync?dry_run=true", undefined, 60_000);
  });
  it("an API error or a failed preview comes back as error text", async () => {
    api.mockResolvedValueOnce(fail("not_found", "source not found", { hint: "Deleted?" }));
    expect(await previewSource("s1")).toEqual({ error: "source not found (Deleted?)" });
    api.mockResolvedValueOnce(ok({ ok: false, error: "source returned 401" }));
    expect(await previewSource("s1")).toEqual({ error: "source returned 401" });
    api.mockResolvedValueOnce(ok({ ok: false }));
    expect(await previewSource("s1")).toEqual({ error: "The preview failed." });
  });
});

describe("deleteSource", () => {
  it("keeps the list by default", async () => {
    api.mockResolvedValueOnce(ok({ deleted: true }));
    const to = await redirected(deleteSource(form({ id: "s1", name: "Acme app" })));
    expect(api).toHaveBeenCalledWith("DELETE", "/v1/contact-sources/s1");
    expect(to).toMatch(/^\/settings.*Deleted%20Acme%20app/);
  });
  it("the flash is in the query, before the #sources fragment", async () => {
    api.mockResolvedValueOnce(ok({ deleted: true }));
    expect(await redirected(deleteSource(form({ id: "s1", name: "Acme app" })))).toBe("/settings?ok=Deleted%20Acme%20app.%20Its%20contacts%20are%20kept.#sources");
  });
  it("delete_list=on adds ?delete_list=true", async () => {
    api.mockResolvedValueOnce(ok({ deleted: true }));
    await redirected(deleteSource(form({ id: "s1", name: "Acme app", delete_list: "on" })));
    expect(api).toHaveBeenCalledWith("DELETE", "/v1/contact-sources/s1?delete_list=true");
  });
  it("redirects back to the Sources card with the API error", async () => {
    api.mockResolvedValueOnce(fail("not_found", "source not found", { hint: "gone?" }));
    expect(await redirected(deleteSource(form({ id: "s1", name: "x" })))).toBe("/settings?err=not_found%7Csource%20not%20found%7Cgone%3F#sources");
  });
});
