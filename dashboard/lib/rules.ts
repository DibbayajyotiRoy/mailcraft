/** Rule trees ({and|or|not|field/op/value}) rendered as plain words. Pure; used by segments and automation flow. */
const OPS: Record<string, string> = {
  eq: "is", neq: "is not", lt: "is less than", lte: "is at most", gt: "is greater than", gte: "is at least",
  in: "is one of", contains: "contains", exists: "exists",
};
const fieldName = (f: string) => f.replace(/^contact\./, "").replace(/^properties\./, "").replace(/^event\./, "event ").replace(/[._]/g, " ");
const val = (v: unknown): string => (Array.isArray(v) ? v.map(val).join(", ") : typeof v === "string" ? `“${v}”` : String(v));

/** Segment fields with a nicer sentence than "field op value": event counts, recency, topics. */
function eventWords(r: any): string | null {
  const f = typeof r.field === "string" ? r.field : "";
  const [kind, ...rest] = f.split(":"), name = rest.join(":");
  if (kind === "event_count" && r.op === "eq" && r.value === 0) return `${name} never happened`;
  if (kind === "event_count" && r.op === "gte" && typeof r.value === "number") return `${name} happened at least ${r.value} ${r.value === 1 ? "time" : "times"}`;
  if (kind === "days_since" && r.op === "lte" && typeof r.value === "number") return `${name} happened in the last ${r.value} days`;
  if (kind === "topic" && r.op === "eq" && typeof r.value === "boolean") return `${r.value ? "subscribed to" : "unsubscribed from"} ${name}`;
  const [a, b] = Array.isArray(r.or) && r.or.length === 2 ? r.or : [];
  if (a?.field && a.field === b?.field && a.field.startsWith("days_since:") && a.op === "exists" && a.value === false && b.op === "gt") return `${a.field.slice(11)} has not happened in the last ${b.value} days`;
  return null;
}

export function ruleWords(r: any, top = true): string | null {
  if (!r || typeof r !== "object") return null;
  const special = eventWords(r);
  if (special) return special;
  const join = (list: any[], word: string) => {
    const parts = list.map((x) => ruleWords(x, false)).filter(Boolean) as string[];
    if (!parts.length) return null;
    const s = parts.join(` ${word} `);
    return top || parts.length < 2 ? s : `(${s})`;
  };
  if (Array.isArray(r.and)) return join(r.and, "AND");
  if (Array.isArray(r.or)) return join(r.or, "OR");
  if (r.not) { const s = ruleWords(r.not, false); return s && `NOT ${s}`; }
  if (typeof r.field === "string") {
    const op = OPS[r.op] ?? String(r.op ?? "is");
    return r.op === "exists" ? `${fieldName(r.field)} exists` : `${fieldName(r.field)} ${op} ${val(r.value)}`;
  }
  const entries = Object.entries(r);
  return entries.length ? entries.map(([k, v]) => `${fieldName(k)} is ${val(v)}`).join(" AND ") : null;
}
