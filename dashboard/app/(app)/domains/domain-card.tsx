import Link from "next/link";
import { Clock } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import { DnsRecordRow, type DnsRec } from "@/components/ui/dns-record";
import { Meter } from "@/components/ui/meter";
import { DomainMenu } from "./domain-menu";
import { VerifyForm } from "./verify-form";
import { SendsVia, type TransportOpt } from "./sends-via";
import { senderLabel, type Sender } from "@/lib/senders";

export type Domain = { id: string; name: string; status: string; stream?: string; records?: DnsRec[]; last_checked_at?: string | null; relay_sender?: string; relay_senders?: string[]; transport_id?: string | null };

const BANNER: Record<string, string> = {
  not_started: "Add these records at your DNS provider, then verify.",
  pending: "Checking. This usually takes under 15 minutes and can take up to 72 hours.",
  verified: "All set. This domain can send.",
  failed: "We could not see your records after repeated checks. Compare them with the values below, check for proxying, then verify again.",
};

export function DomainCard({ d, transports = [], senders = [] }: { d: Domain; transports?: TransportOpt[]; senders?: Sender[] }) {
  const recs = d.records ?? [];
  const here = senders.filter((s) => s.address.toLowerCase().endsWith(`@${d.name.toLowerCase()}`));
  const relayAddrs = d.relay_senders?.length ? d.relay_senders : d.relay_sender ? [d.relay_sender] : [];
  const done = recs.filter((r) => r.status === "verified").length;
  const viaRelay = relayAddrs.length > 0 && d.status !== "verified";
  const verified = d.status === "verified" || viaRelay;
  return (
    <Card aria-labelledby={`d-${d.id}`}>
      <CardHeader
        title={<span className="flex flex-wrap items-center gap-2"><span id={`d-${d.id}`} className="font-mono text-[15px] [overflow-wrap:anywhere]">{d.name}</span>{viaRelay ? <StatusBadge status="verified" label="Verified via relay" /> : <StatusBadge status={d.status} pulse={d.status === "pending"} />}{d.stream && <Badge>{d.stream}</Badge>}</span>}
        description={viaRelay ? `Sending as ${relayAddrs.join(", ")} through your mailbox relay. The relay's own SPF and DKIM cover it, so the records below are optional. Other addresses on this domain still need them.` : BANNER[d.status]}
        action={<DomainMenu id={d.id} name={d.name} />}
      />
      <CardBody className="grid gap-4">
        <div className="grid gap-4 rounded-md border border-border p-3 sm:grid-cols-2">
          <SendsVia id={d.id} domain={d.name} transportId={d.transport_id} transports={transports} />
          <div className="grid content-start gap-1.5">
            <h3 className="text-sm font-medium">Senders on this domain</h3>
            {here.length ? (
              <ul className="grid gap-1 text-sm" aria-label={`Senders on ${d.name}`}>
                {here.map((s) => <li key={s.address} className="flex flex-wrap items-center gap-2"><span className="min-w-0 truncate [overflow-wrap:anywhere]">{senderLabel(s)}</span>{s.status && <StatusBadge status={s.status} size="sm" />}</li>)}
              </ul>
            ) : <p className="text-sm text-muted">None yet. Connect a mailbox with an address here in <Link href="/settings#senders" className="text-accent underline underline-offset-2">Settings</Link>, or send from any address once the domain is verified.</p>}
          </div>
        </div>
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
