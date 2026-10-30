// Client-side parsing of files dropped/pasted/attached in the assistant composer.
// CSVs are parsed to rows; HTML/MJML/text/JSON are read as text. Emails in CSV summaries are masked before being sent to the model.

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 3;
export const ALLOWED_TYPES = ["text/csv", "text/html", "text/plain", "application/json", "application/mjml"];

export type CsvAttachment = { kind: "csv"; name: string; columns: string[]; rows: Record<string, string>[]; count: number; summary: string };
export type HtmlAttachment = { kind: "html"; name: string; content: string };
export type MjmlAttachment = { kind: "mjml"; name: string; content: string };
export type TextAttachment = { kind: "text"; name: string; content: string };
export type JsonAttachment = { kind: "json"; name: string; content: unknown };
export type Attachment = CsvAttachment | HtmlAttachment | MjmlAttachment | TextAttachment | JsonAttachment;

export type ParseError = { name: string; reason: "too_large" | "type" | "parse" | "empty"; message: string };

function detectKind(file: FileLike, text: string): Attachment["kind"] {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || file.type === "text/csv") return "csv";
  if (name.endsWith(".mjml") || file.type === "application/mjml") return "mjml";
  if (name.endsWith(".html") || name.endsWith(".htm") || file.type === "text/html") return "html";
  if (name.endsWith(".json") || file.type === "application/json") return "json";
  return "text";
}

function maskEmail(email: string): string {
  const m = /^([^@]+)@([^@]+)$/.exec(email.trim());
  if (!m) return email;
  const [local, domain] = [m[1], m[2]];
  const maskedLocal = local.length <= 2 ? "*".repeat(local.length) : `${local[0]}${"*".repeat(local.length - 2)}${local.at(-1)}`;
  return `${maskedLocal}@${domain}`;
}

function parseCsv(text: string, name: string): CsvAttachment | ParseError {
  const cleaned = text.replace(/^\uFEFF/, ""); // strip UTF-8 BOM
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { name, reason: "empty", message: "The CSV file is empty." };
  // Simple RFC 4180-ish parser: respects quoted fields with commas/newlines.
  const row = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i], next = line[i + 1];
      if (inQ) {
        if (ch === '"' && next === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = row(lines[0]).map((h) => h.toLowerCase().trim());
  if (!headers.includes("email")) return { name, reason: "parse", message: "CSV must have an 'email' column." };
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = row(lines[i]);
    if (cells.length === 1 && cells[0] === "") continue;
    if (cells.length < headers.length) continue;
    rows.push(Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? ""])));
  }
  if (!rows.length) return { name, reason: "empty", message: "The CSV has no data rows." };
  const summaryRows = rows.slice(0, 5).map((r) => ({ ...r, email: maskEmail(r.email) }));
  const summary = `${rows.length} contact${rows.length === 1 ? "" : "s"}: ${summaryRows.map((r) => maskEmail(r.email)).join(", ")}${rows.length > 5 ? ` …and ${rows.length - 5} more` : ""}`;
  return { kind: "csv", name, columns: headers, rows, count: rows.length, summary };
}

function parseJson(text: string, name: string): JsonAttachment | ParseError {
  try {
    const content = JSON.parse(text);
    return { kind: "json", name, content };
  } catch {
    return { name, reason: "parse", message: "The file is not valid JSON." };
  }
}

export type FileLike = { name: string; type: string; size: number; text(): Promise<string> };

export async function parseFile(file: FileLike): Promise<Attachment | ParseError> {
  if (file.size > MAX_FILE_BYTES) return { name: file.name, reason: "too_large", message: "Files must be 5 MB or smaller." };
  const kind = detectKind(file, "");
  if (!ALLOWED_TYPES.includes(file.type) && kind === "text" && !file.name.match(/\.(csv|html?|mjml|json|txt)$/i)) {
    return { name: file.name, reason: "type", message: "Only CSV, HTML, MJML, text and JSON files are supported." };
  }
  const text = await file.text();
  if (kind === "csv") return parseCsv(text, file.name);
  if (kind === "json") return parseJson(text, file.name);
  if (kind === "html") return { kind: "html", name: file.name, content: text };
  if (kind === "mjml") return { kind: "mjml", name: file.name, content: text };
  return { kind: "text", name: file.name, content: text };
}

export function isCsv(a: Attachment): a is CsvAttachment { return a.kind === "csv"; }
export function isTextLike(a: Attachment): a is TextAttachment { return a.kind === "html" || a.kind === "mjml" || a.kind === "text"; }
