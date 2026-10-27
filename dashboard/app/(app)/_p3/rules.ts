/** Rule trees ({and|or|not|field/op/value}) rendered as plain words. Pure; used by segments and automation flow. */
const OPS: Record<string, string> = {
  eq: "is", neq: "is not", lt: "is less than", lte: "is at most", gt: "is greater than", gte: "is at least",
  in: "is one of", contains: "contains", exists: "exists",
};
const fieldName = (f: string) => f.replace(/^contact\./, "").replace(/^properties\./, "").replace(/^event\./, "event ").replace(/[._]/g, " ");
const val = (v: unknown): string => (Array.isArray(v) ? v.map(val).join(", ") : typeof v === "string" ? `“${v}”` : String(v));

export function ruleWords(r: any, top = true): string | null {
  if (!r || typeof r !== "object") return null;
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
