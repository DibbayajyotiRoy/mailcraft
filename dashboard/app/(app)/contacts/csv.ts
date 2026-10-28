// Minimal CSV for contact import: BOM, CRLF/CR/LF, quoted fields ("" escapes a quote, newlines allowed inside quotes).
// Own file on purpose: the broadcasts page has its own recipient parser; unify when both are on main.
import { EMAIL_RE, infer, isTimeZone } from "./attrs";

export const MAX_ROWS = 5000;

export const CSV_EXAMPLE = `email,first_name,last_name,timezone,plan,seats
ana@example.com,Ana,Silva,America/Sao_Paulo,pro,5
ben@example.com,Ben,,Europe/Berlin,free,1
`;

/** Delimiter is whichever of , ; tab the header line uses most (Excel in many locales writes ;). */
function delimiter(text: string): string {
  const head = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  const n = (d: string) => head.split(d).length;
  return [";", "\t"].reduce((best, d) => (n(d) > n(best) ? d : best), ",");
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const d = delimiter(text);
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  const endRow = () => { row.push(cell); cell = ""; if (row.length > 1 || row[0].trim() !== "") rows.push(row); row = []; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === d) { row.push(cell); cell = ""; }
    else if (c === "\r" || c === "\n") { if (c === "\r" && text[i + 1] === "\n") i++; endRow(); }
    else cell += c;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}

export type ImportRow = { email: string; first_name?: string; last_name?: string; timezone?: string; properties?: Record<string, unknown> };
export type ParsedCsv = {
  columns: string[]; // normalised header names that were understood (fixed columns + attributes)
  rows: { line: number; contact: ImportRow }[]; // line = 1-based row number, the header being row 1
  invalid: { line: number; email?: string; message: string }[];
  error?: string; // file-level problem: nothing can be imported
};

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
const ALIAS: Record<string, string> = {
  "e-mail": "email", e_mail: "email", email_address: "email", emailaddress: "email",
  firstname: "first_name", first: "first_name", given_name: "first_name",
  lastname: "last_name", last: "last_name", surname: "last_name", family_name: "last_name",
  time_zone: "timezone", tz: "timezone",
};

export function readContacts(text: string, max = MAX_ROWS): ParsedCsv {
  const out: ParsedCsv = { columns: [], rows: [], invalid: [] };
  const table = parseCsv(text);
  if (!table.length) return { ...out, error: "The file is empty. The first row must be a header with an email column." };
  const header = table[0].map((h) => { const n = norm(h); return ALIAS[n] ?? n; });
  const at = header.indexOf("email");
  if (at < 0) return { ...out, error: "No email column found. Name a header column email." };
  const dup = header.find((h, i) => h && header.indexOf(h) !== i);
  if (dup) return { ...out, error: `Two columns are called ${dup}. Rename or remove one.` };
  if (table.length - 1 > max) return { ...out, error: `${table.length - 1} rows is over the limit of ${max}. Split the file.` };
  out.columns = header.filter(Boolean);
  const firstSeen = new Map<string, number>();
  table.slice(1).forEach((cells, k) => {
    const line = k + 2, cell = (n: number) => (cells[n] ?? "").trim();
    const email = cell(at);
    const bail = (message: string) => out.invalid.push({ line, email: email || undefined, message });
    if (!email) return bail("No email.");
    if (!EMAIL_RE.test(email)) return bail("Not a valid email address.");
    const key = email.toLowerCase();
    if (firstSeen.has(key)) return bail(`Same address as row ${firstSeen.get(key)}.`);
    const c: ImportRow = { email };
    const properties: Record<string, unknown> = {};
    for (let n = 0; n < header.length; n++) {
      const h = header[n];
      if (!h || n === at || !cell(n)) continue;
      if (h === "first_name" || h === "last_name") c[h] = cell(n);
      else if (h === "timezone") c.timezone = cell(n);
      else properties[h] = infer(cell(n));
    }
    if (c.timezone && !isTimeZone(c.timezone)) return bail(`${c.timezone} is not a time zone name like Europe/Berlin.`);
    if (Object.keys(properties).length) c.properties = properties;
    firstSeen.set(key, line);
    out.rows.push({ line, contact: c });
  });
  return out;
}
