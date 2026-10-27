import { Suspense } from "react";
import Link from "next/link";
import { get } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/ui/relative-time";
import { TrendChart } from "@/components/overview/trend-chart";
import { NeedsAttention, RangeSwitch, SetupChecklistSlot, Sparkline, type Attention } from "@/components/overview/parts";
import { OverviewSkeleton } from "@/components/overview/skeleton";
import { RetryError } from "@/components/ui/error-state";
import { BOUNCE_LIMIT, COMPLAINT_LIMIT, delta, fmtPct, formatNumber, rangeFor, rate, splitSeries, sum, toDays } from "@/components/monitor/helpers";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ range?: string }> };

export default function Page({ searchParams }: Props) {
  return <Suspense fallback={<OverviewSkeleton />}><Overview searchParams={searchParams} /></Suspense>;
}

async function Overview({ searchParams }: Props) {
  const range = rangeFor((await searchParams).range);
  const [o, st, doms, keys, recent] = await Promise.all([
    get(`/v1/stats/overview?days=${Math.min(90, Math.max(2, range.days * 2))}`), get("/v1/account/status"),
    get("/v1/domains"), get("/v1/keys"), get("/v1/emails?limit=5"),
  ]);
  const header = <PageHeader title="Overview" description={`Delivery health, last ${range.label}.`} action={<RangeSwitch active={range.key} />} />;
  if (o.error) return <>{header}<RetryError error={o.error} /></>;

  const all = toDays(o.data?.series);
  const { cur, prev } = splitSeries(all, range.days);
  const c = sum(cur), p = sum(prev);
  const rows: any[] = recent.data ?? [];
  const empty = c.sent === 0 && p.sent === 0 && !rows.length;
  const dr = rate(c.delivered, c.sent), br = rate(c.bounced, c.sent), cr = rate(c.complained, c.sent);

  const attention: Attention[] = [];
  if (st.data?.kill_switch) attention.push({ id: "kill", tone: "bad", text: "Sending is paused: the kill switch is engaged.", href: "/settings", action: "Review" });
  const pending = st.data?.pending_approvals ?? 0;
  if (pending > 0) attention.push({ id: "appr", tone: "warn", text: `${pending} ${pending === 1 ? "email is" : "emails are"} waiting for approval.`, href: "/approvals", action: "Review" });
  const unverified = ((doms.data as any[]) ?? []).filter((d) => d.status !== "verified");
  if (unverified.length) attention.push({ id: "dom", tone: "warn", text: `${unverified[0].name ?? "A domain"}${unverified.length > 1 ? ` and ${unverified.length - 1} more are` : " is"} not verified yet.`, href: "/domains", action: "Verify" });
  if (br !== null && br > BOUNCE_LIMIT) attention.push({ id: "bounce", tone: "bad", text: `Bounce rate is ${fmtPct(br)}, above the ${BOUNCE_LIMIT}% limit.`, href: "/emails?status=bounced", action: "See bounces" });
  if (cr !== null && cr > COMPLAINT_LIMIT) attention.push({ id: "spam", tone: "bad", text: `Complaint rate is ${fmtPct(cr)}, above the ${COMPLAINT_LIMIT}% limit.`, href: "/emails", action: "Investigate" });

  const spark = (k: "sent" | "delivered" | "bounced" | "complained") => all.slice(-7).map((d) => d[k]);
  const meta = (r: number | null, limit?: number) => (
    <span className={`text-xs font-normal ${limit !== undefined && r !== null && r > limit ? "text-bad" : "text-muted"}`}>{fmtPct(r)}{limit !== undefined && ` of ${limit}% limit`}</span>
  );

  return (
    <>
      {header}
      <NeedsAttention items={attention} />
      <dl className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Sent" value={<>{formatNumber(c.sent)}<Sparkline values={spark("sent")} className="order-last ml-auto self-center" /></>} delta={delta(c.sent, p.sent, true)} />
        <StatCard label="Delivered" value={<>{formatNumber(c.delivered)} {meta(dr)}<Sparkline values={spark("delivered")} className="order-last ml-auto self-center" /></>} delta={delta(c.delivered, p.delivered, true)} />
        <StatCard label="Bounced" value={<>{formatNumber(c.bounced)} {meta(br, BOUNCE_LIMIT)}<Sparkline values={spark("bounced")} className="order-last ml-auto self-center" /></>} delta={delta(c.bounced, p.bounced, false)} />
        <StatCard label="Complaints" value={<>{formatNumber(c.complained)} {meta(cr, COMPLAINT_LIMIT)}<Sparkline values={spark("complained")} className="order-last ml-auto self-center" /></>} delta={delta(c.complained, p.complained, false)} />
      </dl>

      {empty ? (
        <SetupChecklistSlot steps={[
          { id: "dom", title: "Add and verify a domain", why: "Mail from a verified domain lands in inboxes, not spam.", done: ((doms.data as any[]) ?? []).some((d) => d.status === "verified"), href: "/domains", cta: "Add domain" },
          { id: "key", title: "Create an API key", why: "Your app or agent authenticates with it.", done: ((keys.data as any[]) ?? []).length > 0, href: "/keys", cta: "Create key" },
          { id: "send", title: "Send a test email", why: "POST /v1/emails with a test key; it shows up here within seconds.", done: false, href: "/keys", cta: "Get a key" },
          { id: "tpl", title: "Create a template", why: "Reuse one design across sends.", done: false, href: "/templates", cta: "Open templates" },
        ]} />
      ) : (
        <div className="grid gap-6">
          <Card>
            <CardHeader title="Sent vs delivered vs bounced" description={`Per day, ${all.length ? `last ${cur.length} ${cur.length === 1 ? "day" : "days"}` : "no data yet"}.`} />
            <CardBody>{cur.length ? <TrendChart days={cur} label={`Daily volume, last ${range.label}`} /> : <p className="text-sm text-muted">No daily data for this range yet.</p>}</CardBody>
          </Card>
          <Card>
            <CardHeader title="Recent emails" action={<Link href="/emails" className="text-sm font-medium text-accent underline-offset-2 hover:underline">View all</Link>} />
            {rows.length ? (
              <ul className="divide-y divide-border">
                {rows.map((e) => (
                  <li key={e.id}>
                    <Link href={`/emails?open=${encodeURIComponent(e.id)}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm transition-colors duration-[var(--dur-fast)] hover:bg-surface-2">
                      <StatusBadge status={e.status} size="sm" />
                      <span className="min-w-0 flex-1 truncate font-medium">{e.subject || "(no subject)"}</span>
                      <span className="max-w-full truncate font-mono text-xs text-muted">{e.to_addr}</span>
                      <RelativeTime value={e.created_at} className="text-xs text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <CardBody><EmptyState title="No emails in this range" description={`Latest activity ${rows[0] ? relativeTime(rows[0].created_at) : "will show up here"}.`} /></CardBody>}
          </Card>
        </div>
      )}
    </>
  );
}
