/** Pure helpers for the Monitor pages (Overview, Emails, Email detail, Approvals). */
import { formatNumber } from "@/lib/format";

export type Day = { date: string; sent: number; delivered: number; bounced: number; complained: number };
export const BOUNCE_LIMIT = 2; // % of sent
export const COMPLAINT_LIMIT = 0.1; // % of sent

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function toDays(series: any[] | null | undefined): Day[] {
  return (series ?? []).map((s) => ({ date: String(s.date), sent: n(s.sent), delivered: n(s.delivered), bounced: n(s.bounced), complained: n(s.complained) }));
}

export const sum = (d: Day[]) => d.reduce((a, x) => ({ sent: a.sent + x.sent, delivered: a.delivered + x.delivered, bounced: a.bounced + x.bounced, complained: a.complained + x.complained }), { sent: 0, delivered: 0, bounced: 0, complained: 0 });

/** The API returns `days*2` days; the trailing half is "now", the leading half is the comparison period. */
export function splitSeries(all: Day[], days: number) {
  const cur = all.slice(-days);
  return { cur, prev: all.slice(0, Math.max(0, all.length - cur.length)).slice(-days) };
}

export function rate(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}
export const fmtPct = (r: number | null, digits = 1) => (r === null ? "n/a" : `${r.toFixed(r !== 0 && r < 0.1 ? 2 : digits)}%`);

/** "+12%" / "-3%" vs the previous period; `goodUp` says whether an increase is good news. */
export function delta(cur: number, prev: number, goodUp: boolean): { text: string; tone: "ok" | "bad" | "neutral" } | undefined {
  if (prev === 0 && cur === 0) return undefined;
  if (prev === 0) return { text: "new", tone: "neutral" };
  const p = Math.round(((cur - prev) / prev) * 100);
  if (p === 0) return { text: "0%", tone: "neutral" };
  return { text: `${p > 0 ? "+" : ""}${p}%`, tone: (p > 0) === goodUp ? "ok" : "bad" };
}

export const RANGES = [{ key: "24h", days: 1, label: "24h" }, { key: "7d", days: 7, label: "7d" }, { key: "30d", days: 30, label: "30d" }] as const;
export const rangeFor = (k?: string) => RANGES.find((r) => r.key === k) ?? RANGES[1];

export { formatNumber };

/** SMTP enhanced status -> plain English + what to do. */
export function explainDiagnostic(code?: string | null, text?: string | null): { title: string; tip: string } {
  const c = code ?? text?.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] ?? "";
  const known: Record<string, [string, string]> = {
    "5.1.1": ["The mailbox does not exist.", "Remove this address; it has been suppressed so we will not retry."],
    "5.1.2": ["The recipient's domain does not exist.", "Check the address for typos and remove it from your list."],
    "5.2.1": ["The mailbox is disabled or not accepting mail.", "Remove the address or try again later."],
    "5.2.2": ["The recipient's mailbox is full.", "Retry later; remove the address if it keeps happening."],
    "5.7.1": ["The receiving server rejected the message as unauthorised or spam.", "Check SPF, DKIM and DMARC on your sending domain and the content of the message."],
    "5.7.26": ["The message failed authentication (DMARC).", "Verify your domain's DNS records under Domains."],
  };
  if (known[c]) return { title: known[c][0], tip: known[c][1] };
  if (c.startsWith("4.")) return { title: "The receiving server asked us to retry later.", tip: "No action needed; delivery is retried automatically." };
  if (c.startsWith("5.")) return { title: "The receiving server permanently rejected the message.", tip: "Read the server's reply below; fix the cause or remove the address." };
  return { title: "The message could not be delivered.", tip: "Read the server's reply below." };
}

/** "+1.2s" / "+3m 04s" gap between two ISO times; "" when either is invalid or the gap is negative. */
export function gap(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000), m = Math.floor(s / 60);
  if (m < 60) return `+${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `+${h}h ${String(m % 60).padStart(2, "0")}m` : `+${Math.floor(h / 24)}d`;
}

export type EmailQuery = { q?: string; status?: string; from?: string; to?: string; cursor?: string; open?: string };

/** The list is fetched by status + cursor; text and date filters narrow the fetched page. */
export function filterEmails<T extends { subject?: string; to_addr?: string; id?: string; created_at?: string }>(rows: T[], { q, from, to }: EmailQuery): T[] {
  const needle = q?.trim().toLowerCase();
  const lo = from ? Date.parse(`${from}T00:00:00Z`) : NaN;
  const hi = to ? Date.parse(`${to}T23:59:59.999Z`) : NaN;
  return rows.filter((r) => {
    if (needle && ![r.subject, r.to_addr, r.id].some((v) => v?.toLowerCase().includes(needle))) return false;
    const t = r.created_at ? Date.parse(r.created_at) : NaN;
    if (!Number.isNaN(lo) && !(t >= lo)) return false;
    if (!Number.isNaN(hi) && !(t <= hi)) return false;
    return true;
  });
}

/** Build /emails?... from a query, dropping empty keys. `patch` overrides; changing a filter resets cursor + open. */
export function emailsHref(base: EmailQuery, patch: EmailQuery = {}, resetPaging = false): string {
  const m: Record<string, string | undefined> = { ...base, ...patch };
  if (resetPaging) { delete m.cursor; delete m.open; }
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(m)) if (v) sp.set(k, v);
  const s = sp.toString();
  return `/emails${s ? `?${s}` : ""}`;
}

/** Policy decision -> badge status (pass / warn / fail); unknown decisions show as-is, neutral. */
export const policyTone = (d: string) => (/^(pass|allow|allowed|sandbox|transport)$/.test(d) ? "pass" : /^(warn|require_approval|approval|review)$/.test(d) ? "warn" : /^(block|blocked|fail|deny|reject)/.test(d) ? "fail" : d);
