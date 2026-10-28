import Link from "next/link";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { RetryError } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Meter } from "@/components/ui/meter";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { AutoRefresh } from "@/components/broadcasts/auto-refresh";
import { COUNTS, REASON } from "@/lib/broadcast";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Broadcast" };
const FILTERS = ["all", "queued", "sent", "delivered", "bounced", "failed", "suppressed"] as const;

export default async function BroadcastDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; cursor?: string }> }) {
  const { id } = await params;
  const { status, cursor } = await searchParams;
  const q = new URLSearchParams({ limit: "25" });
  if (status && status !== "all") q.set("status", status);
  if (cursor) q.set("cursor", cursor);
  const r = await get(`/v1/broadcasts/${encodeURIComponent(id)}?${q}`);
  if (r.error) return <><PageHeader title="Broadcast" breadcrumb={[{ label: "Broadcasts", href: "/broadcasts" }, { label: id }]} /><RetryError error={r.error} /></>;
  const b = r.data;
  const counts = b.counts ?? {};
  const recipients: any[] = b.recipients ?? [], skipped: any[] = b.skipped ?? [];
  const href = (s: string, c?: string) => `/broadcasts/${id}?${new URLSearchParams({ ...(s !== "all" ? { status: s } : {}), ...(c ? { cursor: c } : {}) })}`.replace(/\?$/, "");
  const active = status && FILTERS.includes(status as any) ? status : "all";
  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Broadcasts", href: "/broadcasts" }, { label: b.subject || b.template_name }]}
        title={<span className="inline-flex flex-wrap items-center gap-3">{b.subject || b.template_name}<StatusBadge status={b.status} pulse={b.status !== "done"} /></span>}
        description={<>Template {b.template_name} · from <span className="font-mono text-xs">{b.from}</span> · {b.stream} · created <RelativeTime value={b.created_at} /></>}
        action={b.status === "pending_approval" ? <Button asChild variant="secondary"><Link href="/approvals">Open approvals</Link></Button> : undefined}
      />
      <AutoRefresh active={b.status === "sending"} />
      <div className="grid gap-6">
        {b.status === "pending_approval" && <p role="status" className="rounded-md border border-info/40 bg-info-bg p-3 text-sm text-info">Waiting for a human to approve this broadcast. Nothing is sent until then.</p>}
        <Card>
          <CardBody className="grid gap-4">
            <Meter done={Math.max(0, b.total - (counts.queued ?? 0))} total={b.total} label="Broadcast progress" unit="processed" />
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {COUNTS.map((c) => <StatCard key={c} label={c[0].toUpperCase() + c.slice(1)} value={formatNumber(counts[c] ?? 0)} />)}
            </dl>
            {b.first_at && (
              <p className="text-sm text-muted">
                Scheduled from <time dateTime={b.first_at} className="text-fg">{new Date(b.first_at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</time>
                {b.last_at && b.last_at !== b.first_at && <> to <time dateTime={b.last_at} className="text-fg">{new Date(b.last_at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</time></>}, spread to stay under your sending limit.
              </p>
            )}
          </CardBody>
        </Card>

        <section aria-labelledby="rc" className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="rc" className="text-md font-semibold">Recipients</h2>
            <nav aria-label="Filter by status" className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <Link key={f} href={href(f)} aria-current={active === f ? "true" : undefined}
                  className={cn("inline-flex h-7 items-center rounded-full border border-border px-3 text-xs font-medium text-muted hover:text-fg pointer-coarse:h-10", active === f && "border-accent bg-accent-soft text-fg")}>{f}</Link>
              ))}
            </nav>
          </div>
          {!recipients.length ? (
            <EmptyState variant="no-results" title="No recipients here" description={active === "all" ? "Nothing was queued." : `No recipient has status “${active}”.`} action={active !== "all" ? <Button asChild variant="secondary"><Link href={href("all")}>Show all</Link></Button> : undefined} />
          ) : (
            <Table caption="Recipients">
              <THead><tr><TH>Recipient</TH><TH>Status</TH><TH>Scheduled</TH><TH>Sent</TH><TH>Note</TH></tr></THead>
              <TBody>
                {recipients.map((e) => (
                  <TR key={e.id}>
                    <TD label="Recipient" className="max-w-[20rem]"><Link href={`/emails/${e.id}`} className="block truncate font-mono text-xs text-accent hover:underline">{e.email}</Link></TD>
                    <TD label="Status"><StatusBadge status={e.status} size="sm" /></TD>
                    <TD label="Scheduled" className="whitespace-nowrap text-muted">{e.scheduled_at ? <RelativeTime value={e.scheduled_at} /> : "now"}</TD>
                    <TD label="Sent" className="whitespace-nowrap text-muted">{e.sent_at ? <RelativeTime value={e.sent_at} /> : "-"}</TD>
                    <TD label="Note" className="max-w-[18rem] max-md:text-left"><span className="block truncate text-xs text-muted" title={e.last_error ?? undefined}>{e.last_error ?? ""}</span></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <nav aria-label="Pagination" className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted">{recipients.length} shown</span>
            <span className="flex gap-2">
              {cursor && <Button asChild variant="secondary"><Link href={href(active)}>First page</Link></Button>}
              {b.next_cursor && <Button asChild variant="secondary"><Link rel="next" href={href(active, b.next_cursor)}>Next page</Link></Button>}
            </span>
          </nav>
        </section>

        {skipped.length > 0 && (
          <Card>
            <CardHeader title="Left out when it was created" description={`${skipped.length} ${skipped.length === 1 ? "address was" : "addresses were"} not queued.`} />
            <CardBody>
              <Table caption="Skipped recipients">
                <THead><tr><TH>Address</TH><TH>Why</TH></tr></THead>
                <TBody>
                  {skipped.slice(0, 100).map((s, i) => (
                    <TR key={i}><TD label="Address" className="font-mono text-xs [overflow-wrap:anywhere]">{s.email}</TD><TD label="Why">{REASON[s.reason] ?? s.reason}{s.detail ? <span className="text-muted"> · {s.detail}</span> : null}</TD></TR>
                  ))}
                </TBody>
              </Table>
              {skipped.length > 100 && <p className="mt-2 text-xs text-muted">and {skipped.length - 100} more</p>}
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
