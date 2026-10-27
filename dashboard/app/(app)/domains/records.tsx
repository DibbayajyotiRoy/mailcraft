import { StatusBadge } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy";
import { MonoCopy } from "@/components/setup/mono-copy";
import { cn } from "@/lib/cn";

export type DnsRec = { record?: string; type: string; name: string; value: string; priority?: number; status: string; found?: string; expected?: string };

const PURPOSE: Record<string, string> = {
  SPF: "Says which servers may send for this domain.",
  DKIM: "Lets receivers check that mail was signed by you.",
  "Return-path": "Where bounces come back; keeps your reputation accurate.",
  DMARC: "Tells receivers what to do with mail that fails SPF or DKIM. Recommended, not required.",
};

/** One DNS record as a stacked block (not a wide table): chips, name + value with copy, diagnostic when failed. */
export function DnsRecordRow({ r }: { r: DnsRec }) {
  const value = r.priority != null ? `${r.priority} ${r.value}` : r.value;
  const optional = r.record === "DMARC";
  return (
    <li className={cn("rounded-md border bg-bg p-3", optional ? "border-dashed border-border-strong" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="font-mono">{r.type}</Badge>
        {r.record && <span className="text-sm font-medium">{r.record}</span>}
        {optional && <span className="text-xs text-muted">optional</span>}
        <span className="ml-auto"><StatusBadge status={r.status} /></span>
      </div>
      {r.record && PURPOSE[r.record] && <p className="mt-1 text-xs text-muted">{PURPOSE[r.record]}</p>}
      <dl className="mt-3 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div><dt className="mb-1 text-xs font-medium text-muted">Name / Host</dt><dd><MonoCopy value={r.name} label={`${r.record ?? r.type} name`} /></dd></div>
        <div><dt className="mb-1 text-xs font-medium text-muted">{r.type === "MX" ? "Points to (priority first)" : "Value"}</dt><dd><MonoCopy value={value} label={`${r.record ?? r.type} value`} /></dd></div>
      </dl>
      {r.status === "failed" && (
        <p className="mt-2 text-sm text-bad">
          {r.found ? <>Found <code className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{r.found}</code>, expected the value above.</> : "We could not see this record. Check for typos, and that the host name is not doubled (example.com.example.com)."}
        </p>
      )}
      <div className="mt-2 flex items-center gap-1 text-xs text-muted"><CopyButton value={`${r.type}\t${r.name}\t${value}`} label={`Copy all of ${r.record ?? r.type} record`} />Copy whole record</div>
    </li>
  );
}
