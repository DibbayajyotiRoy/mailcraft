import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
class Redirect extends Error { constructor(public to: string) { super(to); } }
vi.mock("@/lib/api", () => ({ api: (...a: unknown[]) => api(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirect(to); } }));

import { addSegmentMembers, deleteContact, importContactsChunk, previewSegment, saveContact, saveSegment, trackEvent, unsuppressContact } from "@/app/(app)/contacts/actions";

const form = (o: Record<string, string | string[]>) => {
  const d = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) d.append(k, x);
  return d;
};
const ok = (data: unknown) => ({ data, error: null });
const fail = (code: string, message: string, extra = {}) => ({ data: null, error: { code, message, ...extra } });
const redirected = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof Redirect) return e.to; throw e; } throw new Error("no redirect"); };

beforeEach(() => api.mockReset());

describe("saveContact", () => {
  it("create refuses to overwrite an existing contact", async () => {
    api.mockResolvedValueOnce(ok({ id: "c1", email: "ana@example.com" }));
    const r = await saveContact({}, form({ email: "ana@example.com" }));
    expect(r.error?.code).toBe("already_exists");
    expect([r.error?.field, r.id]).toEqual(["email", "c1"]);
    expect(api).toHaveBeenCalledTimes(1); // only the existence check, no PUT
  });
  it("create sends only filled fields and typed properties", async () => {
    api.mockResolvedValueOnce(fail("not_found", "contact not found")).mockResolvedValueOnce(ok({ id: "c9", email: "ana@example.com" }));
    const r = await saveContact({}, form({ email: " ana@example.com ", first_name: "Ana", last_name: "", timezone: "", attr_key: ["plan", "seats"], attr_type: ["text", "number"], attr_value: ["pro", "5"] }));
    expect(r).toEqual({ ok: "Added ana@example.com", id: "c9" });
    expect(api).toHaveBeenLastCalledWith("PUT", "/v1/contacts", { email: "ana@example.com", first_name: "Ana", last_name: undefined, timezone: undefined, properties: { plan: "pro", seats: 5 } });
  });
  it("create rejects a bad email and bad attributes without calling the API", async () => {
    expect((await saveContact({}, form({ email: "nope" }))).error?.field).toBe("email");
    const r = await saveContact({}, form({ email: "a@b.co", attr_key: ["n"], attr_type: ["number"], attr_value: ["x"] }));
    expect([r.error?.message, r.attrErrors]).toEqual(["Fix the attributes marked below.", { 0: "Enter a number." }]);
    expect(api).not.toHaveBeenCalled();
  });
  it("a lookup failure other than not_found is surfaced, not treated as free", async () => {
    api.mockResolvedValueOnce(fail("unreachable", "Cannot reach the API"));
    expect((await saveContact({}, form({ email: "a@b.co" }))).error?.code).toBe("unreachable");
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("edit PATCHes with blanks to clear and null for removed properties", async () => {
    api.mockResolvedValueOnce(ok({ id: "c1", email: "ana@example.com" }));
    const r = await saveContact({}, form({ id: "c1", first_name: "Ana", last_name: "", timezone: "", initial_keys: '["plan","old"]', attr_key: ["plan"], attr_type: ["text"], attr_value: ["pro"] }));
    expect(r.ok).toBe("Saved ana@example.com");
    expect(api).toHaveBeenCalledWith("PATCH", "/v1/contacts/c1", { first_name: "Ana", last_name: "", timezone: "", properties: { plan: "pro", old: null } });
  });
  it("API errors come back as state so the dialog stays open", async () => {
    api.mockResolvedValueOnce(fail("invalid_request", "`Mars/Base` is not an IANA timezone", { hint: "e.g. Europe/Berlin" }));
    const r = await saveContact({}, form({ id: "c1", timezone: "Mars/Base" }));
    expect(r.error?.message).toMatch(/IANA/);
  });
});

describe("one-click actions redirect with a flash or the API error", () => {
  it("delete", async () => {
    api.mockResolvedValueOnce(ok({ deleted: true }));
    expect(await redirected(deleteContact(form({ id: "c1", email: "a@b.co" })))).toBe("/contacts?ok=Deleted%20a%40b.co");
    api.mockResolvedValueOnce(fail("not_found", "contact not found", { hint: "gone?" }));
    expect(await redirected(deleteContact(form({ id: "c1", email: "a@b.co" })))).toBe("/contacts/c1?err=not_found%7Ccontact%20not%20found%7Cgone%3F");
  });
  it("unsuppress removes the suppression by URL-encoded address", async () => {
    api.mockResolvedValueOnce(ok({}));
    await redirected(unsuppressContact(form({ id: "c1", email: "a+b@c.co" })));
    expect(api).toHaveBeenCalledWith("DELETE", "/v1/suppressions/a%2Bb%40c.co");
  });
});

describe("trackEvent", () => {
  it("validates the name and properties locally", async () => {
    expect((await trackEvent({}, form({ email: "a@b.co", name: "" }))).error?.field).toBe("name");
    expect((await trackEvent({}, form({ email: "a@b.co", name: "x", properties: "[1]" }))).error?.field).toBe("properties");
    expect((await trackEvent({}, form({ email: "a@b.co", name: "x", properties: "{" }))).error?.message).toMatch(/not valid JSON/);
    expect(api).not.toHaveBeenCalled();
  });
  it("posts the event and reports triggered automations; dry run asks the API not to record", async () => {
    api.mockResolvedValueOnce(ok({ event_id: "e1", duplicate: false, triggered_automations: [{ id: "a1", run_id: "r1" }] }));
    const r = await trackEvent({}, form({ email: "a@b.co", name: "signed_up", properties: '{"plan":"pro"}' }));
    expect(api).toHaveBeenCalledWith("POST", "/v1/events", { name: "signed_up", contact: { email: "a@b.co" }, properties: { plan: "pro" }, dry_run: undefined });
    expect(r.result).toEqual({ dry: false, triggered: [{ id: "a1", run_id: "r1" }], inactive: [], duplicate: false });
    api.mockResolvedValueOnce(ok({ dry_run: true, triggered_automations: [], inactive_matches: [{ id: "a2", name: "n", status: "draft" }] }));
    const d = await trackEvent({}, form({ email: "a@b.co", name: "x", dry_run: "on" }));
    expect(api).toHaveBeenLastCalledWith("POST", "/v1/events", expect.objectContaining({ dry_run: true }));
    expect(d.result?.inactive).toHaveLength(1);
  });
});

describe("importContactsChunk", () => {
  it("maps API failures to index, email and message", async () => {
    api.mockResolvedValueOnce(ok({ imported: 1, failed: [{ index: 1, email: "x", error: { code: "invalid_request", message: "bad" } }] }));
    expect(await importContactsChunk([{ email: "a@b.co" }, { email: "x" }])).toEqual({ imported: 1, failed: [{ index: 1, email: "x", message: "bad" }] });
    expect(api).toHaveBeenCalledWith("POST", "/v1/contacts/import", { contacts: [{ email: "a@b.co" }, { email: "x" }] });
  });
  it("returns the API error so the dialog can stop", async () => {
    api.mockResolvedValueOnce(fail("forbidden_scope", "needs manage"));
    expect((await importContactsChunk([{ email: "a@b.co" }])).error?.code).toBe("forbidden_scope");
  });
});

describe("segments", () => {
  it("create checks the name first (POST would upsert), then sends the rules", async () => {
    api.mockResolvedValueOnce(ok([{ id: "s1", name: "Pros" }]));
    expect((await saveSegment({}, form({ name: "Pros", filter: "" }))).error?.field).toBe("name");
    expect(api).toHaveBeenCalledTimes(1);
    api.mockReset();
    api.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok({ id: "s2" }));
    const f = { field: "properties.plan", op: "eq", value: "pro" };
    expect(await saveSegment({}, form({ name: "New", filter: JSON.stringify(f) }))).toEqual({ ok: "Created New", id: "s2" });
    expect(api).toHaveBeenLastCalledWith("POST", "/v1/segments", { name: "New", filter: f });
  });
  it("edit PUTs the full definition; an empty filter makes it a manual list", async () => {
    api.mockResolvedValueOnce(ok({ id: "s1" }));
    expect((await saveSegment({}, form({ id: "s1", name: "VIPs", filter: "" }))).ok).toBe("Saved VIPs");
    expect(api).toHaveBeenCalledWith("PUT", "/v1/segments/s1", { name: "VIPs", filter: null });
  });
  it("preview returns the count or the API's message", async () => {
    api.mockResolvedValueOnce(ok({ count: 4, sample: [{ email: "a@b.co" }] }));
    expect(await previewSegment({ field: "email", op: "exists" })).toEqual({ count: 4, sample: [{ email: "a@b.co" }] });
    api.mockResolvedValueOnce(fail("invalid_request", "segment filter field `contact.plan` is not supported"));
    expect((await previewSegment({})).error?.message).toMatch(/not supported/);
  });
  it("add members sends 1000 per request", async () => {
    api.mockResolvedValue(ok({ added: 1000, already_members: 0 }));
    const emails = Array.from({ length: 2001 }, (_, i) => `u${i}@x.co`).join("\n");
    const r = await addSegmentMembers({}, form({ id: "s1", emails }));
    expect(api.mock.calls.map((c) => (c[2] as { emails: string[] }).emails.length)).toEqual([1000, 1000, 1]);
    expect(r.ok).toBe("Added 3000");
  });
});
