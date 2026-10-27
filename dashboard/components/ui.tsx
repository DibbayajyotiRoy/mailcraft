import type { ReactNode } from "react";
import type { ApiError } from "@/lib/api";

const TONE: Record<string, string> = {
  verified: "ok", delivered: "ok", sent: "ok", active: "ok", published: "ok", approved: "ok", pass: "ok", completed: "ok",
  pending: "warn", pending_approval: "warn", sending: "warn", expired: "warn", queued: "warn", deferred: "warn", draft: "warn", warn: "warn", paused: "warn", not_started: "warn", running: "warn",
  failed: "bad", bounced: "bad", complained: "bad", rejected: "bad", fail: "bad", cancelled: "bad", suppressed: "bad", revoked: "bad",
};

/** Colour is never the only signal: the status text is always shown. */
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${TONE[status] ?? "neutral"}`}>{status.replace(/_/g, " ")}</span>;
}

export function ErrorBanner({ error }: { error: ApiError }) {
  return (
    <div role="alert" className="banner">
      <strong>{error.code}</strong>: {error.message}
      {error.hint && <p className="hint">Hint: {error.hint}</p>}
      {error.doc_url && <p><a href={error.doc_url}>Documentation</a></p>}
    </div>
  );
}

/** Reads the `?err=code|message|hint` that server actions redirect back with. */
export function ActionError({ err }: { err?: string }) {
  if (!err) return null;
  const [code, message, hint] = err.split("|");
  return <ErrorBanner error={{ code, message, hint: hint || undefined }} />;
}

export type DnsRecord = { record?: string; type: string; name: string; value: string; priority?: number; status: string };

export function RecordsTable({ records }: { records: DnsRecord[] }) {
  if (!records.length) return <p className="muted">No records.</p>;
  return (
    <table>
      <caption className="sr-only">DNS records</caption>
      <thead><tr><th scope="col">Purpose</th><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Value</th><th scope="col">Status</th></tr></thead>
      <tbody>
        {records.map((r, i) => (
          <tr key={i}>
            <td>{r.record ?? ""}</td><td>{r.type}</td><td><code>{r.name}</code></td>
            <td><code className="wrap">{r.priority != null ? `${r.priority} ` : ""}{r.value}</code></td>
            <td><StatusBadge status={r.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Plain-CSS bar chart with a text alternative (the table below it). */
export function Bars({ series, label }: { series: { date: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...series.map((s) => s.value));
  return (
    <figure>
      <figcaption>{label}</figcaption>
      <svg viewBox={`0 0 ${series.length * 40} 100`} role="img" aria-label={`${label}: ${series.map((s) => `${s.date} ${s.value}`).join(", ")}`} className="bars">
        {series.map((s, i) => {
          const h = (s.value / max) * 80;
          return (
            <g key={s.date}>
              <rect x={i * 40 + 6} y={90 - h} width={28} height={h} rx={2} />
              <text x={i * 40 + 20} y={98} textAnchor="middle">{s.date.slice(5)}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="stat"><dt>{label}</dt><dd>{value}</dd></div>;
}

/** Untrusted email/template HTML: sandbox="" disables scripts, forms, same-origin. */
export function Preview({ html, title }: { html: string; title: string }) {
  return <iframe className="preview" title={title} sandbox="" srcDoc={html} />;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json"><code>{JSON.stringify(value, null, 2)}</code></pre>;
}
