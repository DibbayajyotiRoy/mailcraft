import { get } from "@/lib/api";
import { ErrorBanner, Json, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function EmailDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, ev] = await Promise.all([get(`/v1/emails/${encodeURIComponent(id)}`), get(`/v1/emails/${encodeURIComponent(id)}/events`)]);
  if (r.error) return <><h1>Email</h1><ErrorBanner error={r.error} /></>;
  const e = r.data;
  return (
    <>
      <h1>{e.subject || "(no subject)"} <StatusBadge status={e.status} /></h1>
      <p>From {e.from_addr} to {e.to_addr} ({e.env}, {e.stream}, {e.attempts} attempts)</p>
      {e.last_error && <p className="muted">Last error: {e.last_error}</p>}
      <h2>Events</h2>
      {ev.error && <ErrorBanner error={ev.error} />}
      <ol className="timeline">
        {((ev.data as any[]) ?? []).map((x, i) => <li key={i}><time>{x.occurred_at}</time> <StatusBadge status={x.type} /> {x.diagnostic ?? ""}</li>)}
        {!((ev.data as any[]) ?? []).length && <li className="muted">No events yet.</li>}
      </ol>
      <h2>Policy decisions</h2>
      {(e.policy_decisions ?? []).length ? <Json value={e.policy_decisions} /> : <p className="muted">None.</p>}
    </>
  );
}
