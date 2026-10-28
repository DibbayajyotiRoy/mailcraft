import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const revalidatePath = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...a: unknown[]) => api(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

import { createContact, findContact, searchContacts } from "@/app/(app)/emails/actions";

const ok = (data: unknown) => ({ data, error: null });
const fail = (code: string, message: string) => ({ data: null, error: { code, message } });
/** The JSON the API would actually receive (drops `undefined`, as fetch's JSON.stringify does). */
const wire = (call: number) => JSON.parse(JSON.stringify(api.mock.calls[call][2]));

beforeEach(() => { api.mockReset(); revalidatePath.mockReset(); });

describe("searchContacts", () => {
  it("asks for 8 matches and keeps only what the dialog needs", async () => {
    api.mockResolvedValueOnce(ok([{ id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva", properties: { plan: "pro" }, suppressed: false }, { id: "c3", email: "bounce@example.com", suppressed: true, suppression_reason: "hard_bounce" }]));
    const hits = await searchContacts("  an a ");
    expect(api).toHaveBeenCalledWith("GET", "/v1/contacts?q=an+a&limit=8");
    expect(hits).toEqual([
      { id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva", suppressed: false, suppression_reason: null },
      { id: "c3", email: "bounce@example.com", first_name: null, last_name: null, suppressed: true, suppression_reason: "hard_bounce" },
    ]);
  });
  it("blank text makes no call, and an API failure is just no suggestions", async () => {
    expect(await searchContacts("   ")).toEqual([]);
    expect(api).not.toHaveBeenCalled();
    api.mockResolvedValueOnce(fail("unreachable", "down"));
    expect(await searchContacts("ana")).toEqual([]);
  });
});

describe("findContact", () => {
  it("is an exact lookup by email", async () => {
    api.mockResolvedValueOnce(ok({ id: "c1", email: "ana@example.com", first_name: "Ana" }));
    expect((await findContact(" ana@example.com ")).contact).toMatchObject({ id: "c1", first_name: "Ana", suppressed: false });
    expect(api).toHaveBeenCalledWith("GET", "/v1/contacts/ana%40example.com");
  });
  it("not_found means a new address; any other failure is reported", async () => {
    api.mockResolvedValueOnce(fail("not_found", "contact not found"));
    expect(await findContact("new@example.com")).toEqual({ contact: null });
    api.mockResolvedValueOnce(fail("unreachable", "down"));
    expect(await findContact("new@example.com")).toEqual({ contact: null, error: { code: "unreachable", message: "down" } });
  });
});

describe("createContact", () => {
  it("PUTs only the filled fields", async () => {
    api.mockResolvedValueOnce(ok({ id: "c9" }));
    expect(await createContact({ email: " new@example.com ", first_name: "Nia", last_name: "", timezone: "Europe/Berlin" })).toEqual({});
    expect(api.mock.calls[0].slice(0, 2)).toEqual(["PUT", "/v1/contacts"]);
    expect(wire(0)).toEqual({ email: "new@example.com", first_name: "Nia", timezone: "Europe/Berlin" });
    expect(revalidatePath).toHaveBeenCalledWith("/contacts");
  });
  it("returns the API error as is", async () => {
    api.mockResolvedValueOnce(fail("invalid_request", "timezone is not an IANA name"));
    expect((await createContact({ email: "new@example.com", timezone: "Mars/Base" })).error?.message).toContain("IANA");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
