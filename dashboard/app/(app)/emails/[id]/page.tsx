import Link from "next/link";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { KeyValue } from "@/components/ui/stat-card";
import { CopyField } from "@/components/ui/copy";
import { RelativeTime } from "@/components/ui/relative-time";
import { EmailTrail, PolicyDecisions, BounceCallout, type MailEvent } from "@/components/emails/trail";
import { MessagePreview } from "@/components/monitor/message-preview";
import { RetryError } from "@/components/monitor/retry-error";

export const dynamic = "force-dynamic";

export default async function EmailDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, ev] = await Promise.all([get(`/v1/emails/${encodeURIComponent(id)}`), get(`/v1/emails/${encodeURIComponent(id)}/events`)]);
  const crumb = [{ label: "Emails", href: "/emails" }, { label: "Email" }];
  if (r.error) return <><PageHeader title="Email" breadcrumb={crumb} /><RetryError error={r.error} /></>;
  const e = r.data;
  const events: MailEvent[] = (ev.data as MailEvent[]) ?? [];
  const hasBounceEvent = events.some((x) => x.type === "bounced" || x.type === "failed");
  return (
    <>
      <PageHeader title={e.subject || "(no subject)"} breadcrumb={crumb}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={e.status} /><span>to <span className="font-mono text-xs">{e.to_addr}</span></span><RelativeTime value={e.created_at} /></span>}
        action={e.status === "pending_approval" ? <Link data-ui="link" href="/approvals" className="text-sm font-medium text-accent underline underline-offset-2">Review approval</Link> : undefined} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-w-0 gap-6">
          <Card>
            <CardHeader title="Delivery timeline" description="What happened to this message, and when." />
            <CardBody>
              {e.last_error && !hasBounceEvent && <div className="mb-4"><BounceCallout text={e.last_error} status={e.status === "deferred" ? "deferred" : "failed"} /></div>}
              {ev.error ? <RetryError error={ev.error} /> : <EmailTrail events={events} status={e.status} approvalHref="/approvals" />}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Message" />
            <CardBody><MessagePreview html={e.html} text={e.text} title={`Preview of ${e.subject || "email"}`} /></CardBody>
          </Card>
        </div>
        <div className="grid min-w-0 gap-6">
          <Card>
            <CardHeader title="Details" />
            <CardBody className="grid gap-4">
              <KeyValue items={[["From", <span key="f" className="font-mono text-xs">{e.from_addr}</span>], ["To", <span key="t" className="font-mono text-xs">{e.to_addr}</span>], ["Stream", e.stream], ["Environment", e.env], ["Attempts", e.attempts]]} />
              <div><p className="mb-1 text-xs text-muted">Message ID</p><CopyField value={e.id} label="message ID" /></div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Policy decisions" description="Rules checked before sending." />
            <CardBody><PolicyDecisions decisions={e.policy_decisions ?? []} /></CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
