// Recipients for a broadcast: a small RFC 4180 CSV parser plus the validation shared by the CSV upload and the typed table.
// Pure (no React, no server imports) so it is unit-tested directly.

export type Recipient = { email: string; first_name?: string; last_name?: string; data?: Record<string, string> };
export type Issue = { row: number; email: string; reason: string };
export type Parsed = {
  recipients: Recipient[]; columns: string[]; issues: Issue[]; duplicates: number;
  /** Data rows read (blank lines excluded). */
  rows: number; error?: string;
};

export const MAX_ROWS = 5000;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** RFC 4180: quoted fields, "" escapes a quote, commas and line breaks inside quotes, CRLF / LF / CR row ends, UTF-8 BOM. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, started = false;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); if (row.length > 1 || row[0] !== "") rows.push(row); row = []; started = false; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (src[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && field === "") { quoted = true; started = true; }
    else if (ch === ",") { endField(); started = true; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; endRow(); }
    else { field += ch; started = true; }
  }
  if (started || field !== "" || row.length) endRow();
  return rows;
}

/** "First Name" -> first_name; a leading digit gets "_" so `{{ data.<column> }}` is a valid name. */
export const headerKey = (h: string) => {
  const k = h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(k) ? `_${k}` : k;
};
const FIXED: Record<string, "email" | "first_name" | "last_name"> = { email: "email", e_mail: "email", email_address: "email", first_name: "first_name", firstname: "first_name", last_name: "last_name", lastname: "last_name" };

/** Validates addresses, drops duplicates (case-insensitive) and keeps the first of each. `row` numbers start at 2 (row 1 is the header) for CSV; the typed table passes its own offset. */
export function check(list: { row: number; r: Recipient }[]): Pick<Parsed, "recipients" | "issues" | "duplicates"> {
  const seen = new Set<string>(), recipients: Recipient[] = [], issues: Issue[] = [];
  let duplicates = 0;
  for (const { row, r } of list) {
    const email = r.email.trim();
    if (!email) { issues.push({ row, email: "", reason: "No email address" }); continue; }
    if (email.length > 254 || !EMAIL.test(email)) { issues.push({ row, email, reason: "Not a valid email address" }); continue; }
    if (seen.has(email.toLowerCase())) { duplicates++; continue; }
    seen.add(email.toLowerCase());
    recipients.push({ ...r, email });
  }
  return { recipients, issues, duplicates };
}

export function recipientsFromCsv(text: string): Parsed {
  const table = parseCsv(text);
  const none = { recipients: [], columns: [], issues: [], duplicates: 0, rows: 0 };
  if (!table.length) return { ...none, error: "The file is empty. Add a header row (email,first_name,last_name) and one recipient per line." };
  const keys = table[0].map(headerKey);
  const fixed = keys.map((k) => FIXED[k]);
  if (!fixed.includes("email")) return { ...none, error: `There is no “email” column. The header row has: ${table[0].map((h) => h.trim()).filter(Boolean).join(", ") || "nothing"}.` };
  const dup = keys.find((k, i) => k && keys.indexOf(k) !== i);
  if (dup) return { ...none, error: `Two columns are both called “${dup}”. Rename one.` };
  if (table.length - 1 > MAX_ROWS) return { ...none, rows: table.length - 1, error: `${table.length - 1} rows is over the limit of ${MAX_ROWS} per broadcast. Split the file.` };
  const columns = keys.filter((k, i) => k && !fixed[i]);
  const list = table.slice(1).map((cells, n) => {
    const r: Recipient = { email: "" };
    const data: Record<string, string> = {};
    keys.forEach((k, i) => {
      const v = (cells[i] ?? "").trim();
      if (!k) return;
      if (fixed[i]) { if (v || fixed[i] === "email") r[fixed[i]] = v; } else if (v) data[k] = v;
    });
    if (Object.keys(data).length) r.data = data;
    return { row: n + 2, r };
  });
  return { ...check(list), columns, rows: list.length };
}

export const GRID_FIXED = ["email", "first_name", "last_name"] as const;

/** The typed table: rows keyed by column (email, first_name, last_name + custom `fields`). Fully blank rows are ignored; row numbers are 1-based. */
export function recipientsFromGrid(rows: Record<string, string>[], fields: string[]): Parsed {
  const list = rows.map((cells, i) => ({ cells, row: i + 1 })).filter(({ cells }) => Object.values(cells).some((v) => v?.trim()))
    .map(({ cells, row }) => {
      const r: Recipient = { email: cells.email ?? "" };
      for (const k of ["first_name", "last_name"] as const) if (cells[k]?.trim()) r[k] = cells[k].trim();
      const data = Object.fromEntries(fields.filter((f) => cells[f]?.trim()).map((f) => [f, cells[f].trim()]));
      if (Object.keys(data).length) r.data = data;
      return { row, r };
    });
  return { ...check(list), columns: fields, rows: list.length };
}

/** The variables a recipient gets in a template: blank values are left out, so `| default("x")` applies (mirrors the API). */
export function varsOf(r: Recipient) {
  const v: Record<string, unknown> = { email: r.email };
  if (r.first_name?.trim()) v.first_name = r.first_name.trim();
  if (r.last_name?.trim()) v.last_name = r.last_name.trim();
  v.data = Object.fromEntries(Object.entries(r.data ?? {}).filter(([, x]) => x?.trim()));
  return v;
}

export const EXAMPLE_CSV = "email,first_name,last_name,company\nada@example.com,Ada,Lovelace,Analytical Engines\ngrace@example.com,Grace,Hopper,Navy\n";
