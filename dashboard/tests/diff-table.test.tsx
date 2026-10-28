import { cleanup, configure, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Slack for a loaded CI box: waitFor/findBy default to 1 s and a test to 5 s.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30000 });

import { ContactDiff, diffRows, show, type PreviewRow } from "@/app/(app)/contacts/ContactDiff";
import { Change, DiffTable, type DiffColumn, type DiffRow } from "@/components/ui/diff-table";

afterEach(cleanup);

const rows: PreviewRow[] = [
  { line: 2, email: "ana@example.com", status: "new", values: { first_name: "Ana", last_name: "Silva", timezone: "Europe/Berlin", properties: { plan: "pro", seats: 4 } }, list: "add" },
  { line: 3, email: "ben@example.com", status: "update", list: "already", changes: [
    { field: "first_name", old: "Ben", new: "Benjamin" }, { field: "last_name", old: null, new: "Okoye" }, { field: "properties.plan", old: "free", new: "pro" },
  ] },
  { line: 4, email: "cy@example.com", status: "unchanged", list: "already" },
  { line: 5, email: "nope", status: "skipped", reason: "invalid_email" },
];
const summary = { new: 1, update: 1, unchanged: 1, skipped: 1 };
const table = () => screen.getByRole("table", { name: "Preview" });
/** Body rows only (the header row is dropped). */
const bodyRows = () => within(table()).getAllByRole("row").slice(1);
const chip = (name: string) => screen.getByRole("radio", { name });

describe("ContactDiff summary and chips", () => {
  it("shows the four counts, and a chip per group with its count", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} listName="Imports" />);
    expect(within(screen.getByRole("list", { name: "Summary" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["New1", "Update1", "Unchanged1", "Skipped1"]);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["All 4", "New 1", "Updates 1", "Unchanged 1", "Skipped 1"]);
    expect(chip("All 4").getAttribute("aria-checked")).toBe("true");
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByRole("status").textContent).toBe("Showing 4 of 4 rows");
  });

  it("the counts come from the summary, not the rows (a preview keeps only the first rows of a bigger file)", () => {
    render(<ContactDiff caption="Preview" rows={rows.slice(0, 1)} summary={{ new: 1500, update: 20, unchanged: 3, skipped: 7 }} sample="Showing the first 1,000 rows. The counts cover all 1,530." />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)[0]).toBe("All 1530");
    expect(within(screen.getByRole("list", { name: "Summary" })).getAllByRole("listitem")[0].textContent).toBe("New1500");
    expect(screen.getByText("Showing the first 1,000 rows. The counts cover all 1,530.")).toBeTruthy();
  });

  it("each chip narrows the table to that group", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} listName="Imports" />);
    for (const [name, label, email] of [["New 1", "New", "ana@example.com"], ["Updates 1", "Update", "ben@example.com"], ["Unchanged 1", "Unchanged", "cy@example.com"], ["Skipped 1", "Skipped", "nope"]]) {
      fireEvent.click(chip(name));
      expect(chip(name).getAttribute("aria-checked")).toBe("true");
      expect(bodyRows()).toHaveLength(1);
      expect(within(bodyRows()[0]).getByText(label, { selector: "span" })).toBeTruthy();
      expect(bodyRows()[0].textContent).toContain(email);
      expect(screen.getByRole("status").textContent).toBe("Showing 1 of 1 row");
    }
    fireEvent.click(chip("All 4"));
    expect(bodyRows()).toHaveLength(4);
  });

  it("a group with no rows says so instead of an empty table", () => {
    render(<ContactDiff caption="Preview" rows={rows.filter((r) => r.status !== "skipped")} summary={{ ...summary, skipped: 0 }} />);
    fireEvent.click(chip("Skipped 0"));
    expect(screen.getByText("No rows in this group.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Showing 0 of 0 rows");
  });

  it("clicking the chosen chip again does not clear the filter", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} />);
    fireEvent.click(chip("Updates 1"));
    fireEvent.click(chip("Updates 1"));
    expect(bodyRows()).toHaveLength(1);
  });
});

describe("old and new values", () => {
  it("the old value is <del>, the new one is <ins>, each with a screen-reader word", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} />);
    fireEvent.click(chip("Updates 1"));
    const row = bodyRows()[0];
    const del = row.querySelector("del")!, ins = row.querySelector("ins")!;
    expect([del.textContent, ins.textContent]).toEqual(["was Ben", "now Benjamin"]);
    expect(del.querySelector(".sr-only")!.textContent).toBe("was ");
    expect(ins.querySelector(".sr-only")!.textContent).toBe("now ");
    expect(del.className).not.toMatch(/animate/); // only the new value animates
  });

  it("a field that was empty reads 'was empty' and has no <del>", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} />);
    fireEvent.click(chip("Updates 1"));
    const cells = within(bodyRows()[0]).getAllByRole("cell");
    const lastName = cells[3]; // Status, Contact, First name, Last name
    expect(lastName.querySelector("del")).toBeNull();
    expect(lastName.textContent).toBe("was empty now Okoye");
  });

  it("changed attributes list the key with its old and new value", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} />);
    fireEvent.click(chip("Updates 1"));
    const attr = within(bodyRows()[0]).getByText("plan").closest("li")!;
    expect(attr.querySelector("del")!.textContent).toBe("was free");
    expect(attr.querySelector("ins")!.textContent).toBe("now pro");
  });

  it("an unchanged cell is a dash and an unchanged row has no <ins> or <del>", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} />);
    fireEvent.click(chip("Unchanged 1"));
    const row = bodyRows()[0];
    expect(row.querySelector("ins, del")).toBeNull();
    expect(within(row).getAllByText("-").length).toBeGreaterThanOrEqual(4);
  });

  it("a new row shows what it would be created with, highlighted, and the list it joins", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} listName="Imports" />);
    fireEvent.click(chip("New 1"));
    const row = bodyRows()[0];
    expect(row.textContent).toContain("Ana");
    expect(row.textContent).toContain("Silva");
    expect(row.textContent).toContain("Europe/Berlin");
    expect(row.textContent).toContain("plan: pro, seats: 4");
    expect(row.textContent).toContain("Added to Imports");
    expect(within(row).getByText("Ana").className).toMatch(/bg-ok-bg/);
    expect(row.querySelector("del")).toBeNull();
  });

  it("people already on the list say so, and with no list nothing is said", () => {
    const { rerender } = render(<ContactDiff caption="Preview" rows={rows} summary={summary} listName="Imports" />);
    fireEvent.click(chip("Unchanged 1"));
    expect(bodyRows()[0].textContent).toContain("Already on Imports");
    rerender(<ContactDiff caption="Preview" rows={rows} summary={summary} listName={null} />);
    expect(bodyRows()[0].textContent).not.toMatch(/Already on|Added to/);
  });

  it("a changed email shows the old address struck through", () => {
    const r: PreviewRow[] = [{ line: 2, email: "new@example.com", status: "update", changes: [{ field: "email", old: "old@example.com", new: "new@example.com" }] }];
    render(<ContactDiff caption="Preview" rows={r} summary={{ new: 0, update: 1, unchanged: 0, skipped: 0 }} />);
    expect(bodyRows()[0].querySelector("del")!.textContent).toBe("was old@example.com");
    expect(bodyRows()[0].querySelector("ins")!.textContent).toBe("now new@example.com");
  });

  it("a suppression is shown in words in the attributes cell", () => {
    const r: PreviewRow[] = [{ index: 0, email: "gone@example.com", external_id: "u9", status: "update", changes: [{ field: "suppressed", old: null, new: "deleted_at_source" }] }];
    render(<ContactDiff caption="Preview" rows={r} summary={{ new: 0, update: 1, unchanged: 0, skipped: 0 }} />);
    expect(bodyRows()[0].textContent).toContain("Suppressed: deleted at source");
  });

  it("Change on its own: old and new, with a missing new value shown as a dash", () => {
    const { container } = render(<Change was="a" now="" />);
    expect(container.querySelector("del")!.textContent).toBe("was a");
    expect(container.querySelector("ins")!.textContent).toBe("now -");
  });
});

describe("skipped rows", () => {
  it("show the address and why, across the other columns, in the error colour", () => {
    render(<ContactDiff caption="Preview" rows={rows} summary={summary} />);
    fireEvent.click(chip("Skipped 1"));
    const cells = within(bodyRows()[0]).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["Skipped", "nope", "Row 5: Not a valid email address"]);
    expect(cells[2].getAttribute("colspan")).toBe("5"); // 6 columns minus the contact column
    expect(cells[2].className).toMatch(/text-bad/);
  });
});

describe("diffRows", () => {
  const one = (r: PreviewRow) => diffRows([r])[0];
  it("explains each skip reason in words, with the CSV line when there is one", () => {
    const n = (reason?: string, extra: Partial<PreviewRow> = {}) => one({ email: "x", status: "skipped", reason, ...extra }).note;
    expect(n("invalid_email", { line: 7 })).toBe("Row 7: Not a valid email address");
    expect(n("invalid_timezone")).toBe("Not an IANA time zone");
    expect(n("invalid_properties")).toBe("Attributes must be an object");
    expect(n("malformed")).toBe("Not in the contact-source format");
    expect(n("duplicate_email")).toBe("That address belongs to another contact from this source");
    expect(n("deleted_unknown")).toBe("Deleted at the source; mailcraft never had this person");
    expect(n("invalid_external_id")).toBe("Missing or too long id");
    expect(n("something_new")).toBe("something_new"); // unknown reasons are shown as they come
    expect(n(undefined)).toBe("Skipped");
    expect(n("invalid_email", { message: "Row is blank" })).toBe("Row is blank"); // a server message wins
  });
  it("only skipped rows get a note", () => {
    expect(one({ email: "a@x.co", status: "new", reason: "invalid_email" }).note).toBeUndefined();
  });
  it("ids are stable and distinct: line, then external id, then index, then position", () => {
    const ids = diffRows([{ line: 9, email: "a", status: "new" }, { external_id: "u1", email: "b", status: "new" }, { index: 4, email: "c", status: "new" }, { email: "d", status: "new" }]).map((r) => r.id);
    expect(ids).toEqual(["9", "u1", "4", "3"]);
  });
  it("show() keeps strings, blanks null and writes everything else as JSON", () => {
    expect([show("a"), show(null), show(undefined), show(3), show({ a: 1 }), show(false)]).toEqual(["a", "", "", "3", '{"a":1}', "false"]);
  });
});

describe("Show more paging", () => {
  const cols: DiffColumn[] = [{ id: "a", header: "A" }];
  const many = (n: number, status: DiffRow["status"] = "new"): DiffRow[] => Array.from({ length: n }, (_, i) => ({ id: `${status}${i}`, status, cells: { a: { value: `${status}-${i}` } } }));
  const more = (re: RegExp) => screen.queryByRole("button", { name: re });

  it("pages through the rows by the page size, and the button says how many are next", () => {
    render(<DiffTable caption="T" columns={cols} rows={many(5)} summary={{ new: 5, update: 0, unchanged: 0, skipped: 0 }} pageSize={2} />);
    const rowsNow = () => within(screen.getByRole("table")).getAllByRole("row").length - 1;
    expect(rowsNow()).toBe(2);
    expect(screen.getByRole("status").textContent).toBe("Showing 2 of 5 rows");
    fireEvent.click(more(/Show 2 more/)!);
    expect(rowsNow()).toBe(4);
    expect(screen.getByRole("status").textContent).toBe("Showing 4 of 5 rows");
    fireEvent.click(more(/Show 1 more/)!);
    expect(rowsNow()).toBe(5);
    expect(more(/Show .* more/)).toBeNull();
  });

  it("no button when everything fits on the first page", () => {
    render(<DiffTable caption="T" columns={cols} rows={many(2)} summary={{ new: 2, update: 0, unchanged: 0, skipped: 0 }} pageSize={2} />);
    expect(more(/more/)).toBeNull();
  });

  it("ContactDiff pages by 50", () => {
    const big: PreviewRow[] = Array.from({ length: 120 }, (_, i) => ({ line: i + 2, email: `u${i}@example.com`, status: "new" }));
    render(<ContactDiff caption="Preview" rows={big} summary={{ new: 120, update: 0, unchanged: 0, skipped: 0 }} />);
    expect(bodyRows()).toHaveLength(50);
    fireEvent.click(more(/Show 50 more/)!);
    expect(bodyRows()).toHaveLength(100);
    fireEvent.click(more(/Show 20 more/)!);
    expect(bodyRows()).toHaveLength(120);
    expect(more(/more/)).toBeNull();
  });

  it("paging counts only the filtered group, and changing the filter starts over at one page", () => {
    const mixed = [...many(5, "new"), ...many(3, "update")];
    render(<DiffTable caption="T" columns={cols} rows={mixed} summary={{ new: 5, update: 3, unchanged: 0, skipped: 0 }} pageSize={2} />);
    fireEvent.click(more(/Show 2 more/)!);
    fireEvent.click(more(/Show 2 more/)!);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(7); // header + 6 shown of 8
    fireEvent.click(chip("Updates 3"));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3); // header + one page of 2
    expect(more(/Show 1 more/)).toBeTruthy();
    fireEvent.click(chip("All 8"));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
  });
});
