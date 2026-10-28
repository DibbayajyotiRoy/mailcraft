import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slack for a loaded CI box: waitFor/findBy default to 1 s and a test to 5 s.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30000 });

const A = vi.hoisted(() => ({
  deleteSource: vi.fn(), previewSource: vi.fn(), saveSource: vi.fn(), syncSource: vi.fn(), testSource: vi.fn(), toggleSource: vi.fn(),
}));
vi.mock("@/app/(app)/settings/actions", () => A);
const T = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: T }));

import { SourcesCard, type Source } from "@/app/(app)/settings/sources";

const fd = (fn: { mock: { calls: unknown[][] } }, call = 0, arg = 1) => fn.mock.calls[call][arg] as FormData;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const dialog = () => screen.getByRole("dialog");

const ok: Source = {
  id: "s1", name: "Acme app", url: "http://acme-api.internal:8080/internal/contacts", enabled: true, interval_minutes: 15, full_sync_hours: 24,
  last_run_at: "2026-10-20T10:00:00Z", last_status: "ok", last_counts: { created: 12, updated: 3, skipped: 1, deleted: 2 }, list: { id: "l1", name: "Acme app" },
};
const failing: Source = { ...ok, id: "s2", name: "Billing", last_status: "error", last_error: "The source answered 401: bad key", last_counts: null, list: { id: "l2", name: "Billing" } };
const fresh: Source = { id: "s3", name: "Newsletter", url: "https://example.com/contacts", enabled: true, interval_minutes: 60, full_sync_hours: 0, list: null };

beforeEach(() => {
  vi.resetAllMocks();
  A.saveSource.mockResolvedValue({}); A.testSource.mockResolvedValue({}); A.syncSource.mockResolvedValue({}); A.toggleSource.mockResolvedValue({});
});
afterEach(cleanup);

describe("sources card", () => {
  it("empty: says what to add and still offers Add source; read-only users cannot add", () => {
    const { unmount } = render(<SourcesCard sources={[]} />);
    expect(screen.getByText(/No sources yet/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Contact sources" })).toBeNull();
    expect((screen.getByRole("button", { name: "Add source" }) as HTMLButtonElement).disabled).toBe(false);
    unmount();
    render(<SourcesCard sources={[]} canEdit={false} />);
    expect((screen.getByRole("button", { name: "Add source" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a working source shows its schedule, last counts and a link to its list", () => {
    render(<SourcesCard sources={[ok]} />);
    const row = within(screen.getByRole("list", { name: "Contact sources" })).getByRole("listitem");
    expect(within(row).getByText("Last sync worked")).toBeTruthy();
    expect(within(row).getByText(ok.url)).toBeTruthy();
    expect(within(row).getByText(/Every 15 minutes, reads everything every 24 h\./)).toBeTruthy();
    expect(within(row).getByText(/12 new, 3 updated, 1 skipped, 2 suppressed \(deleted at the source\)/)).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Acme app" }).getAttribute("href")).toBe("/contacts?list=l1");
    expect(within(row).queryByRole("alert")).toBeNull();
    expect(within(row).getByText("On")).toBeTruthy();
  });

  it("a failed source shows last_error as an alert, and no counts", () => {
    render(<SourcesCard sources={[failing]} />);
    expect(screen.getByText("Last sync failed")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The source answered 401: bad key");
    expect(screen.queryByText(/suppressed \(deleted at the source\)/)).toBeNull();
  });

  it("a source that never ran says so: no last run, no counts, no list link", () => {
    render(<SourcesCard sources={[fresh]} />);
    expect(screen.getByText("Not synced yet")).toBeTruthy();
    expect(screen.queryByText(/Last run/)).toBeNull();
    expect(screen.queryByText(/new, .* updated/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/^Every 1 hour\./)).toBeTruthy(); // full_sync_hours 0 = no "reads everything" clause
  });

  it("an error with no message does not render an empty alert", () => {
    render(<SourcesCard sources={[{ ...failing, last_error: null }]} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("add / edit dialog", () => {
  it("add posts name, url, key, both intervals and the list name through saveSource, then closes", async () => {
    A.saveSource.mockResolvedValue({ ok: "Added Acme app. It syncs within a minute, or press Sync now." });
    render(<SourcesCard sources={[]} />);
    click("Add source");
    const dlg = await screen.findByRole("dialog", { name: "Add a contact source" });
    const q = within(dlg);
    expect((q.getByLabelText("Check every (minutes)") as HTMLInputElement).value).toBe("15"); // defaults
    expect((q.getByLabelText(/Read everything every \(hours\)/) as HTMLInputElement).value).toBe("24");
    expect((q.getByLabelText("API key") as HTMLInputElement).required).toBe(true);
    fireEvent.change(q.getByLabelText("Name"), { target: { value: "Acme app" } });
    fireEvent.change(q.getByLabelText("URL"), { target: { value: "http://acme-api.internal:8080/internal/contacts" } });
    fireEvent.change(q.getByLabelText("API key"), { target: { value: "sk_live_abc" } });
    fireEvent.change(q.getByLabelText("Check every (minutes)"), { target: { value: "30" } });
    fireEvent.change(q.getByLabelText(/Read everything every \(hours\)/), { target: { value: "6" } });
    fireEvent.change(q.getByLabelText("List name"), { target: { value: "Acme users" } });
    fireEvent.click(q.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(A.saveSource).toHaveBeenCalledTimes(1));
    const d = fd(A.saveSource);
    expect(["id", "name", "url", "key", "interval_minutes", "full_sync_hours", "list_name"].map((k) => d.get(k))).toEqual(
      [null, "Acme app", "http://acme-api.internal:8080/internal/contacts", "sk_live_abc", "30", "6", "Acme users"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(T.success).toHaveBeenCalledWith("Added Acme app. It syncs within a minute, or press Sync now.");
  });

  it("a rejected save stays open and shows the error as an alert", async () => {
    A.saveSource.mockResolvedValue({ error: "Name is already used (pick another)" });
    render(<SourcesCard sources={[]} />);
    click("Add source");
    const q = within(await screen.findByRole("dialog"));
    fireEvent.change(q.getByLabelText("Name"), { target: { value: "Acme app" } });
    fireEvent.change(q.getByLabelText("URL"), { target: { value: "https://example.com/c" } });
    fireEvent.change(q.getByLabelText("API key"), { target: { value: "k" } });
    fireEvent.click(q.getByRole("button", { name: "Add source" }));
    expect((await q.findByRole("alert")).textContent).toBe("Name is already used (pick another)");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(T.success).not.toHaveBeenCalled();
  });

  // BUG (sources.tsx SourceForm): the inputs are uncontrolled and React resets a <form action> once the action settles,
  // error or not, so a rejected save empties name, URL and key. Drop `.fails` when the form keeps what was typed.
  it.fails("a rejected save keeps what was typed", async () => {
    A.saveSource.mockResolvedValue({ error: "URL must be https" });
    render(<SourcesCard sources={[]} />);
    click("Add source");
    const q = within(await screen.findByRole("dialog"));
    fireEvent.change(q.getByLabelText("Name"), { target: { value: "Acme app" } });
    fireEvent.change(q.getByLabelText("URL"), { target: { value: "http://example.com/c" } });
    fireEvent.change(q.getByLabelText("API key"), { target: { value: "sk_1" } });
    fireEvent.click(q.getByRole("button", { name: "Add source" }));
    await q.findByRole("alert");
    expect(["Name", "URL", "API key"].map((l) => (q.getByLabelText(l) as HTMLInputElement).value)).toEqual(["Acme app", "http://example.com/c", "sk_1"]);
  });

  it("will not post an add without the required fields", () => {
    render(<SourcesCard sources={[]} />);
    click("Add source");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add source" }));
    expect(A.saveSource).not.toHaveBeenCalled();
  });

  it("edit is prefilled, has no list-name field, and a blank key stays blank so the stored one is kept", async () => {
    render(<SourcesCard sources={[ok]} />);
    click("Edit Acme app");
    const q = within(await screen.findByRole("dialog", { name: "Edit Acme app" }));
    expect((q.getByLabelText("Name") as HTMLInputElement).value).toBe("Acme app");
    expect((q.getByLabelText("URL") as HTMLInputElement).value).toBe(ok.url);
    const key = q.getByLabelText("API key") as HTMLInputElement;
    expect([key.value, key.required, key.placeholder]).toEqual(["", false, "••••••••••••"]);
    expect(q.getByText(/Leave blank to keep the stored key/)).toBeTruthy();
    expect(q.queryByLabelText("List name")).toBeNull();
    fireEvent.change(q.getByLabelText("Check every (minutes)"), { target: { value: "45" } });
    fireEvent.click(q.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(A.saveSource).toHaveBeenCalledTimes(1));
    const d = fd(A.saveSource);
    expect([d.get("id"), d.get("name"), d.get("interval_minutes"), d.get("full_sync_hours"), d.get("key"), d.get("list_name")]).toEqual(["s1", "Acme app", "45", "24", "", null]);
  });

  it("typing a key on edit rotates it", async () => {
    render(<SourcesCard sources={[ok]} />);
    click("Edit Acme app");
    const q = within(await screen.findByRole("dialog"));
    fireEvent.change(q.getByLabelText("API key"), { target: { value: "sk_new" } });
    fireEvent.click(q.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(A.saveSource).toHaveBeenCalledTimes(1));
    expect(fd(A.saveSource).get("key")).toBe("sk_new");
  });

  it("Test connection in the dialog tests the typed values and shows the result", async () => {
    A.testSource.mockResolvedValue({ ok: "Connected. Fields: email, first_name." });
    render(<SourcesCard sources={[]} />);
    click("Add source");
    const q = within(await screen.findByRole("dialog"));
    fireEvent.change(q.getByLabelText("Name"), { target: { value: "Acme app" } });
    fireEvent.change(q.getByLabelText("URL"), { target: { value: "https://example.com/c" } });
    fireEvent.change(q.getByLabelText("API key"), { target: { value: "sk_try" } });
    fireEvent.click(q.getByRole("button", { name: "Test connection" }));
    expect(await q.findByText("Connected. Fields: email, first_name.")).toBeTruthy();
    const d = fd(A.testSource);
    expect([d.get("url"), d.get("key")]).toEqual(["https://example.com/c", "sk_try"]);
    expect(A.saveSource).not.toHaveBeenCalled();
  });

  it("a failed test in the dialog is shown and nothing is saved", async () => {
    A.testSource.mockResolvedValue({ error: "401 from the source" });
    render(<SourcesCard sources={[]} />);
    click("Add source");
    const q = within(await screen.findByRole("dialog"));
    fireEvent.change(q.getByLabelText("Name"), { target: { value: "A" } });
    fireEvent.change(q.getByLabelText("URL"), { target: { value: "https://example.com/c" } });
    fireEvent.change(q.getByLabelText("API key"), { target: { value: "bad" } });
    fireEvent.click(q.getByRole("button", { name: "Test connection" }));
    expect(await q.findByText("401 from the source")).toBeTruthy();
    expect(A.saveSource).not.toHaveBeenCalled();
  });
});

describe("row actions", () => {
  it("Test connection on a saved source sends its id and shows the result", async () => {
    A.testSource.mockResolvedValue({ ok: "Connected, but the source returned no contacts yet." });
    render(<SourcesCard sources={[ok]} />);
    click("Test connection Acme app");
    expect(await screen.findByText("Connected, but the source returned no contacts yet.")).toBeTruthy();
    expect(fd(A.testSource).get("id")).toBe("s1");
  });

  it("Sync now shows the counts it got back, or the failure", async () => {
    A.syncSource.mockResolvedValueOnce({ ok: "Synced: 4 new, 2 updated, 0 skipped, 1 deleted." });
    render(<SourcesCard sources={[ok, failing]} />);
    click("Sync now Acme app");
    expect(await screen.findByText("Synced: 4 new, 2 updated, 0 skipped, 1 deleted.")).toBeTruthy();
    expect(fd(A.syncSource).get("id")).toBe("s1");
    A.syncSource.mockResolvedValueOnce({ error: "The source timed out" });
    click("Sync now Billing");
    expect(await screen.findByText("The source timed out")).toBeTruthy();
    expect(fd(A.syncSource, 1).get("id")).toBe("s2");
  });

  it("the enabled switch calls toggleSource with the new value and flips On to Paused", async () => {
    A.toggleSource.mockResolvedValue({ ok: "Syncing is paused." });
    render(<SourcesCard sources={[ok]} />);
    const sw = screen.getByRole("switch", { name: "Sync Acme app automatically" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(A.toggleSource).toHaveBeenCalledTimes(1));
    expect([fd(A.toggleSource).get("id"), fd(A.toggleSource).get("enabled")]).toEqual(["s1", "false"]);
    await waitFor(() => expect(T.success).toHaveBeenCalledWith("Syncing is paused."));
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("a paused source can be turned back on", async () => {
    A.toggleSource.mockResolvedValue({ ok: "Syncing is on." });
    render(<SourcesCard sources={[{ ...ok, enabled: false }]} />);
    expect(screen.getByText("Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Sync Acme app automatically" }));
    await waitFor(() => expect(fd(A.toggleSource).get("enabled")).toBe("true"));
  });

  it("when the toggle fails the switch goes back and the error is toasted", async () => {
    A.toggleSource.mockResolvedValue({ error: "Source not found" });
    render(<SourcesCard sources={[ok]} />);
    const sw = screen.getByRole("switch", { name: "Sync Acme app automatically" });
    fireEvent.click(sw);
    await waitFor(() => expect(T.error).toHaveBeenCalledWith("Source not found"));
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("On")).toBeTruthy();
  });
});

describe("delete", () => {
  it("needs the source name typed, and posts the ticked 'also delete the list' box", async () => {
    render(<SourcesCard sources={[ok]} />);
    click("Delete Acme app");
    const q = within(await screen.findByRole("dialog", { name: "Delete this contact source?" }));
    const go = q.getByRole("button", { name: "Delete source" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(q.getByText(/Its contacts stay, and so does every suppression/)).toBeTruthy();
    fireEvent.change(q.getByLabelText(/Type/), { target: { value: "acme app" } }); // wrong case
    expect(go.disabled).toBe(true);
    fireEvent.change(q.getByLabelText(/Type/), { target: { value: "Acme app" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(q.getByRole("checkbox", { name: /Also delete the list Acme app/ }));
    fireEvent.click(go);
    await waitFor(() => expect(A.deleteSource).toHaveBeenCalledTimes(1));
    const d = fd(A.deleteSource, 0, 0);
    expect([d.get("id"), d.get("name"), d.get("delete_list")]).toEqual(["s1", "Acme app", "on"]);
  });

  it("without the box ticked the list is kept (delete_list is not posted)", async () => {
    render(<SourcesCard sources={[ok]} />);
    click("Delete Acme app");
    const q = within(await screen.findByRole("dialog"));
    expect((q.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(q.getByText(/Otherwise the list stays, marked as detached/)).toBeTruthy();
    fireEvent.change(q.getByLabelText(/Type/), { target: { value: "Acme app" } });
    fireEvent.click(q.getByRole("button", { name: "Delete source" }));
    await waitFor(() => expect(A.deleteSource).toHaveBeenCalledTimes(1));
    expect(fd(A.deleteSource, 0, 0).get("delete_list")).toBeNull();
  });

  it("a source with no list has no 'also delete the list' option", async () => {
    render(<SourcesCard sources={[fresh]} />);
    click("Delete Newsletter");
    const q = within(await screen.findByRole("dialog"));
    expect(q.queryByRole("checkbox")).toBeNull();
  });

  it("cancel closes without calling the action and forgets what was typed", async () => {
    render(<SourcesCard sources={[ok]} />);
    click("Delete Acme app");
    let q = within(await screen.findByRole("dialog"));
    fireEvent.change(q.getByLabelText(/Type/), { target: { value: "Acme app" } });
    fireEvent.click(q.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(A.deleteSource).not.toHaveBeenCalled();
    click("Delete Acme app");
    q = within(await screen.findByRole("dialog"));
    expect((q.getByLabelText(/Type/) as HTMLInputElement).value).toBe("");
    expect((q.getByRole("button", { name: "Delete source" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("preview sync", () => {
  const rows = [
    { index: 0, email: "ana@example.com", external_id: "u1", status: "new", values: { first_name: "Ana" }, list: "add" },
    { index: 1, email: "ben@example.com", external_id: "u2", status: "update", changes: [{ field: "first_name", old: "Ben", new: "Benjamin" }] },
    { index: 2, email: "cy@example.com", external_id: "u3", status: "unchanged" },
    { index: 3, email: "not-an-email", external_id: "u4", status: "skipped", reason: "invalid_email" },
  ];

  it("reads the first page, then renders the diff with summary counts and the sample note", async () => {
    let resolve!: (v: unknown) => void;
    A.previewSource.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<SourcesCard sources={[ok]} />);
    click("Preview the next sync of Acme app");
    const q = within(await screen.findByRole("dialog", { name: "Next sync of Acme app" }));
    expect(q.getByText("Reading the first page from the source…")).toBeTruthy();
    expect(A.previewSource).toHaveBeenCalledWith("s1");
    resolve({ rows, summary: { new: 1, update: 1, unchanged: 1, skipped: 1 }, list: { name: "Acme app" }, hasMore: true });
    const summary = within(await q.findByRole("list", { name: "Summary" }));
    expect(summary.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["New1", "Update1", "Unchanged1", "Skipped1"]);
    expect(q.getByText("A sample: only the first page (there is more). A full read happens every 24 hours.")).toBeTruthy();
    expect(q.getByText("Added to Acme app")).toBeTruthy();
    expect(q.getByText("Not a valid email address")).toBeTruthy(); // a skipped row carries its reason, not blank cells
  });

  it("an unreachable source shows the error as an alert instead of a table", async () => {
    A.previewSource.mockResolvedValue({ error: "The source answered 500" });
    render(<SourcesCard sources={[ok]} />);
    click("Preview the next sync of Acme app");
    expect((await screen.findByRole("alert")).textContent).toBe("The source answered 500");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("with full reads off, the note says never (and no 'there is more')", async () => {
    A.previewSource.mockResolvedValue({ rows: [], summary: { new: 0, update: 0, unchanged: 0, skipped: 0 }, list: null, hasMore: false });
    render(<SourcesCard sources={[fresh]} />);
    click("Preview the next sync of Newsletter");
    expect(await screen.findByText("A sample: only the first page. A full read happens never.")).toBeTruthy();
    expect(screen.getByText("No rows in this group.")).toBeTruthy();
  });

  it("asks again each time it is opened", async () => {
    A.previewSource.mockResolvedValue({ error: "x" });
    render(<SourcesCard sources={[ok]} />);
    click("Preview the next sync of Acme app");
    await screen.findByRole("alert");
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    click("Preview the next sync of Acme app");
    await waitFor(() => expect(A.previewSource).toHaveBeenCalledTimes(2));
  });
});
