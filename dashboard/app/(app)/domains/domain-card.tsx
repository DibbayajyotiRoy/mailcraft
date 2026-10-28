import { Clock } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import { DnsRecordRow, type DnsRec } from "@/components/ui/dns-record";
import { Meter } from "@/components/ui/meter";
import { DomainMenu } from "./domain-menu";
import { VerifyForm } from "./verify-form";

export type Domain = { id: string; name: string; status: string; stream?: string; records?: DnsRec[]; last_checked_at?: string | null; relay_sender?: string };

const BANNER: Record<string, string> = {
  not_started: "Add these records at your DNS provider, then verify.",
  pending: "Checking. This usually takes under 15 minutes and can take up to 72 hours.",
  verified: "All set. This domain can send.",
  failed: "We could not see your records after repeated checks. Compare them with the values below, check for proxying, then verify again.",
};

export function DomainCard({ d }: { d: Domain }) {
  const recs = d.records ?? [];
  const done = recs.filter((r) => r.status === "verified").length;
  const viaRelay = !!d.relay_sender && d.status !== "verified";
  const verified = d.status === "verified" || viaRelay;
  return (
    <Card aria-labelledby={`d-${d.id}`}>
      <CardHeader
        title={<span className="flex flex-wrap items-center gap-2"><span id={`d-${d.id}`} className="font-mono text-[15px] [overflow-wrap:anywhere]">{d.name}</span>{viaRelay ? <StatusBadge status="verified" label="Verified via relay" /> : <StatusBadge status={d.status} pulse={d.status === "pending"} />}{d.stream && <Badge>{d.stream}</Badge>}</span>}
        description={viaRelay ? `Sending as ${d.relay_sender} through your mailbox relay. The relay's own SPF and DKIM cover it, so the records below are optional. Other addresses on this domain still need them.` : BANNER[d.status]}
        action={<DomainMenu id={d.id} name={d.name} />}
      />
      <CardBody className="grid gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-48 flex-1"><Meter done={done} total={recs.length} /></div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {d.last_checked_at && <span className="inline-flex items-center gap-1 text-xs text-muted"><Clock aria-hidden className="size-3.5" />Last checked <RelativeTime value={d.last_checked_at} /></span>}
            <VerifyForm id={d.id} name={d.name} primary={!verified} />
          </div>
        </div>
        {recs.length ? <ul className="grid gap-3" aria-label={`DNS records for ${d.name}`}>{recs.map((r, i) => <DnsRecordRow key={i} r={r} />)}</ul> : <p className="text-sm text-muted">No records yet.</p>}
      </CardBody>
    </Card>
  );
}
