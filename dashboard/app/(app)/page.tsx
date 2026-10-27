import { get } from "@/lib/api";
import { Bars, ErrorBanner, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const [o, st] = await Promise.all([get("/v1/stats/overview?days=7"), get("/v1/account/status")]);
  const t = o.data?.totals ?? {};
  const series: any[] = o.data?.series ?? [];
  return (
    <>
      <h1>Overview</h1>
      {o.error && <ErrorBanner error={o.error} />}
      {st.error && <ErrorBanner error={st.error} />}
      {o.data && (
        <>
          <dl className="stats">
            <Stat label="Sent" value={t.sent ?? 0} />
            <Stat label="Delivered" value={t.delivered ?? 0} />
            <Stat label="Bounces" value={t.bounced ?? 0} />
            <Stat label="Complaints" value={t.complained ?? 0} />
            {st.data && <Stat label="Pending approvals" value={<a href="/approvals">{st.data.pending_approvals ?? 0}</a>} />}
          </dl>
          <Bars label="Sent per day, last 7 days" series={series.map((s) => ({ date: s.date, value: s.sent }))} />
        </>
      )}
    </>
  );
}
