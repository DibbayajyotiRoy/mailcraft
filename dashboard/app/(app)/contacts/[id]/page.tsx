import Link from "next/link";
import { Pencil } from "lucide-react";
import { get } from "@/lib/api";
import { parseErr } from "@/lib/err";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { ErrorState, RetryError } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { KeyValue } from "@/components/ui/stat-card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ContactDialog } from "../ContactForm";
import { DangerZone } from "../DangerZone";
import { TrackEvent } from "../TrackEvent";
import { fullName, isSuppressed, type Activity } from "../util";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contact" };

const show = (v: unknown) => (v == null || v === "" ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v));
const Empty = ({ children }: { children: string }) => <p className="px-4 py-6 text-sm text-muted">{children}</p>;

export default async function ContactDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const [{ id }, { err }] = await Promise.all([params, searchParams]);
  const q = encodeURIComponent(id);
  const [r, a, autos, defs] = await Promise.all([get(`/v1/contacts/${q}`), get(`/v1/contacts/${q}/activity`), get("/v1/automations"), get("/v1/event-definitions")]);
  const crumb = [{ label: "Contacts", href: "/contacts" }, { label: "Contact" }];
  if (r.error) return <><PageHeader title="Contact" breadcrumb={crumb} /><RetryError error={r.error} /></>;
  const c = r.data, act: Activity | null = a.error ? null : a.data;
  const suppressed = isSuppressed(c);
  const autoNames = Object.fromEntries(((autos.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const events = [...new Set([...((autos.data ?? []) as { trigger?: string }[]).map((x) => x.trigger), ...((defs.data ?? []) as { name: string }[]).map((x) => x.name)])]
    .filter((n): n is string => !!n && n !== "segment.entered").sort();
  const actionErr = parseErr(err);
  return (
    <>
      <PageHeader title={fullName(c) || c.email} breadcrumb={[...crumb.slice(0, 1), { label: c.email }]}
        description={<span className="inline-flex flex-wrap items-center gap-2">{fullName(c) && <span className="font-mono text-xs">{c.email}</span>}{suppressed ? <Badge tone="bad" size="sm" className="border border-bad">suppressed</Badge> : <StatusBadge status="active" size="sm" />}<span>added <RelativeTime value={c.created_at} /></span></span>}
        action={<><ContactDialog contact={c}><Button variant="secondary"><Pencil aria-hidden />Edit</Button></ContactDialog><TrackEvent email={c.email} events={events} automations={autoNames} /></>} />
      {actionErr && <ErrorState className="mb-6" error={actionErr} />}
      {suppressed && (
        <div role="status" className="mb-6 rounded-lg border border-bad/40 bg-bad-bg p-3 text-sm text-bad">
          We will not send to this address.{c.suppression_reason ? ` Reason: ${c.suppression_reason.replace(/_/g, " ")}.` : ""}
        </div>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
          {!act ? <ErrorState error={a.error!} /> : (
            <>
              <Card>
                <CardHeader title="Events" description="What your app told us this person did. Newest first." />
                {act.events.length ? (
                  <Table caption="Events" bare>
                    <THead><TR><TH>Event</TH><TH>Properties</TH><TH>When</TH></TR></THead>
                    <TBody>{act.events.map((e) => (
                      <TR key={e.id}>
                        <TD label="Event"><code className="text-[12.5px]">{e.name}</code></TD>
                        <TD label="Properties" className="max-w-0 truncate max-md:max-w-none max-md:whitespace-normal max-md:[overflow-wrap:anywhere]">{Object.keys(e.properties ?? {}).length ? <code className="text-xs text-muted">{JSON.stringify(e.properties)}</code> : <span className="text-subtle">-</span>}</TD>
                        <TD label="When"><RelativeTime value={e.received_at} className="text-muted" /></TD>
                      </TR>
                    ))}</TBody>
                  </Table>
                ) : <Empty>No events yet. Use Track event to send a test one.</Empty>}
              </Card>
              <Card>
                <CardHeader title="Emails" description="Everything sent to this address." />
                {act.emails.length ? (
                  <Table caption="Emails sent to this contact" bare>
                    <THead><TR><TH>Subject</TH><TH>Status</TH><TH>Stream</TH><TH>Sent</TH></TR></THead>
                    <TBody>{act.emails.map((e) => (
                      <TR key={e.id}>
                        <TD label="Subject"><Link href={`/emails/${e.id}`} className="font-medium text-accent hover:underline">{e.subject || "(no subject)"}</Link></TD>
                        <TD label="Status"><StatusBadge status={e.status} size="sm" /></TD>
                        <TD label="Stream" className="text-muted">{e.stream}</TD>
                        <TD label="Sent"><RelativeTime value={e.created_at} className="text-muted" /></TD>
                      </TR>
                    ))}</TBody>
                  </Table>
                ) : <Empty>Nothing has been sent to this address.</Empty>}
              </Card>
              <Card>
                <CardHeader title="Automation runs" description="Automations this contact entered." />
                {act.runs.length ? (
                  <Table caption="Automation runs" bare>
                    <THead><TR><TH>Automation</TH><TH>State</TH><TH>Step</TH><TH>Started</TH></TR></THead>
                    <TBody>{act.runs.map((x) => (
                      <TR key={x.id}>
                        <TD label="Automation"><Link href={`/automations/${x.automation_id}`} className="font-medium text-accent hover:underline">{x.automation}</Link></TD>
                        <TD label="State"><StatusBadge status={x.state} size="sm" /></TD>
                        <TD label="Step">{x.current_step ? <code className="text-[12.5px]">{x.current_step}</code> : <span className="text-subtle">-</span>}</TD>
                        <TD label="Started"><RelativeTime value={x.started_at} className="text-muted" /></TD>
                      </TR>
                    ))}</TBody>
                  </Table>
                ) : <Empty>This contact has not entered any automation.</Empty>}
              </Card>
            </>
          )}
        </div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
          <Card>
            <CardHeader title="Details" />
            <CardBody className="grid gap-4">
              <KeyValue items={[["First name", show(c.first_name)], ["Last name", show(c.last_name)], ["Time zone", show(c.timezone)], ["Added", <RelativeTime key="a" value={c.created_at} />]]} />
              <div><p className="mb-1 text-xs text-muted">Contact ID</p><CopyField value={c.id} label="contact ID" /></div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Attributes" />
            <CardBody>
              {Object.keys(c.properties ?? {}).length
                ? <KeyValue items={Object.entries(c.properties).map(([k, v]) => [<code key={k} className="text-[12.5px]">{k}</code>, show(v)])} />
                : <p className="text-sm text-muted">None yet. Edit the contact to add some.</p>}
            </CardBody>
          </Card>
          {act && (
            <Card>
              <CardHeader title="Topics and segments" />
              <CardBody className="grid gap-4">
                <div>
                  <h3 className="mb-2 text-sm font-medium">Topics</h3>
                  {act.topics.length
                    ? <ul className="flex flex-wrap gap-2">{act.topics.map((t) => <li key={t.key}><Badge tone={t.opted_in ? "ok" : "neutral"}>{t.name}: {t.opted_in ? "subscribed" : "unsubscribed"}</Badge></li>)}</ul>
                    : <p className="text-sm text-muted">No opt-outs recorded. They appear when the contact uses an unsubscribe link.</p>}
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium">Segments</h3>
                  {act.segments.length
                    ? <ul className="flex flex-wrap gap-2">{act.segments.map((s) => <li key={s.id}><Link href="/contacts?tab=segments" className="inline-flex h-6 items-center rounded-full bg-surface-2 px-2 text-xs font-medium hover:underline">{s.name}</Link></li>)}</ul>
                    : <p className="text-sm text-muted">Not in a segment yet.</p>}
                </div>
              </CardBody>
            </Card>
          )}
          <DangerZone contact={c} suppressed={suppressed} reason={c.suppression_reason} />
        </div>
      </div>
    </>
  );
}
