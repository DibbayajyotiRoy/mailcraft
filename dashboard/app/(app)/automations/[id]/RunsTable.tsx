import { Play } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { CopyField } from "@/components/ui/copy";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { truncateId } from "@/lib/format";
import { RunPeek } from "./TestRun";

/** The API's run row (`state`, `ended_at`, `contact_email`); `status` / `finished_at` / `contact` are the older names. */
export type Run = { id: string; state?: string; status?: string; contact_email?: string; contact?: string; contact_id?: string; started_at?: string; created_at?: string; ended_at?: string; finished_at?: string; current_step?: string | null; test?: boolean; exit_reason?: string | null };

export function duration(a?: string, b?: string): string {
  if (!a || !b) return "";
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}

export function RunsTable({ runs, event, id, types = {} }: { runs: Run[]; event?: string; id?: string; types?: Record<string, string> }) {
  if (!runs.length) {
    return (
      <EmptyState icon={Play} title="No runs yet" description="A run starts when a contact triggers this automation. Use Test run, or send the trigger event." className="py-10"
        action={<div className="w-full max-w-md"><CopyField value={`mailcraft events track ${event ?? "your_event"} --contact you@example.com`} label="track event command" /></div>} />
    );
  }
  return (
    <Table caption="Automation runs">
      <THead><TR><TH>Run</TH><TH>Contact</TH><TH>State</TH><TH>Current step</TH><TH>Started</TH><TH>Duration</TH>{id && <TH><span className="sr-only">Log</span></TH>}</TR></THead>
      <TBody>
        {runs.map((r) => {
          const start = r.started_at ?? r.created_at, who = r.contact_email ?? r.contact ?? r.contact_id ?? "";
          return (
            <TR key={r.id}>
              <TD label="Run"><code className="text-[12.5px]" title={r.id}>{truncateId(r.id)}</code></TD>
              <TD label="Contact">{who}{r.test && <Badge tone="info" size="sm" className="ml-2">test</Badge>}</TD>
              <TD label="State"><StatusBadge status={r.state ?? r.status ?? "unknown"} size="sm" />{r.exit_reason && <span className="ml-2 text-xs text-muted">{r.exit_reason.replace(/_/g, " ")}</span>}</TD>
              <TD label="Current step">{r.current_step ? <code className="text-[12.5px]">{r.current_step}</code> : <span className="text-subtle">-</span>}</TD>
              <TD label="Started">{start ? <RelativeTime value={start} className="text-muted" /> : ""}</TD>
              <TD label="Duration" num>{duration(start, r.ended_at ?? r.finished_at) || <span className="text-subtle">-</span>}</TD>
              {id && <TD label="Log" className="md:text-right"><RunPeek id={id} run={r.id} label={who || r.id} types={types} /></TD>}
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
