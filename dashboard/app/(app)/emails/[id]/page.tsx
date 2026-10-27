import { get } from "@/lib/api";
import { ErrorBanner, Json, Preview, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function EmailDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await get(`/v1/emails/${encodeURIComponent(id)}`);
  if (r.error) return <><h1>Email</h1><ErrorBanner error={r.error} /></>;
  const e = r.data;
  return (
    <>
      <h1>{e.subject || "(no subject)"} <StatusBadge status={e.status} /></h1>
      <p>From {e.from} to {(e.to ?? []).join(", ")}</p>
      <h2>Events</h2>
      <ol className="timeline">
        {(e.events ?? []).map((ev: any, i: number) => <li key={i}><time>{ev.at ?? ev.created_at}</time> <StatusBadge status={ev.type ?? ev.kind ?? "event"} /> {ev.detail ?? ev.reason ?? ""}</li>)}
        {!(e.events ?? []).length && <li className="muted">No events yet.</li>}
      </ol>
      <h2>Policy decisions</h2>
      {(e.policy_decisions ?? []).length ? <Json value={e.policy_decisions} /> : <p className="muted">None.</p>}
      <h2>Rendered body</h2>
      {e.rendered?.html ? <Preview title="Rendered email body" html={e.rendered.html} /> : <pre>{e.rendered?.text ?? "Not available."}</pre>}
    </>
  );
}
