import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const revalidatePath = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...a: unknown[]) => api(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

import { addRelay } from "@/app/(app)/settings/actions";
import { saveAddresses, setDefaultFrom } from "@/app/(app)/settings/senders-actions";
import { bindTransport } from "@/app/(app)/domains/sends-via-actions";

const form = (o: Record<string, string | string[]>) => {
  const d = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) d.append(k, x);
  return d;
};
const ok = (data: unknown = {}) => ({ data, error: null });
const fail = (code: string, message: string, hint?: string) => ({ data: null, error: { code, message, ...(hint ? { hint } : {}) } });
/** The JSON the API would actually receive (drops `undefined`, as fetch's JSON.stringify does). */
const wire = (call: number) => JSON.parse(JSON.stringify(api.mock.calls[call][2]));

beforeEach(() => { api.mockReset(); revalidatePath.mockReset(); });

describe("addRelay", () => {
  const mailbox = {
    preset: "custom", name: "", host: "smtp.example.com", port: "587", username: " Ana@Example.com ", password: "pw",
    mailbox_sender: "on", login_name: "Ana Lovelace",
    alias_address: ["Sales@Example.com", "  ", "help@example.com"], alias_name: ["Sales Team", "ignored", ""],
  };

  it("custom mailbox relay sends host/port/mailbox_sender, aliases and display names, and no preset", async () => {
    api.mockResolvedValueOnce(ok());
    const r = await addRelay({}, form(mailbox));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0].slice(0, 2)).toEqual(["POST", "/v1/transports"]);
    expect(wire(0)).toEqual({
      kind: "smtp-relay",
      name: "Ana@Example.com", // a mailbox is named by its (trimmed) login
      config: {
        password: "pw", username: "Ana@Example.com", host: "smtp.example.com", port: 587, mailbox_sender: true,
        aliases: ["sales@example.com", "help@example.com"],
        display_names: { "ana@example.com": "Ana Lovelace", "sales@example.com": "Sales Team" },
      },
    });
    expect(wire(0)).not.toHaveProperty("preset");
    expect(r).toEqual({ ok: "custom relay added. Run the test to confirm the credentials." });
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("an explicit name wins over the login", async () => {
    api.mockResolvedValueOnce(ok());
    await addRelay({}, form({ ...mailbox, name: "Support inbox" }));
    expect(wire(0).name).toBe("Support inbox");
  });

  it("a mailbox with no alias rows and no display name sends neither key", async () => {
    api.mockResolvedValueOnce(ok());
    await addRelay({}, form({ preset: "custom", host: "h.example.com", port: "465", username: "ana@example.com", password: "pw", mailbox_sender: "on" }));
    expect(wire(0).config).toEqual({ password: "pw", username: "ana@example.com", host: "h.example.com", port: 465, mailbox_sender: true });
  });

  it("custom without the mailbox switch sends mailbox_sender:false and ignores alias fields", async () => {
    api.mockResolvedValueOnce(ok());
    await addRelay({}, form({ ...mailbox, mailbox_sender: "" , name: "" }));
    const body = wire(0);
    expect(body).not.toHaveProperty("preset");
    expect(body.name).toBe("custom"); // not a mailbox: falls back to the preset word
    expect(body.config).toEqual({ password: "pw", username: "Ana@Example.com", host: "smtp.example.com", port: 587, mailbox_sender: false });
  });

  it("a real preset sends the preset and only credentials/region, never host, port or aliases", async () => {
    api.mockResolvedValueOnce(ok());
    const r = await addRelay({}, form({ ...mailbox, preset: "ses", region: "eu-west-1", name: "" }));
    expect(wire(0)).toEqual({ kind: "smtp-relay", preset: "ses", name: "ses", config: { password: "pw", username: "Ana@Example.com", region: "eu-west-1" } });
    expect(r.ok).toBe("ses relay added. Run the test to confirm the credentials.");
  });

  it("API errors come back as state with the hint, and nothing is revalidated", async () => {
    api.mockResolvedValueOnce(fail("invalid_request", "host is required", "Set the SMTP host"));
    const r = await addRelay({}, form(mailbox));
    expect(r).toEqual({ error: "host is required (Set the SMTP host)" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an error without a hint has no parentheses", async () => {
    api.mockResolvedValueOnce(fail("unreachable", "Cannot reach the API"));
    expect(await addRelay({}, form(mailbox))).toEqual({ error: "Cannot reach the API" });
  });
});

describe("saveAddresses", () => {
  it("PATCHes the transport with aliases and display names, keyed by the lower-cased login", async () => {
    api.mockResolvedValueOnce(ok());
    const r = await saveAddresses({}, form({
      id: "tr_1", login: " Ana@Example.com ", login_name: "Ana",
      alias_address: ["Sales@Example.com", ""], alias_name: ["Sales", "x"],
    }));
    expect(api).toHaveBeenCalledWith("PATCH", "/v1/transports/tr_1", {
      aliases: ["sales@example.com"],
      display_names: { "ana@example.com": "Ana", "sales@example.com": "Sales" },
    });
    expect(r).toEqual({ ok: "Addresses saved." });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("clearing every row sends empty aliases and display_names (so the API clears them)", async () => {
    api.mockResolvedValueOnce(ok());
    await saveAddresses({}, form({ id: "tr_1", login: "ana@example.com", login_name: "" }));
    expect(api).toHaveBeenCalledWith("PATCH", "/v1/transports/tr_1", { aliases: [], display_names: {} });
  });

  it("the transport id is URL-encoded in the path", async () => {
    api.mockResolvedValueOnce(ok());
    await saveAddresses({}, form({ id: "a/b c", login: "ana@example.com" }));
    expect(api.mock.calls[0][1]).toBe("/v1/transports/a%2Fb%20c");
  });

  it("API errors pass through with the hint and skip revalidation", async () => {
    api.mockResolvedValueOnce(fail("invalid_request", "alias domain is not verified", "Verify example.com first"));
    const r = await saveAddresses({}, form({ id: "tr_1", login: "ana@example.com", alias_address: "x@other.test" }));
    expect(r).toEqual({ error: "alias domain is not verified (Verify example.com first)" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setDefaultFrom", () => {
  it("PUTs the trimmed default_from to the settings", async () => {
    api.mockResolvedValueOnce(ok());
    const r = await setDefaultFrom({}, form({ default_from: "  Ana <ana@example.com> " }));
    expect(api).toHaveBeenCalledWith("PUT", "/v1/settings", { default_from: "Ana <ana@example.com>" });
    expect(r).toEqual({ ok: "Default From saved." });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("an empty value clears the default (PUT with an empty string)", async () => {
    api.mockResolvedValueOnce(ok());
    const r = await setDefaultFrom({}, form({ default_from: "   " }));
    expect(api).toHaveBeenCalledWith("PUT", "/v1/settings", { default_from: "" });
    expect(r).toEqual({ ok: "Default From cleared." });
  });

  it("a missing field is treated as cleared", async () => {
    api.mockResolvedValueOnce(ok());
    await setDefaultFrom({}, form({}));
    expect(api).toHaveBeenCalledWith("PUT", "/v1/settings", { default_from: "" });
  });

  it("API errors pass through with the hint and skip revalidation", async () => {
    api.mockResolvedValueOnce(fail("invalid_request", "default_from domain is not verified", "Add the domain first"));
    const r = await setDefaultFrom({}, form({ default_from: "ana@nope.test" }));
    expect(r).toEqual({ error: "default_from domain is not verified (Add the domain first)" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("bindTransport", () => {
  it("PATCHes the domain with the chosen transport_id", async () => {
    api.mockResolvedValueOnce(ok());
    const r = await bindTransport({}, form({ id: "dom_1", transport_id: "tr_9" }));
    expect(api).toHaveBeenCalledWith("PATCH", "/v1/domains/dom_1", { transport_id: "tr_9" });
    expect(r).toEqual({ ok: "Saved. Sends from this domain use that transport." });
    expect(revalidatePath).toHaveBeenCalledWith("/domains");
  });

  it("an empty transport unbinds with null (the workspace default)", async () => {
    api.mockResolvedValueOnce(ok());
    const r = await bindTransport({}, form({ id: "dom_1", transport_id: "" }));
    expect(api).toHaveBeenCalledWith("PATCH", "/v1/domains/dom_1", { transport_id: null });
    expect(r).toEqual({ ok: "Saved. This domain uses the workspace default." });
    expect(revalidatePath).toHaveBeenCalledWith("/domains");
  });

  it("a missing transport_id also unbinds, and the domain id is URL-encoded", async () => {
    api.mockResolvedValueOnce(ok());
    await bindTransport({}, form({ id: "a/b" }));
    expect(api).toHaveBeenCalledWith("PATCH", "/v1/domains/a%2Fb", { transport_id: null });
  });

  it("API errors pass through with the hint and skip revalidation", async () => {
    api.mockResolvedValueOnce(fail("not_found", "transport not found", "Pick one from the list"));
    const r = await bindTransport({}, form({ id: "dom_1", transport_id: "tr_gone" }));
    expect(r).toEqual({ error: "transport not found (Pick one from the list)" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
