import type { ReactNode } from "react";
import type { ApiError } from "@/lib/api";
import { StatusBadge } from "./ui/badge";
import { Table, TBody, TD, THead, TH, TR } from "./ui/table";
import { CopyButton } from "./ui/copy";

export { StatusBadge };

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

/** Compatibility shim (P2 replaces it with DnsRecordRow usage). */
export function RecordsTable({ records }: { records: DnsRecord[] }) {
  if (!records.length) return <p className="muted">No records.</p>;
  return (
    <Table caption="DNS records">
      <THead><TR><TH>Purpose</TH><TH>Type</TH><TH>Name</TH><TH>Value</TH><TH>Status</TH></TR></THead>
      <TBody>
        {records.map((r, i) => {
          const v = `${r.priority != null ? `${r.priority} ` : ""}${r.value}`;
          return (
            <TR key={i}>
              <TD label="Purpose">{r.record ?? ""}</TD><TD label="Type">{r.type}</TD>
              <TD label="Name"><code className="text-[12.5px]">{r.name}</code></TD>
              <TD label="Value" className="max-w-[28rem]"><span className="inline-flex items-center gap-1"><code className="break-all text-[12.5px]">{v}</code><CopyButton value={r.value} label={`Copy ${r.type} value`} /></span></TD>
              <TD label="Status"><StatusBadge status={r.status} /></TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
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
