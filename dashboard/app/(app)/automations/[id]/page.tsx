import { get } from "@/lib/api";
import { ErrorBanner, Json, StatusBadge } from "@/components/ui";
import { StateButton } from "@/components/StateButton";

export const dynamic = "force-dynamic";

export default async function AutomationDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const [a, runs] = await Promise.all([get(`/v1/automations/${encodeURIComponent(id)}`), get(`/v1/automations/${encodeURIComponent(id)}/runs`)]);
  if (a.error) return <><h1>Automation</h1><ErrorBanner error={a.error} /></>;
  return (
    <>
      <h1>{a.data.name ?? id} <StatusBadge status={a.data.status} /></h1>
      {err && <ErrorBanner error={{ code: err.split("|")[0], message: err.split("|")[1], hint: err.split("|")[2] || undefined }} />}
      <StateButton id={id} status={a.data.status} from={`/automations/${id}`} />
      <h2>Definition</h2><Json value={a.data} />
      <h2>Runs</h2>
      {runs.error ? <ErrorBanner error={runs.error} /> : (
        <table>
          <thead><tr><th scope="col">Run</th><th scope="col">Contact</th><th scope="col">Status</th><th scope="col">Started</th></tr></thead>
          <tbody>{(runs.data as any[]).map((r) => <tr key={r.id}><td><code>{r.id}</code></td><td>{r.contact ?? r.contact_id ?? ""}</td><td><StatusBadge status={r.status} /></td><td>{r.started_at ?? r.created_at ?? ""}</td></tr>)}
            {!(runs.data as any[]).length && <tr><td colSpan={4} className="muted">No runs.</td></tr>}</tbody>
        </table>
      )}
    </>
  );
}
