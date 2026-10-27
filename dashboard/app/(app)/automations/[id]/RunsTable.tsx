import { Play } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { CopyField } from "@/components/ui/copy";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { truncateId } from "@/lib/format";

export type Run = { id: string; status: string; contact?: string; contact_id?: string; started_at?: string; created_at?: string; finished_at?: string; current_step?: string };

export function duration(a?: string, b?: string): string {
  if (!a || !b) return "";
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}

export function RunsTable({ runs, event }: { runs: Run[]; event?: string }) {
  if (!runs.length) {
    return (
      <EmptyState icon={Play} title="No runs yet" description="A run starts when a contact triggers this automation. Send a test event to see one." className="py-10"
        action={<div className="w-full max-w-md"><CopyField value={`mailcraft events track ${event ?? "your_event"} --contact you@example.com`} label="track event command" /></div>} />
    );
  }
  return (
    <Table caption="Automation runs">
      <THead><TR><TH>Run</TH><TH>Contact</TH><TH>State</TH><TH>Current step</TH><TH>Started</TH><TH>Duration</TH></TR></THead>
      <TBody>
        {runs.map((r) => {
          const start = r.started_at ?? r.created_at;
          return (
            <TR key={r.id}>
              <TD label="Run"><code className="text-[12.5px]" title={r.id}>{truncateId(r.id)}</code></TD>
              <TD label="Contact">{r.contact ?? r.contact_id ?? ""}</TD>
              <TD label="State"><StatusBadge status={r.status ?? "unknown"} size="sm" /></TD>
              <TD label="Current step">{r.current_step ? <code className="text-[12.5px]">{r.current_step}</code> : <span className="text-subtle">-</span>}</TD>
              <TD label="Started">{start ? <RelativeTime value={start} className="text-muted" /> : ""}</TD>
              <TD label="Duration" num>{duration(start, r.finished_at) || <span className="text-subtle">-</span>}</TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
