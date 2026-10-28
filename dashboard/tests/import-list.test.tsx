import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slack for a loaded CI box: waitFor/findBy default to 1 s and a test to 5 s.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30000 });

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const A = vi.hoisted(() => ({ importContactsChunk: vi.fn(), previewImportChunk: vi.fn() }));
vi.mock("@/app/(app)/contacts/actions", () => A);

import { ImportContacts } from "@/app/(app)/contacts/ImportContacts";
import type { ListItem } from "@/app/(app)/contacts/util";

const lists: ListItem[] = [
  { id: "l-man", name: "VIPs", origin: "manual", member_count: 3 },
  { id: "l-imp", name: "Webinar Oct 2026", origin: "import", member_count: 1234 },
  { id: "l-src", name: "Acme app", origin: "source", source_id: "s1", detached: false, member_count: 56 },
];
const csv = "email,first_name\nana@example.com,Ana\nben@example.com,Ben";

type Target = { id?: string; name?: string } | null;
/** The server's dry run, reduced: every row is new, and the list is reported back the way the API does. */
function dryRun(contacts: { email: string }[], target: Target) {
  return {
    rows: contacts.map((c, i) => ({ index: i, email: c.email, status: "new", list: target ? "add" : null })),
    list: target ? { id: target.id ?? null, name: target.id ? lists.find((l) => l.id === target.id)!.name : target.name!, exists: !!target.id } : null,
  };
}

beforeEach(() => {
  vi.resetAllMocks(); // also drops unconsumed mockImplementationOnce queues
  A.previewImportChunk.mockImplementation(async (contacts: { email: string }[], target: Target) => dryRun(contacts, target));
  A.importContactsChunk.mockImplementation(async (contacts: unknown[]) => ({ imported: contacts.length, failed: [] }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function openWith(text: string, props: { lists?: ListItem[] } = { lists }) {
  render(<ImportContacts {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Import CSV/ }));
  fireEvent.change(await screen.findByLabelText("Or paste the CSV"), { target: { value: text } });
}
const listSelect = () => screen.getByLabelText("List") as HTMLSelectElement;
const nameBox = () => screen.getByLabelText("New list name") as HTMLInputElement;
const lastTarget = () => A.previewImportChunk.mock.calls.at(-1)![1];
const uploaded = (name: string, body: string) => {
  const file = new File([body], name, { type: "text/csv" });
  if (!file.text) Object.defineProperty(file, "text", { value: async () => body });
  fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
};

describe("Add to list select", () => {
  it("appears once the CSV has rows, not before", async () => {
    render(<ImportContacts lists={lists} />);
    fireEvent.click(screen.getByRole("button", { name: /Import CSV/ }));
    const paste = await screen.findByLabelText("Or paste the CSV");
    expect(screen.queryByText("Add to a list")).toBeNull();
    fireEvent.change(paste, { target: { value: "name\nAna" } }); // no email column: nothing to import
    expect(screen.queryByText("Add to a list")).toBeNull();
    fireEvent.change(paste, { target: { value: csv } });
    expect(await screen.findByText("Add to a list")).toBeTruthy();
    expect(listSelect()).toBeTruthy();
  });

  it("offers a new list, the existing ones with their sizes (not a source's), and 'Do not add'", async () => {
    await openWith(csv);
    expect([...listSelect().options].map((o) => [o.value, o.textContent])).toEqual([
      ["new", "New list…"], ["l-man", "VIPs (3)"], ["l-imp", "Webinar Oct 2026 (1,234)"], ["", "Do not add to a list"],
    ]);
    expect(listSelect().querySelector("optgroup")!.label).toBe("Existing lists");
  });

  it("with no lists yet, there is no 'Existing lists' group", async () => {
    await openWith(csv, { lists: [] });
    expect(listSelect().querySelector("optgroup")).toBeNull();
    expect([...listSelect().options].map((o) => o.value)).toEqual(["new", ""]);
  });

  it("with no lists prop at all it still works (default)", async () => {
    await openWith(csv, {});
    expect(listSelect().value).toBe("new");
  });
});

describe("default list name", () => {
  it("is a new list named after the file, without the extension", async () => {
    render(<ImportContacts lists={lists} />);
    fireEvent.click(screen.getByRole("button", { name: /Import CSV/ }));
    await screen.findByLabelText("CSV file");
    uploaded("webinar-signups_Oct.2026.csv", csv);
    await screen.findByText("Add to a list");
    expect(listSelect().value).toBe("new");
    expect(nameBox().value).toBe("webinar signups Oct.2026"); // only the last extension goes; - and _ become spaces
    await waitFor(() => expect(lastTarget()).toEqual({ name: "webinar signups Oct.2026" }));
  });

  it("a pasted CSV gets 'Import <date>'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    await openWith(csv);
    expect(nameBox().value).toBe("Import 2026-10-28");
    await waitFor(() => expect(lastTarget()).toEqual({ name: "Import 2026-10-28" }));
  });

  it("a typed name wins, and a file chosen afterwards does not overwrite it", async () => {
    await openWith(csv);
    fireEvent.change(nameBox(), { target: { value: "Press list" } });
    await waitFor(() => expect(lastTarget()).toEqual({ name: "Press list" }));
    uploaded("other.csv", `${csv}\ncy@example.com,Cy`);
    await waitFor(() => expect(A.previewImportChunk.mock.calls.at(-1)![0]).toHaveLength(3));
    expect(nameBox().value).toBe("Press list");
    expect(lastTarget()).toEqual({ name: "Press list" });
  });

  it("the name is trimmed", async () => {
    await openWith(csv);
    fireEvent.change(nameBox(), { target: { value: "  Press  " } });
    await waitFor(() => expect(lastTarget()).toEqual({ name: "Press" }));
  });

  it("a file over 4 MB is refused with a message and nothing is read", async () => {
    render(<ImportContacts lists={lists} />);
    fireEvent.click(screen.getByRole("button", { name: /Import CSV/ }));
    await screen.findByLabelText("CSV file");
    const big = new File(["x"], "huge.csv", { type: "text/csv" });
    Object.defineProperty(big, "size", { value: 5 * 1048576 });
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [big] } });
    expect(await screen.findByText("That file is 5.0 MB; the limit is 4 MB. Split it.")).toBeTruthy();
    expect(screen.queryByText("Add to a list")).toBeNull();
  });
});

describe("the chosen target reaches the server", () => {
  it("default: previews and imports into the new list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    await openWith(csv);
    await waitFor(() => expect(A.previewImportChunk).toHaveBeenCalled());
    expect(A.previewImportChunk).toHaveBeenLastCalledWith([{ email: "ana@example.com", first_name: "Ana" }, { email: "ben@example.com", first_name: "Ben" }], { name: "Import 2026-10-28" });
    fireEvent.click(await screen.findByRole("button", { name: "Import 2 contacts" }));
    await waitFor(() => expect(A.importContactsChunk).toHaveBeenCalledTimes(1));
    expect(A.importContactsChunk.mock.calls[0][1]).toEqual({ name: "Import 2026-10-28" });
    expect((await screen.findByText(/Everyone imported is on/)).textContent).toContain("Import 2026-10-28");
  });

  it("an existing list: the id goes to the preview again and to the import, and the name field goes away", async () => {
    await openWith(csv);
    await waitFor(() => expect(A.previewImportChunk).toHaveBeenCalledTimes(1));
    fireEvent.change(listSelect(), { target: { value: "l-imp" } });
    expect(screen.queryByLabelText("New list name")).toBeNull();
    await waitFor(() => expect(A.previewImportChunk).toHaveBeenCalledTimes(2));
    expect(lastTarget()).toEqual({ id: "l-imp" });
    fireEvent.click(await screen.findByRole("button", { name: "Import 2 contacts" }));
    await waitFor(() => expect(A.importContactsChunk).toHaveBeenCalledTimes(1));
    expect(A.importContactsChunk.mock.calls[0][1]).toEqual({ id: "l-imp" });
    expect((await screen.findByText(/Everyone imported is on/)).textContent).toContain("Webinar Oct 2026");
  });

  it("'Do not add to a list' sends no target at all, and the result does not claim a list", async () => {
    await openWith(csv);
    fireEvent.change(listSelect(), { target: { value: "" } });
    expect(screen.queryByLabelText("New list name")).toBeNull();
    await waitFor(() => expect(lastTarget()).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Import 2 contacts" }));
    await waitFor(() => expect(A.importContactsChunk).toHaveBeenCalledTimes(1));
    expect(A.importContactsChunk.mock.calls[0][1]).toBeNull();
    expect(await screen.findByText(/2 contacts imported/)).toBeTruthy();
    expect(screen.queryByText(/Everyone imported is on/)).toBeNull();
  });

  it("going back to 'New list…' restores the suggested name", async () => {
    await openWith(csv);
    fireEvent.change(listSelect(), { target: { value: "l-man" } });
    fireEvent.change(listSelect(), { target: { value: "new" } });
    expect(nameBox().value).toMatch(/^Import \d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(lastTarget()).toEqual({ name: nameBox().value }));
  });

  it("a blank 'New list…' name is refused instead of importing into no list", async () => {
    await openWith(csv);
    fireEvent.change(nameBox(), { target: { value: "  " } });
    expect(await screen.findByText("Give the list a name, or choose Do not add to a list.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Import \d+ contacts?$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(listSelect(), { target: { value: "" } }); // explicitly no list: fine again
    expect((screen.getByRole("button", { name: /^Import \d+ contacts?$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("every chunk of a big file carries the same target, in the preview and in the import", async () => {
    const big = "email\n" + Array.from({ length: 1001 }, (_, i) => `z${i}@example.com`).join("\n");
    await openWith(big);
    fireEvent.change(listSelect(), { target: { value: "l-man" } });
    await waitFor(() => expect(A.previewImportChunk.mock.calls.filter((c) => c[1]?.id === "l-man")).toHaveLength(3), { timeout: 3000 });
    fireEvent.click(await screen.findByRole("button", { name: "Import 1,001 contacts" }));
    await waitFor(() => expect(A.importContactsChunk).toHaveBeenCalledTimes(3));
    expect(A.importContactsChunk.mock.calls.map((c) => [c[0].length, c[1]])).toEqual([[500, { id: "l-man" }], [500, { id: "l-man" }], [1, { id: "l-man" }]]);
  });
});

describe("diff preview before Import", () => {
  it("asks the server what would change, shows it, and writes nothing until Import is pressed", async () => {
    await openWith(csv);
    expect(await screen.findByText("Checking what would change…")).toBeTruthy();
    const table = await screen.findByRole("table", { name: "What the import would change" });
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2 contacts
    expect(within(screen.getByRole("list", { name: "Summary" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["New2", "Update0", "Unchanged0", "Skipped0"]);
    expect(screen.queryByText("Checking what would change…")).toBeNull();
    expect(A.importContactsChunk).not.toHaveBeenCalled();
  });

  it("the List column says where they would go, using the name the server reports", async () => {
    await openWith(csv);
    fireEvent.change(nameBox(), { target: { value: "Press" } });
    const table = await screen.findByRole("table", { name: "What the import would change" });
    await waitFor(() => expect(within(table).getAllByText("Added to Press")).toHaveLength(2));
    fireEvent.change(listSelect(), { target: { value: "l-man" } });
    await waitFor(() => expect(within(screen.getByRole("table", { name: "What the import would change" })).getAllByText("Added to VIPs")).toHaveLength(2));
    fireEvent.change(listSelect(), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText(/Added to/)).toBeNull());
  });

  it("is asked again, not left stale, when the target list changes", async () => {
    let release!: () => void;
    await openWith(csv);
    await screen.findByRole("table", { name: "What the import would change" });
    A.previewImportChunk.mockImplementationOnce((contacts: { email: string }[], target: Target) => new Promise((r) => { release = () => r(dryRun(contacts, target)); }));
    fireEvent.change(listSelect(), { target: { value: "l-imp" } });
    expect(await screen.findByText("Checking what would change…")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "What the import would change" })).toBeNull();
    await waitFor(() => expect(release).toBeTypeOf("function")); // the 350 ms debounce has passed and the dry run is in flight
    release();
    expect(await screen.findByRole("table", { name: "What the import would change" })).toBeTruthy();
  });

  it("counts new, updated and skipped rows from the server and lists the skipped reason", async () => {
    A.previewImportChunk.mockImplementation(async () => ({
      rows: [
        { index: 0, email: "ana@example.com", status: "update", changes: [{ field: "first_name", old: "Anna", new: "Ana" }] },
        { index: 1, email: "ben@example.com", status: "skipped", reason: "invalid_timezone" },
      ],
      list: null,
    }));
    await openWith(csv);
    const table = await screen.findByRole("table", { name: "What the import would change" });
    expect(within(screen.getByRole("list", { name: "Summary" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["New0", "Update1", "Unchanged0", "Skipped1"]);
    expect(table.querySelector("del")!.textContent).toBe("was Anna");
    expect(table.querySelector("ins")!.textContent).toBe("now Ana");
    expect(within(table).getByText("Row 3: Not an IANA time zone")).toBeTruthy(); // line = CSV row (header is row 1)
  });

  it("a failed dry run shows the error and the import can still be attempted", async () => {
    A.previewImportChunk.mockResolvedValue({ rows: [], list: null, error: { code: "unavailable", message: "The API is down." } });
    await openWith(csv);
    expect((await screen.findByRole("alert")).textContent).toContain("The API is down.");
    expect(screen.queryByRole("table", { name: "What the import would change" })).toBeNull();
    expect((screen.getByRole("button", { name: "Import 2 contacts" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("no dry run for a file with no usable rows", async () => {
    await openWith("name\nAna");
    await screen.findByRole("alert");
    await new Promise((r) => setTimeout(r, 450)); // longer than the 350 ms debounce
    expect(A.previewImportChunk).not.toHaveBeenCalled();
  });

  it("rows the CSV check already rejects are not sent to the server, but are listed", async () => {
    await openWith("email\nana@example.com\nnope");
    await screen.findByRole("table", { name: "What the import would change" });
    expect(A.previewImportChunk.mock.calls.flatMap((c) => c[0].map((x: { email: string }) => x.email))).toEqual(["ana@example.com"]);
    expect(screen.getByText("Rows that will be skipped")).toBeTruthy();
    expect(screen.getByText(/ready to import/).textContent).toMatch(/^1 ready to import, 1 will be skipped\./);
  });
});
