"use client";
import { useMemo } from "react";
import { Change, DiffTable, type DiffCell, type DiffRow, type DiffStatus } from "@/components/ui/diff-table";

/** One row of a dry run: POST /v1/contacts/import {dry_run} or POST /v1/contact-sources/{id}/sync?dry_run=true. */
export type PreviewRow = {
  /** Stable id for React and for finding the CSV line again. */
  line?: number; index?: number; email: string; external_id?: string; status: DiffStatus;
  changes?: { field: string; old: unknown; new: unknown }[]; list?: "add" | "already" | null;
  values?: { first_name?: string | null; last_name?: string | null; timezone?: string | null; properties?: Record<string, unknown> | null } | null;
  reason?: string; message?: string;
};
export type PreviewSummary = Record<DiffStatus, number>;

const COLUMNS = [
  { id: "email", header: "Contact", className: "font-mono text-xs" }, { id: "first_name", header: "First name" }, { id: "last_name", header: "Last name" },
  { id: "timezone", header: "Time zone" }, { id: "properties", header: "Attributes" }, { id: "list", header: "List" },
];
const REASON: Record<string, string> = {
  invalid_email: "Not a valid email address", invalid_timezone: "Not an IANA time zone", invalid_properties: "Attributes must be an object", malformed: "Not in the contact-source format",
  duplicate_email: "That address belongs to another contact from this source", deleted_unknown: "Deleted at the source; mailcraft never had this person", invalid_external_id: "Missing or too long id",
};

/** Whole value as text: a string stays itself, anything else is JSON. */
export const show = (v: unknown): string => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const attrs = (o?: Record<string, unknown> | null) => Object.entries(o ?? {}).map(([k, v]) => `${k}: ${show(v)}`).join(", ");

/** API rows to table rows. Changed fields become old to new cells; a new contact shows what it would be created with. */
export function diffRows(rows: PreviewRow[], listName?: string | null): DiffRow[] {
  return rows.map((r, i) => {
    const by = new Map((r.changes ?? []).map((c) => [c.field, c]));
    const cell = (f: "first_name" | "last_name" | "timezone"): DiffCell | undefined => {
      const c = by.get(f);
      return c ? { was: show(c.old), value: show(c.new) } : r.values?.[f] ? { value: r.values[f] } : undefined;
    };
    const props = (r.changes ?? []).filter((c) => c.field.startsWith("properties."));
    const email = by.get("email");
    const cells: Record<string, DiffCell> = {
      email: email ? { was: show(email.old), value: r.email } : { value: r.email },
      first_name: cell("first_name") ?? {}, last_name: cell("last_name") ?? {}, timezone: cell("timezone") ?? {},
      properties: props.length
        ? { value: <ul className="grid gap-0.5">{props.map((c, j) => <li key={c.field}><code className="text-[12.5px]">{c.field.slice(11)}</code>{" "}<Change was={show(c.old)} now={show(c.new)} delay={j * 40} /></li>)}</ul> }
        : r.values?.properties && Object.keys(r.values.properties).length ? { value: attrs(r.values.properties) } : {},
      list: r.list && listName ? { value: r.list === "add" ? `Added to ${listName}` : <span className="text-muted">Already on {listName}</span> } : {},
    };
    const suppress = (r.changes ?? []).find((c) => c.field === "suppressed");
    if (suppress) cells.properties = { value: <span className="text-bad">Suppressed: {show(suppress.new).replace(/_/g, " ")}</span> };
    const note = r.status === "skipped" ? `${r.line ? `Row ${r.line}: ` : ""}${r.message ?? REASON[r.reason ?? ""] ?? r.reason ?? "Skipped"}` : undefined;
    return { id: String(r.line ?? r.external_id ?? r.index ?? i), status: r.status, cells, note };
  });
}

/** Summary counts, filter chips and the diff table for a dry run. */
export function ContactDiff({ rows, summary, listName, sample, caption }: { rows: PreviewRow[]; summary: PreviewSummary; listName?: string | null; sample?: string; caption: string }) {
  const table = useMemo(() => diffRows(rows, listName), [rows, listName]);
  return <DiffTable caption={caption} columns={COLUMNS} rows={table} summary={summary} sample={sample} />;
}
