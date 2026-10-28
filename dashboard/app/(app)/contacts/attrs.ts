// Pure helpers shared by the contact form (client), its server action and the CSV importer.

export type AttrType = "text" | "number" | "boolean" | "json";
export type AttrRow = { key: string; type: AttrType; value: string };

export const ATTR_TYPES: { value: AttrType; label: string }[] = [
  { value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "boolean", label: "Yes / no" }, { value: "json", label: "JSON" },
];

/** Columns the contact already has: a property of the same name would shadow or confuse them. */
export const RESERVED = ["email", "first_name", "last_name", "timezone"];
/** Dots are path separators in segment rules (`properties.a.b`), so a name with one could never be matched. */
export const KEY_RE = /^[\w-]+$/;
/** Mirrors the server's normalize_email: something@domain.tld, no whitespace. */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const typeOf = (v: unknown): AttrType => (typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : typeof v === "string" ? "text" : "json");

export function rowsFromProps(props: Record<string, unknown> | undefined): AttrRow[] {
  return Object.entries(props ?? {}).map(([key, v]) => ({ key, type: typeOf(v), value: typeof v === "string" ? v : JSON.stringify(v) }));
}

/** A browser knows the IANA zones; the server re-checks with the same list. */
export function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

/** "GMT+5:30" for a zone, "" when the runtime can't say. */
export function tzOffset(tz: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
}

const COMMON_TZ = ["UTC", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Singapore", "Australia/Sydney"];

/** Options for the time zone <select>: a Suggested group (current value, the browser's zone, a few common ones),
 *  then every IANA zone grouped by region. Each entry is [zone, label]. */
export function tzGroups(zones: string[], first: (string | null | undefined)[]): [string, [string, string][]][] {
  const label = (z: string) => { const o = tzOffset(z); return [z, `${z.replace(/_/g, " ")}${o ? ` (${o})` : ""}`] as [string, string]; };
  const suggested = [...new Set([...first, ...COMMON_TZ].filter((z): z is string => !!z && isTimeZone(z)))];
  const regions = new Map<string, string[]>();
  for (const z of zones.length ? zones : COMMON_TZ) {
    const r = z.includes("/") ? z.slice(0, z.indexOf("/")) : "Other";
    regions.set(r, [...(regions.get(r) ?? []), z]);
  }
  return [["Suggested", suggested.map(label)], ...[...regions].sort(([a], [b]) => a.localeCompare(b)).map(([r, zs]) => [r, zs.map(label)] as [string, [string, string][]])];
}

export function coerce(value: string, type: AttrType): { value: unknown } | { error: string } {
  if (type === "text") return { value };
  if (type === "boolean") return value === "true" || value === "false" ? { value: value === "true" } : { error: "Choose yes or no." };
  if (type === "number") {
    const n = Number(value);
    return value.trim() !== "" && Number.isFinite(n) ? { value: n } : { error: "Enter a number." };
  }
  try { return { value: JSON.parse(value) }; } catch { return { error: "Not valid JSON." }; }
}

/**
 * Rows -> the `properties` object for PATCH. Keys that were in `initial` and are gone from the rows
 * are sent as null (the API deletes those). Errors are per row index.
 */
export function buildProps(rows: AttrRow[], initial: string[] = []): { props: Record<string, unknown>; errors: Record<number, string> } {
  const props: Record<string, unknown> = {}, errors: Record<number, string> = {}, seen = new Set<string>();
  rows.forEach((r, i) => {
    const key = r.key.trim();
    if (!key && !r.value.trim()) return; // an untouched blank row is not an error
    if (!key) errors[i] = "Give the attribute a name.";
    else if (!KEY_RE.test(key)) errors[i] = "Use letters, numbers, _ and - only.";
    else if (RESERVED.includes(key)) errors[i] = `${key} has its own field above.`;
    else if (seen.has(key)) errors[i] = "Another row already uses this name.";
    else {
      const c = coerce(r.value, r.type);
      if ("error" in c) errors[i] = c.error; else props[key] = c.value;
      seen.add(key);
    }
  });
  for (const k of initial) if (!(k in props) && !rows.some((r) => r.key.trim() === k)) props[k] = null;
  return { props, errors };
}

/** CSV cells are text; keep numbers and true/false typed so segment rules like `seats >= 5` work. Blank -> undefined. */
export function infer(cell: string): unknown {
  const s = cell.trim();
  if (!s) return undefined;
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
  if (/^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/.test(s)) return Number(s);
  return s;
}
