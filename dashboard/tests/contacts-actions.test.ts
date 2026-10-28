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

// ------------------------------------------------------------------ lists and list targets
import { addToList, deleteList, previewImportChunk, removeFromList, saveList } from "@/app/(app)/contacts/actions";

describe("saveList", () => {
  it("needs a name, without calling the API", async () => {
    expect((await saveList({}, form({ name: "  " }))).error?.field).toBe("name");
    expect(api).not.toHaveBeenCalled();
  });
  it("create POSTs the trimmed name, leaving a blank description out", async () => {
    api.mockResolvedValueOnce(ok({ id: "l1", name: "Acme customers" }));
    expect(await saveList({}, form({ name: " Acme customers ", description: " " }))).toEqual({ ok: "Created Acme customers", id: "l1" });
    expect(api).toHaveBeenCalledWith("POST", "/v1/lists", { name: "Acme customers", description: undefined });
  });
  it("edit PATCHes, sending a blank description so it clears", async () => {
    api.mockResolvedValueOnce(ok({ id: "l1" }));
    expect(await saveList({}, form({ id: "l1", name: "Renamed", description: "" }))).toEqual({ ok: "Saved Renamed", id: "l1" });
    expect(api).toHaveBeenCalledWith("PATCH", "/v1/lists/l1", { name: "Renamed", description: "" });
  });
  it("API errors come back as state so the dialog stays open", async () => {
    api.mockResolvedValueOnce(fail("conflict", "A list named Acme customers already exists", { field: "name" }));
    const r = await saveList({}, form({ name: "Acme customers" }));
    expect([r.error?.code, r.error?.field, r.ok]).toEqual(["conflict", "name", undefined]);
  });
});

describe("deleteList", () => {
  it("DELETEs and redirects to the Lists tab saying the contacts are untouched", async () => {
    api.mockResolvedValueOnce(ok({ deleted: true }));
    expect(await redirected(deleteList(form({ id: "l1", name: "Acme customers" })))).toBe("/contacts?tab=lists&ok=Deleted%20Acme%20customers%3B%20its%20contacts%20are%20untouched");
    expect(api).toHaveBeenCalledWith("DELETE", "/v1/lists/l1");
  });
  it("redirects back to the Lists tab with the API error", async () => {
    api.mockResolvedValueOnce(fail("not_found", "list not found", { hint: "gone?" }));
    expect(await redirected(deleteList(form({ id: "l1", name: "x" })))).toBe("/contacts?tab=lists&err=not_found%7Clist%20not%20found%7Cgone%3F");
  });
});

describe("addToList", () => {
  it("needs a contact, and a list", async () => {
    expect((await addToList({}, form({ list_id: "l1" }))).error?.message).toMatch(/at least one contact/);
    expect((await addToList({}, form({ id: "c1" }))).error?.field).toBe("list_id");
    expect(api).not.toHaveBeenCalled();
  });
  it("adds to an existing list and says which", async () => {
    api.mockResolvedValueOnce(ok({ added: 2 }));
    const r = await addToList({}, form({ id: ["c1", "c2"], list_id: "l1", list_label: "Acme customers" }));
    expect(api).toHaveBeenCalledWith("POST", "/v1/lists/l1/members", { contact_ids: ["c1", "c2"] });
    expect(r).toEqual({ ok: "Added 2 contacts to Acme customers", id: "l1" });
  });
  it("uses the singular for one contact", async () => {
    api.mockResolvedValueOnce(ok({ added: 1 }));
    expect((await addToList({}, form({ id: "c1", list_id: "l1" }))).ok).toBe("Added 1 contact");
  });
  it("creates the new list first, then adds into it (list_id=new or a bare new_name)", async () => {
    for (const pick of [{ list_id: "new" }, {}] as Record<string, string>[]) {
      api.mockReset();
      api.mockResolvedValueOnce(ok({ id: "l9" })).mockResolvedValueOnce(ok({ added: 1 }));
      const r = await addToList({}, form({ id: "c1", new_name: " VIPs ", ...pick }));
      expect(api.mock.calls.map((c) => [c[0], c[1]])).toEqual([["POST", "/v1/lists"], ["POST", "/v1/lists/l9/members"]]);
      expect(api).toHaveBeenNthCalledWith(1, "POST", "/v1/lists", { name: "VIPs" });
      expect(r).toEqual({ ok: "Added 1 contact to VIPs", id: "l9" });
    }
  });
  it("asks for a name when 'new list' is picked without one", async () => {
    expect((await addToList({}, form({ id: "c1", list_id: "new" }))).error?.field).toBe("new_name");
    expect(api).not.toHaveBeenCalled();
  });
  it("a 409 on the new list's name lands on the new_name field and adds nothing", async () => {
    api.mockResolvedValueOnce(fail("conflict", "A list named VIPs already exists", { field: "name", hint: "Pick another name." }));
    const r = await addToList({}, form({ id: "c1", new_name: "VIPs" }));
    expect([r.error?.code, r.error?.field, r.error?.hint]).toEqual(["conflict", "new_name", "Pick another name."]);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("leaves other error fields alone", async () => {
    api.mockResolvedValueOnce(fail("invalid_request", "name too long", { field: "description" }));
    expect((await addToList({}, form({ id: "c1", new_name: "x" }))).error?.field).toBe("description");
  });
  it("sends 1000 contacts per request and sums what was added", async () => {
    api.mockResolvedValueOnce(ok({ added: 1000 })).mockResolvedValueOnce(ok({ added: 1000 })).mockResolvedValueOnce(ok({ added: 5 }));
    const ids = Array.from({ length: 2001 }, (_, i) => `c${i}`);
    const r = await addToList({}, form({ id: ids, list_id: "l1" }));
    expect(api.mock.calls.map((c) => (c[2] as { contact_ids: string[] }).contact_ids.length)).toEqual([1000, 1000, 1]);
    expect(r.ok).toBe("Added 2005 contacts");
  });
  it("stops at the first failing chunk", async () => {
    api.mockResolvedValueOnce(ok({ added: 1000 })).mockResolvedValueOnce(fail("not_found", "list not found"));
    const r = await addToList({}, form({ id: Array.from({ length: 2500 }, (_, i) => `c${i}`), list_id: "l1" }));
    expect([r.error?.code, api.mock.calls.length]).toEqual(["not_found", 2]);
  });
});

describe("removeFromList", () => {
  it("POSTs to members/remove and says the list by name", async () => {
    api.mockResolvedValueOnce(ok({ removed: 2 }));
    const r = await removeFromList({}, form({ id: ["c1", "c2"], list_id: "l1", list_label: "Acme customers" }));
    expect(api).toHaveBeenCalledWith("POST", "/v1/lists/l1/members/remove", { contact_ids: ["c1", "c2"] });
    expect(r.ok).toBe("Removed 2 contacts from Acme customers");
  });
  it("falls back to 'the list', singular for one", async () => {
    api.mockResolvedValueOnce(ok({ removed: 1 }));
    expect((await removeFromList({}, form({ id: "c1", list_id: "l1" }))).ok).toBe("Removed 1 contact from the list");
  });
  it("chunks by 1000 and returns the API error", async () => {
    api.mockResolvedValueOnce(ok({ removed: 1000 })).mockResolvedValueOnce(fail("forbidden_scope", "needs manage"));
    const r = await removeFromList({}, form({ id: Array.from({ length: 1001 }, (_, i) => `c${i}`), list_id: "l1" }));
    expect([r.error?.code, api.mock.calls.map((c) => (c[2] as { contact_ids: string[] }).contact_ids.length)]).toEqual(["forbidden_scope", [1000, 1]]);
  });
});

describe("import into a list", () => {
  const rows = [{ email: "a@b.co" }];
  it("importContactsChunk sends list_id for an existing list", async () => {
    api.mockResolvedValueOnce(ok({ imported: 1, failed: [] }));
    await importContactsChunk(rows, { id: "l1" });
    expect(api).toHaveBeenCalledWith("POST", "/v1/contacts/import", { contacts: rows, list_id: "l1" });
  });
  it("importContactsChunk sends list_name for a new one", async () => {
    api.mockResolvedValueOnce(ok({ imported: 1, failed: [] }));
    await importContactsChunk(rows, { name: "Webinar leads" });
    expect(api).toHaveBeenCalledWith("POST", "/v1/contacts/import", { contacts: rows, list_name: "Webinar leads" });
  });
  it("an id wins over a name; no target (or null) sends neither", async () => {
    api.mockResolvedValue(ok({ imported: 1, failed: [] }));
    await importContactsChunk(rows, { id: "l1", name: "ignored" });
    await importContactsChunk(rows, null);
    await importContactsChunk(rows, {});
    expect(api.mock.calls.map((c) => c[2])).toEqual([{ contacts: rows, list_id: "l1" }, { contacts: rows }, { contacts: rows }]);
  });
  it("previewImportChunk is a dry run and returns the rows and the list that would be used", async () => {
    const list = { id: null, name: "Webinar leads", exists: false };
    api.mockResolvedValueOnce(ok({ rows: [{ index: 0, email: "a@b.co", action: "new" }], list }));
    expect(await previewImportChunk(rows, { name: "Webinar leads" })).toEqual({ rows: [{ index: 0, email: "a@b.co", action: "new" }], list });
    expect(api).toHaveBeenCalledWith("POST", "/v1/contacts/import", { contacts: rows, dry_run: true, list_name: "Webinar leads" });
  });
  it("previewImportChunk with an existing list sends list_id; with none, no list and an empty rows default", async () => {
    api.mockResolvedValueOnce(ok({ rows: [] }));
    expect(await previewImportChunk(rows, { id: "l1" })).toEqual({ rows: [], list: null });
    expect(api).toHaveBeenLastCalledWith("POST", "/v1/contacts/import", { contacts: rows, dry_run: true, list_id: "l1" });
    api.mockResolvedValueOnce(ok({ rows: [] }));
    await previewImportChunk(rows);
    expect(api).toHaveBeenLastCalledWith("POST", "/v1/contacts/import", { contacts: rows, dry_run: true });
  });
  it("previewImportChunk returns the API error so the dialog can stop", async () => {
    api.mockResolvedValueOnce(fail("invalid_request", "list_id and list_name are mutually exclusive"));
    expect(await previewImportChunk(rows, { id: "l1" })).toEqual({ rows: [], list: null, error: { code: "invalid_request", message: "list_id and list_name are mutually exclusive" } });
  });
  it("importContactsChunk returns the API error for an unknown list", async () => {
    api.mockResolvedValueOnce(fail("not_found", "list not found"));
    expect(await importContactsChunk(rows, { id: "gone" })).toEqual({ imported: 0, failed: [], error: { code: "not_found", message: "list not found" } });
  });
});
