import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn() } }));
import { ComposeEmail } from "@/components/emails/compose";
import { addRecipients, prefillVars, recipientProblem, splitAddresses, type ContactHit, type ContactsApi } from "@/lib/recipients";

const ana: ContactHit = { id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva", suppressed: false };
const ben: ContactHit = { id: "c2", email: "ben@example.com", first_name: "Ben", suppressed: false };
const bounce: ContactHit = { id: "c3", email: "bounce@example.com", suppressed: true, suppression_reason: "hard_bounce" };
const BOOK = [ana, ben, bounce];

describe("recipient helpers", () => {
  it("splits on commas, semicolons and newlines, but keeps a name search whole", () => {
    expect(splitAddresses("a@x.co, b@x.co;\nc@x.co ,")).toEqual(["a@x.co", "b@x.co", "c@x.co"]);
    expect(splitAddresses("a@x.co b@x.co")).toEqual(["a@x.co", "b@x.co"]);
    expect(splitAddresses("Ada Lovelace")).toEqual(["Ada Lovelace"]);
  });
  it("de-duplicates ignoring case and attaches the contact it came from", () => {
    expect(addRecipients([{ email: "a@x.co" }], ["A@x.co", ana.email], [ana])).toEqual([{ email: "a@x.co" }, { email: "ana@example.com", contact: ana }]);
  });
  it("explains what blocks sending", () => {
    expect(recipientProblem([{ email: "nope" }])).toBe("“nope” is not an email address.");
    expect(recipientProblem([{ email: bounce.email, contact: bounce }])).toBe("bounce@example.com is suppressed (hard bounce), so mailcraft won’t send to it. Remove it to continue.");
    expect(recipientProblem([{ email: ana.email, contact: ana }])).toBeUndefined();
  });
  it("prefills first_name for exactly one known recipient, unless it was edited", () => {
    expect(prefillVars({}, ["first_name"], [{ email: ana.email, contact: ana }])).toEqual({ first_name: "Ana" });
    expect(prefillVars({ first_name: "" }, ["first_name"], [{ email: ana.email, contact: ana }])).toEqual({ first_name: "" });
    expect(prefillVars({}, ["first_name"], [{ email: ana.email, contact: ana }, { email: ben.email, contact: ben }])).toEqual({});
    expect(prefillVars({}, ["amount"], [{ email: ana.email, contact: ana }])).toEqual({});
  });
});

/** A contact book behind the three calls the dialog makes. */
function setup(over: Partial<ContactsApi> = {}, send = vi.fn().mockResolvedValue({ id: "em_1", status: "queued" })) {
  const contacts: ContactsApi = {
    search: vi.fn(async (q: string) => BOOK.filter((c) => `${c.email} ${c.first_name ?? ""}`.toLowerCase().includes(q.toLowerCase()))),
    find: vi.fn(async (email: string) => ({ contact: BOOK.find((c) => c.email === email.toLowerCase()) ?? null })),
    create: vi.fn().mockResolvedValue({}),
    ...over,
  };
  render(<ComposeEmail defaultFrom="dev@example.com" templates={[{ id: "t1", name: "Welcome", variables: ["first_name"] }]} send={send} contacts={contacts} />);
  fireEvent.click(screen.getByRole("button", { name: "New email" }));
  return { contacts, send, to: screen.getByRole("combobox", { name: "To" }) as HTMLInputElement };
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const key = (el: HTMLElement, k: string) => fireEvent.keyDown(el, { key: k });
const fillMessage = () => {
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hi there" } });
};
const sendBtn = () => fireEvent.click(screen.getByRole("button", { name: "Send email" }));
/** Clicks a button once it is enabled: the step shows a beat before the lookup's transition settles. */
const press = async (name: string) => {
  const b = (await screen.findByRole("button", { name })) as HTMLButtonElement;
  await waitFor(() => expect(b.disabled).toBe(false));
  fireEvent.click(b);
};
const chips = () => screen.getAllByRole("button", { name: /^Remove / }).map((b) => b.getAttribute("aria-label")!.slice(7));

describe("To suggestions", () => {
  it("shows name and email after a pause, and picks with the keyboard", async () => {
    const { contacts, to } = setup();
    type(to, "an");
    const list = await screen.findByRole("listbox", { name: "Matching contacts" });
    expect(contacts.search).toHaveBeenCalledWith("an");
    expect(contacts.search).toHaveBeenCalledTimes(1); // typed once, searched once
    const opts = within(list).getAllByRole("option");
    expect(opts[0].textContent).toBe("Ana Silvaana@example.com");
    expect(to.getAttribute("aria-expanded")).toBe("true");
    key(to, "ArrowDown");
    expect(to.getAttribute("aria-activedescendant")).toBe(opts[0].id);
    expect(opts[0].getAttribute("aria-selected")).toBe("true");
    key(to, "Enter");
    expect(chips()).toEqual(["ana@example.com"]);
    expect(to.value).toBe("");
    expect(to.getAttribute("aria-expanded")).toBe("false");
  });
  it("ArrowUp wraps to the last option and Tab picks the active one", async () => {
    const { to } = setup();
    type(to, "example.com");
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    key(to, "ArrowUp");
    key(to, "Tab");
    expect(chips()).toEqual(["bounce@example.com"]);
  });
  it("Escape closes the list and leaves the dialog open", async () => {
    const { to } = setup();
    type(to, "an");
    await screen.findByRole("listbox");
    key(to, "Escape");
    expect(to.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(to.value).toBe("an");
  });
  it("offers to use a typed address that is not a contact, and skips contacts already chosen", async () => {
    const { to } = setup();
    type(to, "ana@example.com");
    fireEvent.click(await screen.findByRole("option", { name: /Ana Silva/ }));
    type(to, "ana@example.com");
    await waitFor(() => expect(screen.getByRole("listbox", { hidden: true }).hasAttribute("hidden")).toBe(true)); // already a chip: nothing left to offer
    type(to, "new@example.com");
    const opt = await screen.findByRole("option", { name: /Use new@example\.com/ });
    fireEvent.click(opt);
    expect(chips()).toEqual(["ana@example.com", "new@example.com"]);
  });
  it("comma and Enter add the typed address; Backspace on an empty box removes the last chip", () => {
    const { to } = setup();
    type(to, "a@example.org,");
    type(to, "b@example.org");
    key(to, "Enter");
    expect(chips()).toEqual(["a@example.org", "b@example.org"]);
    key(to, "Backspace");
    expect(chips()).toEqual(["a@example.org"]);
  });
  it("pasting several addresses makes one chip each", () => {
    const { to } = setup();
    fireEvent.paste(to, { clipboardData: { getData: () => "a@example.org, b@example.org\nc@example.org;a@EXAMPLE.org" } });
    expect(chips()).toEqual(["a@example.org", "b@example.org", "c@example.org"]);
    expect(to.value).toBe("");
  });
  it("an invalid address becomes a flagged chip with a message, and blocks sending", () => {
    const { send, to } = setup();
    type(to, "nope,");
    expect(screen.getByText("(not an email address)")).toBeTruthy();
    expect(screen.getByText("“nope” is not an email address.")).toBeTruthy();
    expect(to.getAttribute("aria-invalid")).toBe("true");
    fillMessage();
    sendBtn();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove nope" }));
    expect(screen.queryByText("“nope” is not an email address.")).toBeNull();
  });
});

describe("unknown address", () => {
  it("opens the add-contact step instead of sending", async () => {
    const { contacts, send, to } = setup();
    type(to, "new@example.com");
    fillMessage();
    sendBtn();
    expect(await screen.findByText("Add 1 new contact")).toBeTruthy();
    expect(contacts.find).toHaveBeenCalledWith("new@example.com");
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText("new@example.com", { selector: "legend" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create contact and send" })).toBeTruthy();
    expect(screen.getByLabelText("Time zone").querySelector("optgroup")).toBeTruthy(); // the grouped zone list of the contact form
  });
  it("Back returns to the message with everything still filled in", async () => {
    const { to } = setup();
    type(to, "new@example.com");
    fillMessage();
    sendBtn();
    await press("Back");
    expect(screen.getByRole("button", { name: "Remove new@example.com" })).toBeTruthy();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Hello");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Hi there");
  });
  it("creates the contacts (PUT) and then sends with the same body", async () => {
    const order: string[] = [];
    const create = vi.fn(async (c: object) => { order.push("create:" + (c as { email: string }).email); return {}; });
    const send = vi.fn(async () => { order.push("send"); return { id: "em_1", status: "queued" }; });
    const { to } = setup({ create }, send);
    type(to, "new@example.com, newer@example.com");
    fillMessage();
    sendBtn();
    expect(await screen.findByText("Add 2 new contacts")).toBeTruthy();
    const first = screen.getByRole("group", { name: "new@example.com" }), second = screen.getByRole("group", { name: "newer@example.com" });
    fireEvent.change(within(first).getByLabelText("First name"), { target: { value: " Nia " } });
    fireEvent.change(within(first).getByLabelText("Last name"), { target: { value: "Park" } });
    fireEvent.change(within(first).getByLabelText("Time zone"), { target: { value: "Europe/Berlin" } });
    expect(within(second).getByLabelText("First name")).toBeTruthy();
    await press("Create 2 contacts and send");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenNthCalledWith(1, { email: "new@example.com", first_name: "Nia", last_name: "Park", timezone: "Europe/Berlin" });
    expect(create).toHaveBeenNthCalledWith(2, { email: "newer@example.com", first_name: undefined, last_name: undefined, timezone: undefined });
    expect(send).toHaveBeenCalledWith({ from: "dev@example.com", to: ["new@example.com", "newer@example.com"], stream: "transactional", subject: "Hello", text: "Hi there" });
    expect(order).toEqual(["create:new@example.com", "create:newer@example.com", "send"]);
  });
  it("a failed create stays on the step, keeps the ones already added, and does not send", async () => {
    const create = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ error: { code: "invalid_request", message: "timezone is not an IANA name" } }).mockResolvedValue({});
    const { send, to } = setup({ create });
    type(to, "new@example.com, newer@example.com");
    fillMessage();
    sendBtn();
    await screen.findByText("Add 2 new contacts");
    await press("Create 2 contacts and send");
    expect((await screen.findByRole("alert")).textContent).toContain("newer@example.com: timezone is not an IANA name");
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText("Add 1 new contact")).toBeTruthy(); // new@example.com is already a contact
    await press("Create contact and send");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(3); // new@ once, newer@ twice
  });
  it("a suggestion and a typed address that is already a contact go straight to send", async () => {
    const { contacts, send, to } = setup();
    type(to, "ana");
    await screen.findByRole("option", { name: /Ana Silva/ });
    key(to, "ArrowDown"); key(to, "Enter"); // a suggestion: known, nothing to look up
    type(to, "ben@example.com"); // typed, but it is a contact: found by the exact lookup
    fillMessage();
    sendBtn();
    await waitFor(() => expect(send).toHaveBeenCalledWith({ from: "dev@example.com", to: ["ana@example.com", "ben@example.com"], stream: "transactional", subject: "Hello", text: "Hi there" }));
    expect(contacts.find).toHaveBeenCalledTimes(1);
    expect(contacts.find).toHaveBeenCalledWith("ben@example.com");
    expect(contacts.create).not.toHaveBeenCalled();
    expect(screen.queryByText(/new contact/)).toBeNull();
  });
  it("a failed lookup is shown and nothing is sent", async () => {
    const { send, to } = setup({ find: vi.fn().mockResolvedValue({ contact: null, error: { code: "unreachable", message: "Cannot reach the API" } }) });
    type(to, "new@example.com");
    fillMessage();
    sendBtn();
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot reach the API");
    expect(send).not.toHaveBeenCalled();
  });
  it("if the send fails after the contacts were added, the message form comes back with the error", async () => {
    const send = vi.fn().mockResolvedValue({ error: { code: "domain_not_verified", message: "cannot send from example.com" } });
    const { contacts, to } = setup({}, send);
    type(to, "new@example.com");
    fillMessage();
    sendBtn();
    await press("Create contact and send");
    expect((await screen.findByRole("alert")).textContent).toContain("domain_not_verified");
    expect(screen.getByRole("button", { name: "Remove new@example.com" })).toBeTruthy();
    await press("Send email"); // retry once the form is enabled again: the address is a contact now
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(contacts.create).toHaveBeenCalledTimes(1);
  });
});

describe("suppressed contact", () => {
  it("is flagged on its chip as soon as it is picked, and blocks sending", async () => {
    const { contacts, send, to } = setup();
    type(to, "bounce");
    fireEvent.click(await screen.findByRole("option", { name: /bounce@example\.com/ }));
    expect(screen.getByText("Suppressed")).toBeTruthy();
    expect(screen.getByText(/bounce@example\.com is suppressed \(hard bounce\)/)).toBeTruthy();
    fillMessage();
    sendBtn();
    expect(send).not.toHaveBeenCalled();
    expect(contacts.find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove bounce@example.com" }));
    expect(screen.queryByText(/is suppressed/)).toBeNull();
  });
  it("is caught by the lookup when the address was typed", async () => {
    const { send, to } = setup();
    type(to, "bounce@example.com");
    fillMessage();
    sendBtn();
    expect(await screen.findByText(/bounce@example\.com is suppressed/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText(/new contact/)).toBeNull();
  });
});

describe("template variables", () => {
  const useTemplate = () => {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Use a template" }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "t1" } });
  };
  it("first_name is prefilled from a single contact recipient, and still editable", async () => {
    const { send, to } = setup();
    type(to, "an");
    fireEvent.click(await screen.findByRole("option", { name: /Ana Silva/ }));
    useTemplate();
    expect((screen.getByLabelText("first_name") as HTMLInputElement).value).toBe("Ana");
    fireEvent.change(screen.getByLabelText("first_name"), { target: { value: "Annie" } });
    sendBtn();
    await waitFor(() => expect(send).toHaveBeenCalledWith({ from: "dev@example.com", to: ["ana@example.com"], stream: "transactional", template: { id: "t1", variables: { first_name: "Annie" } } }));
  });
  it("is not prefilled with several recipients", async () => {
    const { to } = setup();
    type(to, "ana@example.com, ben@example.com,");
    useTemplate();
    expect((screen.getByLabelText("first_name") as HTMLInputElement).value).toBe("");
  });
});
