import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn(), refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
const A = vi.hoisted(() => ({
  saveContact: vi.fn(), saveSegment: vi.fn(), previewSegment: vi.fn(), addSegmentMembers: vi.fn(), deleteSegment: vi.fn(),
  deleteContact: vi.fn(), suppressContact: vi.fn(), unsuppressContact: vi.fn(), trackEvent: vi.fn(), importContactsChunk: vi.fn(),
}));
vi.mock("@/app/(app)/contacts/actions", () => A);
vi.mock("@/lib/actions", () => ({ createKey: vi.fn() }));

import { ContactDialog } from "@/app/(app)/contacts/ContactForm";
import { DangerZone } from "@/app/(app)/contacts/DangerZone";
import { ImportContacts } from "@/app/(app)/contacts/ImportContacts";
import { AddMembers, SegmentDialog } from "@/app/(app)/contacts/SegmentForm";
import { TrackEvent } from "@/app/(app)/contacts/TrackEvent";
import { Button } from "@/components/ui/button";

const fd = (fn: { mock: { calls: unknown[][] } }, call = 0, arg = 1) => fn.mock.calls[call][arg] as FormData;
const open = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => { vi.clearAllMocks(); A.saveContact.mockResolvedValue({}); A.saveSegment.mockResolvedValue({}); A.trackEvent.mockResolvedValue({}); });

describe("contact form", () => {
  it("validates email, time zone and attributes before calling the server", async () => {
    render(<ContactDialog><Button>Add contact</Button></ContactDialog>);
    open("Add contact");
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Mars/Base" } });
    open("Add attribute");
    fireEvent.change(screen.getByLabelText("Attribute 1 name"), { target: { value: "seats" } });
    fireEvent.change(screen.getByLabelText("Attribute 1 type"), { target: { value: "number" } });
    fireEvent.change(screen.getByLabelText("Attribute 1 value"), { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Add contact", description: "" }) ?? screen.getAllByRole("button", { name: "Add contact" })[1]);
    expect(await screen.findByText("Enter an email address like ana@example.com.")).toBeTruthy();
    expect(screen.getByText("Use a time zone name like Europe/Berlin.")).toBeTruthy();
    expect(screen.getByText("Enter a number.")).toBeTruthy();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
    expect(A.saveContact).not.toHaveBeenCalled();
  });

  it("adds a contact with typed attributes, then opens it", async () => {
    A.saveContact.mockResolvedValue({ ok: "Added ana@example.com", id: "c9" });
    render(<ContactDialog><Button>Add contact</Button></ContactDialog>);
    open("Add contact");
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ana@example.com" } });
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/Berlin" } });
    open("Add attribute");
    fireEvent.change(screen.getByLabelText("Attribute 1 name"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Attribute 1 value"), { target: { value: "pro" } });
    open("Add attribute");
    fireEvent.change(screen.getByLabelText("Attribute 2 name"), { target: { value: "beta" } });
    fireEvent.change(screen.getByLabelText("Attribute 2 type"), { target: { value: "boolean" } });
    expect((screen.getByLabelText("Attribute 2 value") as HTMLSelectElement).value).toBe("true");
    fireEvent.click(screen.getAllByRole("button", { name: "Add contact" }).at(-1)!);
    await waitFor(() => expect(A.saveContact).toHaveBeenCalledTimes(1));
    const d = fd(A.saveContact);
    expect([d.get("email"), d.get("first_name"), d.get("timezone"), d.getAll("attr_key"), d.getAll("attr_type"), d.getAll("attr_value")]).toEqual(
      ["ana@example.com", "Ana", "Europe/Berlin", ["plan", "beta"], ["text", "boolean"], ["pro", "true"]]);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/contacts/c9"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows server errors on the field they belong to and keeps the dialog open", async () => {
    A.saveContact.mockResolvedValue({ error: { code: "already_exists", message: "ana@example.com is already a contact.", field: "email", hint: "Open it to change its details." }, id: "c1" });
    render(<ContactDialog><Button>Add contact</Button></ContactDialog>);
    open("Add contact");
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ana@example.com" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add contact" }).at(-1)!);
    const link = await screen.findByRole("link", { name: "Open contact" });
    expect(link.getAttribute("href")).toBe("/contacts/c1");
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("edit is prefilled, the address is read-only and a removed attribute is reported", async () => {
    const c = { id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva", timezone: "Europe/Berlin", properties: { plan: "pro", seats: 4 } };
    render(<ContactDialog contact={c}><Button>Edit</Button></ContactDialog>);
    open("Edit");
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    expect([email.value, email.readOnly]).toEqual(["ana@example.com", true]);
    expect((screen.getByLabelText("Last name") as HTMLInputElement).value).toBe("Silva");
    expect((screen.getByLabelText("Attribute 2 type") as HTMLSelectElement).value).toBe("number");
    fireEvent.click(screen.getByRole("button", { name: "Remove attribute 1" }));
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(A.saveContact).toHaveBeenCalledTimes(1));
    const d = fd(A.saveContact);
    expect([d.get("id"), d.get("last_name"), d.getAll("attr_key"), d.get("initial_keys")]).toEqual(["c1", "", ["seats"], '["plan","seats"]']);
  });
});

describe("danger zone", () => {
  const c = { id: "c1", email: "ana@example.com" };
  it("delete needs the email typed", async () => {
    render(<DangerZone contact={c} suppressed={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete contact/ }));
    const go = await screen.findByRole("button", { name: "Delete contact", description: "" }).catch(() => null);
    const dlg = screen.getByRole("dialog");
    const confirm = within(dlg).getByRole("button", { name: "Delete contact" }) as HTMLButtonElement;
    expect(go === null || confirm).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/Type/), { target: { value: "ana@example.com" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(A.deleteContact).toHaveBeenCalledTimes(1));
    expect([fd(A.deleteContact, 0, 0).get("id"), fd(A.deleteContact, 0, 0).get("email")]).toEqual(["c1", "ana@example.com"]);
  });
  it("suppress asks first", async () => {
    render(<DangerZone contact={c} suppressed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Suppress" }));
    expect(A.suppressContact).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Suppress", description: /./ }).catch(() => screen.getAllByRole("button", { name: "Suppress" }).at(-1)!));
    await waitFor(() => expect(A.suppressContact).toHaveBeenCalledTimes(1));
  });
  it("a suppressed contact can be allowed again, with the reason in the warning", async () => {
    render(<DangerZone contact={c} suppressed reason="complaint" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove suppression" }));
    expect((await screen.findByRole("alertdialog")).textContent).toMatch(/marked a message as spam/);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove suppression" }));
    await waitFor(() => expect(A.unsuppressContact).toHaveBeenCalledTimes(1));
  });
});

describe("segment form", () => {
  const props = { names: ["Existing"], events: ["login", "signed_up"], attrs: ["plan"] };
  it("builds the filter from conditions and previews who matches", async () => {
    A.previewSegment.mockResolvedValue({ count: 3, sample: [{ email: "a@x.co" }, { email: "b@x.co" }] });
    render(<SegmentDialog {...props}><Button>New segment</Button></SegmentDialog>);
    open("New segment");
    expect(await screen.findByText("Finish the conditions to see who matches.")).toBeTruthy(); // starts with one empty condition
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pros" } });
    fireEvent.change(screen.getByLabelText("Condition 1 attribute name"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Condition 1 value"), { target: { value: "pro" } });
    await waitFor(() => expect(A.previewSegment).toHaveBeenCalledWith({ field: "properties.plan", op: "eq", value: "pro" }), { timeout: 3000 });
    expect(await screen.findByText("3 contacts match right now")).toBeTruthy();
    expect(screen.getByText(/a@x.co, b@x.co/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create segment" }));
    await waitFor(() => expect(A.saveSegment).toHaveBeenCalledTimes(1));
    const d = fd(A.saveSegment);
    expect([d.get("name"), JSON.parse(String(d.get("filter")))]).toEqual(["Pros", { field: "properties.plan", op: "eq", value: "pro" }]);
  });

  it("any/all appears with two conditions and event conditions use the days/times rules", async () => {
    A.previewSegment.mockResolvedValue({ count: 0, sample: [] });
    render(<SegmentDialog {...props}><Button>New segment</Button></SegmentDialog>);
    open("New segment");
    fireEvent.change(await screen.findByLabelText("Condition 1 type"), { target: { value: "event" } });
    fireEvent.change(screen.getByLabelText("Condition 1 event name"), { target: { value: "login" } });
    fireEvent.change(screen.getByLabelText("Condition 1 operator"), { target: { value: "notwithin" } });
    fireEvent.change(screen.getByLabelText("Condition 1 number of days"), { target: { value: "30" } });
    open("Add condition");
    fireEvent.change(screen.getByLabelText("Condition 2 type"), { target: { value: "topic" } });
    fireEvent.change(screen.getByLabelText("Condition 2 topic key"), { target: { value: "digest" } });
    fireEvent.change(screen.getByLabelText("Match all or any condition"), { target: { value: "or" } });
    await waitFor(() => expect(A.previewSegment).toHaveBeenLastCalledWith({ or: [
      { or: [{ field: "days_since:login", op: "exists", value: false }, { field: "days_since:login", op: "gt", value: 30 }] },
      { field: "topic:digest", op: "eq", value: true },
    ] }), { timeout: 3000 });
  });

  it("will not save without a name, with a taken name, or with an unfinished condition", async () => {
    render(<SegmentDialog {...props}><Button>New segment</Button></SegmentDialog>);
    open("New segment");
    fireEvent.click(await screen.findByRole("button", { name: "Create segment" }));
    expect(await screen.findByText("Give the segment a name.")).toBeTruthy();
    expect(screen.getByText("Name the attribute.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Existing" } });
    expect(screen.getByText("A segment with this name already exists.")).toBeTruthy();
    expect(A.saveSegment).not.toHaveBeenCalled();
  });

  it("a manual list sends no filter", async () => {
    render(<SegmentDialog {...props}><Button>New segment</Button></SegmentDialog>);
    open("New segment");
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "VIPs" } });
    fireEvent.click(screen.getByRole("radio", { name: "Manual list" }));
    fireEvent.click(screen.getByRole("button", { name: "Create segment" }));
    await waitFor(() => expect(A.saveSegment).toHaveBeenCalledTimes(1));
    expect(fd(A.saveSegment).get("filter")).toBe("");
    expect(A.previewSegment).not.toHaveBeenCalled();
  });

  it("opens filters the builder cannot show as JSON, and validates the JSON", async () => {
    const segment = { id: "s1", name: "Odd", filter: { not: { field: "email", op: "contains", value: "@x.co" } } };
    render(<SegmentDialog {...props} segment={segment}><Button>Edit</Button></SegmentDialog>);
    open("Edit");
    const ta = (await screen.findByLabelText(/Rules \(JSON\)/)) as HTMLTextAreaElement;
    expect(JSON.parse(ta.value)).toEqual(segment.filter);
    fireEvent.change(ta, { target: { value: "{oops" } });
    expect(await screen.findByText(/Not valid JSON/)).toBeTruthy();
    fireEvent.change(ta, { target: { value: JSON.stringify({ field: "properties.plan", op: "eq", value: "pro" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Use the builder" }));
    expect((screen.getByLabelText("Condition 1 attribute name") as HTMLInputElement).value).toBe("plan");
  });

  it("add members parses addresses and reports junk", async () => {
    A.addSegmentMembers.mockResolvedValue({ ok: "Added 2" });
    render(<AddMembers segment={{ id: "s1", name: "VIPs" }}><Button>Add contacts</Button></AddMembers>);
    open("Add contacts");
    const ta = await screen.findByLabelText("Email addresses");
    fireEvent.change(ta, { target: { value: "a@x.co\nb@y.org, nope" } });
    expect(screen.getByText(/Not an email address: nope/)).toBeTruthy();
    fireEvent.change(ta, { target: { value: "a@x.co\nb@y.org, A@x.co" } });
    expect(screen.getByText(/2 ready to add/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add 2 contacts" }));
    await waitFor(() => expect(A.addSegmentMembers).toHaveBeenCalledTimes(1));
    expect([fd(A.addSegmentMembers).get("id"), fd(A.addSegmentMembers).get("emails")]).toEqual(["s1", "a@x.co\nb@y.org, A@x.co"]);
  });
});

describe("csv import", () => {
  const csv = "email,first_name,plan\nana@example.com,Ana,pro\nnope,X,free\nben@example.com,Ben,\nana@example.com,Dup,pro";
  it("previews valid and skipped rows before anything is sent", async () => {
    render(<ImportContacts />);
    open(/Import CSV/);
    fireEvent.change(await screen.findByLabelText("Or paste the CSV"), { target: { value: csv } });
    expect((await screen.findByText(/ready to import/)).textContent).toMatch(/2 ready to import, 2 will be skipped/);
    expect(screen.getByText("Not a valid email address.")).toBeTruthy();
    expect(screen.getByText("Same address as row 2.")).toBeTruthy();
    expect(screen.getByRole("table", { name: "First rows to import" })).toBeTruthy();
    expect(A.importContactsChunk).not.toHaveBeenCalled();
  });
  it("sends the valid rows in chunks of 500 and summarises what was skipped", async () => {
    A.importContactsChunk.mockImplementation(async (rows: unknown[]) => ({ imported: rows.length - (rows.length === 1 ? 1 : 0), failed: rows.length === 1 ? [{ index: 0, email: "z1000@example.com", message: "Rejected" }] : [] }));
    render(<ImportContacts />);
    open(/Import CSV/);
    const big = "email\n" + Array.from({ length: 1001 }, (_, i) => `z${i}@example.com`).join("\n");
    fireEvent.change(await screen.findByLabelText("Or paste the CSV"), { target: { value: big } });
    fireEvent.click(await screen.findByRole("button", { name: "Import 1,001 contacts" }));
    expect((await screen.findByText(/1,000 contacts imported, 1 skipped/)).textContent).toBeTruthy();
    expect(A.importContactsChunk.mock.calls.map((c) => c[0].length)).toEqual([500, 500, 1]);
    expect(screen.getByText(/Row 1002:/)).toBeTruthy(); // the failed chunk row maps back to its CSV row (header = row 1)
  });
  it("shows a file-level error instead of a preview, and offers the example", async () => {
    render(<ImportContacts />);
    open(/Import CSV/);
    fireEvent.change(await screen.findByLabelText("Or paste the CSV"), { target: { value: "name\nAna" } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/No email column/);
    expect(screen.getByRole("button", { name: /Download example.csv/ })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import contacts" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("track event", () => {
  it("sends a test event for the contact and lists the automations it started", async () => {
    A.trackEvent.mockResolvedValue({ result: { dry: false, triggered: [{ id: "a1" }], inactive: [] } });
    render(<TrackEvent email="ana@example.com" events={["signed_up"]} automations={{ a1: "welcome" }} />);
    open("Track event");
    fireEvent.change(await screen.findByLabelText("Event name"), { target: { value: "signed_up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send event" }));
    await waitFor(() => expect(A.trackEvent).toHaveBeenCalledTimes(1));
    const d = fd(A.trackEvent);
    expect([d.get("email"), d.get("name"), d.get("dry_run")]).toEqual(["ana@example.com", "signed_up", null]);
    expect((await screen.findByRole("link", { name: "welcome" })).getAttribute("href")).toBe("/automations/a1");
    expect(screen.getByText("Event recorded.")).toBeTruthy();
  });
  it("dry run says nothing was recorded; no listener is explained", async () => {
    A.trackEvent.mockResolvedValue({ result: { dry: true, triggered: [], inactive: [{ id: "a2", name: "nudge", status: "draft" }] } });
    render(<TrackEvent email="ana@example.com" events={[]} automations={{}} />);
    open("Track event");
    fireEvent.change(await screen.findByLabelText("Event name"), { target: { value: "x" } });
    fireEvent.click(screen.getByLabelText(/Dry run/));
    fireEvent.click(screen.getByRole("button", { name: "Send event" }));
    expect(await screen.findByText("Dry run: nothing was recorded.")).toBeTruthy();
    expect(screen.getByText("No active automation listens for this event.")).toBeTruthy();
    expect(screen.getByText(/nudge \(draft\)/)).toBeTruthy();
    expect(fd(A.trackEvent).get("dry_run")).toBe("on");
  });
  it("field errors from the server appear under the field", async () => {
    A.trackEvent.mockResolvedValue({ error: { code: "invalid_request", message: "Properties are not valid JSON.", field: "properties" } });
    render(<TrackEvent email="ana@example.com" events={[]} automations={{}} />);
    open("Track event");
    fireEvent.change(await screen.findByLabelText("Event name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Send event" }));
    expect(await screen.findByText("Properties are not valid JSON.")).toBeTruthy();
    expect(screen.getByLabelText("Properties").getAttribute("aria-invalid")).toBe("true");
  });
});
