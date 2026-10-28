import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slack for a loaded CI box: waitFor/findBy default to 1 s and a test to 5 s.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30000 });

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const A = vi.hoisted(() => ({
  addToList: vi.fn(), deleteList: vi.fn(), removeFromList: vi.fn(), saveList: vi.fn(),
  saveContact: vi.fn(), saveSegment: vi.fn(), previewSegment: vi.fn(), addSegmentMembers: vi.fn(), deleteSegment: vi.fn(),
  importContactsChunk: vi.fn(), previewImportChunk: vi.fn(),
}));
vi.mock("@/app/(app)/contacts/actions", () => A);
const T = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: T }));

import { ContactsView } from "@/app/(app)/contacts/ContactsView";
import { AddToList, ContactLists, ListBadges, ListsTab } from "@/app/(app)/contacts/ListsUI";
import type { Contact, ListItem, ListRef } from "@/app/(app)/contacts/util";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

const fd = (fn: { mock: { calls: unknown[][] } }, call = 0, arg = 1) => fn.mock.calls[call][arg] as FormData;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const withTips = (ui: React.ReactNode) => <TooltipProvider>{ui}</TooltipProvider>;

const lists: ListItem[] = [
  { id: "l-man", name: "VIPs", description: "Hand picked", origin: "manual", member_count: 3, created_at: "2026-10-01T09:00:00Z" },
  { id: "l-imp", name: "Webinar Oct 2026", origin: "import", member_count: 1234, created_at: "2026-10-02T09:00:00Z" },
  { id: "l-src", name: "Acme app", origin: "source", source_id: "s1", detached: false, member_count: 56 },
  { id: "l-det", name: "Old CRM", origin: "source", source_id: null, detached: true, member_count: 8 },
];

beforeEach(() => {
  vi.resetAllMocks();
  A.addToList.mockResolvedValue({}); A.removeFromList.mockResolvedValue({}); A.saveList.mockResolvedValue({}); A.saveContact.mockResolvedValue({});
});
afterEach(cleanup);

describe("ListBadges", () => {
  it("renders nothing without lists", () => {
    const { container, rerender } = render(<ListBadges />);
    expect(container.innerHTML).toBe("");
    rerender(<ListBadges lists={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("a source's list reads 'from <name>', any other list is just its name; each links to the filtered contacts", () => {
    const refs: ListRef[] = [{ id: "a", name: "Acme app", origin: "source" }, { id: "b", name: "VIPs", origin: "manual" }, { id: "c", name: "March", origin: "import" }];
    render(withTips(<ListBadges lists={refs} />));
    const links = within(screen.getByRole("list", { name: "Lists" })).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["from Acme app", "/contacts?list=a"], ["VIPs", "/contacts?list=b"], ["March", "/contacts?list=c"],
    ]);
  });

  it("the list id is URL-encoded", () => {
    render(withTips(<ListBadges lists={[{ id: "a b/c", name: "Odd", origin: "manual" }]} />));
    expect(screen.getByRole("link", { name: "Odd" }).getAttribute("href")).toBe("/contacts?list=a%20b%2Fc");
  });

  it("shows at most 3 and counts the rest as +N", () => {
    const five: ListRef[] = ["A", "B", "C", "D", "E"].map((n) => ({ id: n.toLowerCase(), name: n, origin: "manual" as const }));
    const { unmount } = render(withTips(<ListBadges lists={five} />));
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["A", "B", "C"]);
    expect(screen.getByText("+2")).toBeTruthy();
    unmount();
    render(withTips(<ListBadges lists={five} max={4} />));
    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(screen.getByText("+1")).toBeTruthy();
  });

  it("no +N when everything fits; the overflow is reachable by keyboard and names the hidden lists", async () => {
    const three: ListRef[] = ["A", "B", "C"].map((n) => ({ id: n, name: n, origin: "manual" as const }));
    const { unmount } = render(withTips(<ListBadges lists={three} />));
    expect(screen.queryByText(/^\+/)).toBeNull();
    unmount();
    const five: ListRef[] = ["A", "B", "C", "D", "E"].map((n) => ({ id: n, name: n, origin: "manual" as const }));
    render(withTips(<ListBadges lists={five} />));
    const more = screen.getByText("+2").closest("[tabindex]") as HTMLElement;
    expect(more.tabIndex).toBe(0);
    fireEvent.focus(more);
    expect((await screen.findAllByText("D, E")).length).toBeGreaterThan(0);
  });
});

describe("ListsTab table", () => {
  it("with no lists: an empty state that offers to create the first one", () => {
    render(withTips(<ListsTab lists={[]} />));
    expect(screen.getByText("No lists yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: /Create your first list/ })).toBeTruthy();
  });

  it("every list with its origin label, size and link to its contacts", () => {
    render(withTips(<ListsTab lists={lists} />));
    const rows = within(screen.getByRole("table", { name: "Lists" })).getAllByRole("row").slice(1);
    const cells = rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(cells.map((c) => [c[0], c[1], c[2]])).toEqual([
      ["VIPsHand picked", "Manual", "3"], ["Webinar Oct 2026", "CSV import", "1,234"], ["Acme app", "Contact source", "56"], ["Old CRM", "Source (detached)", "8"],
    ]);
    expect(within(rows[0]).getByRole("link", { name: "VIPs" }).getAttribute("href")).toBe("/contacts?list=l-man");
    expect(within(rows[2]).getByText("-")).toBeTruthy(); // no created_at
    expect(within(rows[0]).queryByText("-")).toBeNull();
  });

  it("a list fed by a contact source cannot be deleted or filled by hand; a detached one can", () => {
    render(withTips(<ListsTab lists={lists} />));
    const del = screen.getByRole("button", { name: "Delete Acme app" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.click(del);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add contacts to Acme app by email/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Acme app" })).toBeTruthy(); // renaming is fine
    for (const n of ["VIPs", "Webinar Oct 2026", "Old CRM"]) {
      expect((screen.getByRole("button", { name: `Delete ${n}` }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole("button", { name: `Add contacts to ${n} by email` })).toBeTruthy();
    }
  });

  it("deleting needs the list name typed and says the contacts are kept", async () => {
    render(withTips(<ListsTab lists={lists} />));
    click("Delete Webinar Oct 2026");
    const q = within(await screen.findByRole("dialog", { name: "Delete this list?" }));
    expect(q.getByText(/Its 1,234 contacts are kept, and so are their suppressions/)).toBeTruthy();
    const go = q.getByRole("button", { name: "Delete list" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(q.getByLabelText(/Type/), { target: { value: "Webinar" } });
    expect(go.disabled).toBe(true);
    fireEvent.change(q.getByLabelText(/Type/), { target: { value: "Webinar Oct 2026" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(A.deleteList).toHaveBeenCalledTimes(1));
    const d = fd(A.deleteList, 0, 0);
    expect([d.get("id"), d.get("name")]).toEqual(["l-imp", "Webinar Oct 2026"]);
  });

  it("cancel leaves the list alone", async () => {
    render(withTips(<ListsTab lists={lists} />));
    click("Delete VIPs");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(A.deleteList).not.toHaveBeenCalled();
  });

  it("New list posts name and description and closes on success", async () => {
    A.saveList.mockResolvedValue({ ok: "Created Press" });
    render(withTips(<ListsTab lists={lists} />));
    click("New list");
    const q = within(await screen.findByRole("dialog", { name: "New list" }));
    fireEvent.change(q.getByLabelText("Display name"), { target: { value: "Press" } });
    fireEvent.change(q.getByLabelText("Description"), { target: { value: "Journalists" } });
    fireEvent.click(q.getByRole("button", { name: "Create list" }));
    await waitFor(() => expect(A.saveList).toHaveBeenCalledTimes(1));
    const d = fd(A.saveList);
    expect([d.get("id"), d.get("name"), d.get("description")]).toEqual([null, "Press", "Journalists"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(T.success).toHaveBeenCalledWith("Created Press");
  });

  it("Edit is prefilled and posts the id; a name error shows under the field", async () => {
    A.saveList.mockResolvedValue({ error: { code: "already_exists", message: "A list with this name exists.", field: "name" } });
    render(withTips(<ListsTab lists={lists} />));
    click("Edit VIPs");
    const q = within(await screen.findByRole("dialog", { name: "Edit VIPs" }));
    expect([(q.getByLabelText("Display name") as HTMLInputElement).value, (q.getByLabelText("Description") as HTMLTextAreaElement).value]).toEqual(["VIPs", "Hand picked"]);
    fireEvent.click(q.getByRole("button", { name: "Save changes" }));
    expect(await q.findByText("A list with this name exists.")).toBeTruthy();
    expect(fd(A.saveList).get("id")).toBe("l-man");
    expect(q.getByLabelText("Display name").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("AddToList dialog", () => {
  const open = (props: Partial<React.ComponentProps<typeof AddToList>> = {}) => {
    render(withTips(<AddToList ids={["c1", "c2"]} label="2 contacts" lists={lists} {...props}><Button>Add to list</Button></AddToList>));
    click("Add to list");
    return screen.findByRole("dialog", { name: "Add to a list" }).then((d) => within(d));
  };

  it("offers the existing lists (never one a source fills) and 'New list…', with sizes", async () => {
    const q = await open();
    const sel = q.getByLabelText("List") as HTMLSelectElement;
    expect([...sel.options].map((o) => [o.value, o.textContent])).toEqual([["l-man", "VIPs (3)"], ["l-imp", "Webinar Oct 2026 (1,234)"], ["l-det", "Old CRM (8)"], ["new", "New list…"]]);
    expect(sel.value).toBe("l-man");
    expect(q.getByText("2 contacts. They stay on every list they are already on.")).toBeTruthy();
    expect(q.queryByLabelText("New list name")).toBeNull();
  });

  it("adds the contacts to the chosen existing list", async () => {
    A.addToList.mockResolvedValue({ ok: "Added 2 contacts to Webinar Oct 2026" });
    const q = await open();
    fireEvent.change(q.getByLabelText("List"), { target: { value: "l-imp" } });
    fireEvent.click(q.getByRole("button", { name: "Add 2 contacts" }));
    await waitFor(() => expect(A.addToList).toHaveBeenCalledTimes(1));
    const d = fd(A.addToList);
    expect([d.getAll("id"), d.get("list_id"), d.get("list_label"), d.get("new_name")]).toEqual([["c1", "c2"], "l-imp", "Webinar Oct 2026", null]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(T.success).toHaveBeenCalledWith("Added 2 contacts to Webinar Oct 2026");
  });

  it("'New list…' asks for a name, which is required, and posts it with list_id 'new'", async () => {
    A.addToList.mockResolvedValue({ ok: "Added 2 contacts to Launch" });
    const q = await open();
    fireEvent.change(q.getByLabelText("List"), { target: { value: "new" } });
    const name = q.getByLabelText("New list name") as HTMLInputElement;
    expect(name.required).toBe(true);
    fireEvent.click(q.getByRole("button", { name: "Add 2 contacts" })); // blocked by the browser's required check
    expect(A.addToList).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Launch" } });
    fireEvent.click(q.getByRole("button", { name: "Add 2 contacts" }));
    await waitFor(() => expect(A.addToList).toHaveBeenCalledTimes(1));
    const d = fd(A.addToList);
    expect([d.get("list_id"), d.get("new_name"), d.get("list_label")]).toEqual(["new", "Launch", ""]);
  });

  // BUG (ListsUI.tsx AddBody): `new_name` is uncontrolled, so React's post-action form reset empties it after a rejected add.
  it.fails("a rejected add keeps the typed list name", async () => {
    A.addToList.mockResolvedValue({ error: { code: "already_exists", message: "A list with this name exists.", field: "new_name" } });
    const q = await open({ lists: [] });
    fireEvent.change(q.getByLabelText("New list name"), { target: { value: "VIPs" } });
    fireEvent.click(q.getByRole("button", { name: "Add 2 contacts" }));
    await q.findByText("A list with this name exists.");
    expect((q.getByLabelText("New list name") as HTMLInputElement).value).toBe("VIPs");
  });

  it("with no list to pick, it starts on 'New list…'; one contact reads singular", async () => {
    const q = await open({ ids: ["c1"], label: "ana@example.com", lists: [lists[2]] }); // only a source list
    expect((q.getByLabelText("List") as HTMLSelectElement).value).toBe("new");
    expect([...(q.getByLabelText("List") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["new"]);
    expect(q.getByLabelText("New list name")).toBeTruthy();
    expect(q.getByRole("button", { name: "Add 1 contact" })).toBeTruthy();
  });

  it("server errors land on the field they name, or show as an alert", async () => {
    A.addToList.mockResolvedValueOnce({ error: { code: "invalid_request", message: "Give the new list a name.", field: "new_name" } });
    const q = await open({ lists: [] });
    fireEvent.change(q.getByLabelText("New list name"), { target: { value: " " } });
    fireEvent.click(q.getByRole("button", { name: "Add 2 contacts" }));
    expect(await q.findByText("Give the new list a name.")).toBeTruthy();
    expect(q.getByLabelText("New list name").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(q.getByLabelText("New list name"), { target: { value: "Again" } });
    A.addToList.mockResolvedValueOnce({ error: { code: "internal", message: "The API is down." } });
    fireEvent.click(q.getByRole("button", { name: "Add 2 contacts" }));
    expect((await q.findByRole("alert")).textContent).toContain("The API is down.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("ContactLists (the contact page's Lists card)", () => {
  const contact = { id: "c1", email: "ana@example.com" };
  const member: ListRef[] = [{ id: "l-src", name: "Acme app", origin: "source" }, { id: "l-man", name: "VIPs", origin: "manual" }];

  it("not on any list yet", () => {
    render(withTips(<ContactLists contact={contact} member={[]} lists={lists} />));
    expect(screen.getByText("Not on any list yet.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Lists" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add to list" })).toBeTruthy();
  });

  it("the lists it is on are links, a source's reads 'from X', each has a remove button", () => {
    render(withTips(<ContactLists contact={contact} member={member} lists={lists} />));
    const items = within(screen.getByRole("list", { name: "Lists" })).getAllByRole("listitem");
    expect(items.map((li) => within(li).getByRole("link").textContent)).toEqual(["from Acme app", "VIPs"]);
    expect(within(items[1]).getByRole("link").getAttribute("href")).toBe("/contacts?list=l-man");
    expect(screen.getByRole("button", { name: "Remove from Acme app" })).toBeTruthy();
  });

  it("remove posts the contact and the list, then toasts; a failure toasts the message", async () => {
    A.removeFromList.mockResolvedValueOnce({ ok: "Removed 1 contact from VIPs" });
    render(withTips(<ContactLists contact={contact} member={member} lists={lists} />));
    click("Remove from VIPs");
    await waitFor(() => expect(T.success).toHaveBeenCalledWith("Removed 1 contact from VIPs"));
    const d = fd(A.removeFromList);
    expect([d.get("id"), d.get("list_id"), d.get("list_label")]).toEqual(["c1", "l-man", "VIPs"]);
    A.removeFromList.mockResolvedValueOnce({ error: { code: "not_found", message: "That list is gone." } });
    click("Remove from Acme app");
    await waitFor(() => expect(T.error).toHaveBeenCalledWith("That list is gone."));
  });

  it("Add to list offers only lists it is not on yet, and never a source's", async () => {
    render(withTips(<ContactLists contact={contact} member={member} lists={lists} />));
    click("Add to list");
    const sel = within(await screen.findByRole("dialog")).getByLabelText("List") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["l-imp", "l-det", "new"]); // VIPs (member) and Acme app (source) are out
    expect(within(screen.getByRole("dialog")).getByText("ana@example.com. They stay on every list they are already on.")).toBeTruthy();
  });
});

describe("ContactsView: list filter, badges and bulk bar", () => {
  const contacts: Contact[] = [
    { id: "c1", email: "ana@example.com", first_name: "Ana", lists: [{ id: "l-src", name: "Acme app", origin: "source" }, { id: "l-man", name: "VIPs", origin: "manual" }] },
    { id: "c2", email: "ben@example.com", lists: [] },
    { id: "c3", email: "cy@example.com", lists: [{ id: "l-man", name: "VIPs", origin: "manual" }] },
  ];
  const view = (over: Partial<React.ComponentProps<typeof ContactsView>> = {}) =>
    render(withTips(<ContactsView contacts={contacts} segments={[]} lists={lists} contactsError={null} segmentsError={null} tab="contacts" {...over} />));
  const bar = () => screen.queryByRole("region", { name: "Selected contacts" });

  it("one chip per list with its count, 'All contacts' first; the active one is marked", () => {
    view({ activeList: "l-man" });
    const nav = within(screen.getByRole("navigation", { name: "Filter by list" }));
    const links = nav.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["All contacts", "VIPs3", "Webinar Oct 20261,234", "Acme app56", "Old CRM8"]);
    expect(links[0].getAttribute("href")).toMatch(/^\/contacts\??$/);
    expect(links.slice(1).map((l) => l.getAttribute("href"))).toEqual(["/contacts?list=l-man", "/contacts?list=l-imp", "/contacts?list=l-src", "/contacts?list=l-det"]);
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual([null, "page", null, null, null]);
  });

  it("with no list chosen, All contacts is the current one", () => {
    view();
    const links = within(screen.getByRole("navigation", { name: "Filter by list" })).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual(["page", null, null, null, null]);
  });

  it("the chips keep the search, and the search box keeps the list", () => {
    view({ search: "ana", activeList: "l-man" });
    const links = within(screen.getByRole("navigation", { name: "Filter by list" })).getAllByRole("link");
    expect(links[0].getAttribute("href")).toBe("/contacts?q=ana");
    expect(links[1].getAttribute("href")).toBe("/contacts?list=l-man&q=ana");
    const box = screen.getByLabelText("Search contacts") as HTMLInputElement;
    expect([box.placeholder, (box.form!.elements.namedItem("list") as HTMLInputElement).value]).toEqual(["Search VIPs, then Enter", "l-man"]);
    expect(screen.getByRole("table", { name: "Contacts on VIPs" })).toBeTruthy();
  });

  it("no chips at all when there are no lists", () => {
    view({ lists: [] });
    expect(screen.queryByRole("navigation", { name: "Filter by list" })).toBeNull();
  });

  it("an empty list says so and links back to all contacts; filtering does not show the 'no contacts yet' state", () => {
    view({ contacts: [], activeList: "l-imp" });
    expect(screen.getByText("Nobody is on this list yet")).toBeTruthy();
    expect(screen.queryByText("No contacts yet")).toBeNull();
    expect(screen.getAllByRole("link", { name: "All contacts" }).some((a) => a.getAttribute("href") === "/contacts?list=l-imp")).toBe(true);
  });

  it("the Lists column shows each contact's lists as badges, or a dash", () => {
    view();
    const rows = within(screen.getByRole("table", { name: "Contacts" })).getAllByRole("row").slice(1);
    expect(within(rows[0]).getAllByRole("link").map((l) => l.textContent)).toEqual(["ana@example.com", "from Acme app", "VIPs"]);
    expect(within(rows[1]).queryByRole("list", { name: "Lists" })).toBeNull();
    expect(within(rows[2]).getByRole("list", { name: "Lists" })).toBeTruthy();
  });

  it("the tab labels carry counts and the Lists tab renders the lists table", () => {
    view({ tab: "lists" });
    expect(screen.getByRole("tab", { name: /^Lists\s*4$/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Lists" })).toBeTruthy();
  });

  it("ticking a row opens the bulk bar for that contact; Clear closes it", () => {
    view();
    expect(bar()).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ana@example.com" }));
    expect(within(bar()!).getByRole("status").textContent).toBe("1 selected");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Clear" }));
    expect(bar()).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Select ana@example.com" }) as HTMLInputElement).checked).toBe(false);
  });

  it("select-all picks every row on the page and again unpicks them", () => {
    view();
    const all = screen.getByRole("checkbox", { name: "Select all contacts on this page" }) as HTMLInputElement;
    fireEvent.click(all);
    expect(within(bar()!).getByRole("status").textContent).toBe("3 selected");
    expect(all.checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ben@example.com" }));
    expect(within(bar()!).getByRole("status").textContent).toBe("2 selected");
    expect(all.checked).toBe(false);
    fireEvent.click(all);
    expect(within(bar()!).getByRole("status").textContent).toBe("3 selected");
    fireEvent.click(all);
    expect(bar()).toBeNull();
  });

  it("Add to list in the bar names one contact by email, several by count, and posts every picked id", async () => {
    A.addToList.mockResolvedValue({ ok: "Added 2 contacts to VIPs" });
    view();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ana@example.com" }));
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to list" }));
    expect((await screen.findByRole("dialog")).textContent).toContain("ana@example.com. They stay on every list they are already on.");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("checkbox", { name: "Select cy@example.com" }));
    fireEvent.click(within(bar()!).getByRole("button", { name: "Add to list" }));
    const q = within(await screen.findByRole("dialog"));
    expect(q.getByText("2 contacts. They stay on every list they are already on.")).toBeTruthy();
    fireEvent.click(q.getByRole("button", { name: "Add 2 contacts" }));
    await waitFor(() => expect(A.addToList).toHaveBeenCalledTimes(1));
    expect(fd(A.addToList).getAll("id")).toEqual(["c1", "c3"]);
  });

  it("'Remove from <list>' appears only inside a list, posts the picked ids and that list, and clears the selection when it worked", async () => {
    A.removeFromList.mockResolvedValue({ ok: "Removed 2 contacts from VIPs" });
    const { unmount } = view();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ana@example.com" }));
    expect(within(bar()!).queryByRole("button", { name: /Remove from/ })).toBeNull();
    unmount();
    view({ activeList: "l-man" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all contacts on this page" }));
    fireEvent.click(within(bar()!).getByRole("button", { name: "Remove from VIPs" }));
    await waitFor(() => expect(A.removeFromList).toHaveBeenCalledTimes(1));
    const d = fd(A.removeFromList);
    expect([d.getAll("id"), d.get("list_id"), d.get("list_label")]).toEqual([["c1", "c2", "c3"], "l-man", "VIPs"]);
    await waitFor(() => expect(T.success).toHaveBeenCalledWith("Removed 2 contacts from VIPs"));
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("when removing fails, the error is toasted and the selection is kept", async () => {
    A.removeFromList.mockResolvedValue({ error: { code: "internal", message: "Could not remove." } });
    view({ activeList: "l-man" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ana@example.com" }));
    fireEvent.click(within(bar()!).getByRole("button", { name: "Remove from VIPs" }));
    await waitFor(() => expect(T.error).toHaveBeenCalledWith("Could not remove."));
    expect(bar()).toBeTruthy();
  });

  // BUG (ContactsView.tsx ContactsTab, `picked` state; page.tsx renders <ContactsView> without a key): ticks survive a list or page
  // change, so the bar counts, and Add to list / Remove from list acts on, people who are no longer on screen. Drop `.fails` once fixed.
  it.fails("the selection follows the page: moving to another list does not keep ticks for people no longer shown", () => {
    const { rerender } = view();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ana@example.com" }));
    expect(bar()).toBeTruthy();
    rerender(withTips(<ContactsView contacts={[contacts[2]]} segments={[]} lists={lists} contactsError={null} segmentsError={null} tab="contacts" activeList="l-imp" />));
    expect(bar()).toBeNull();
  });
});
