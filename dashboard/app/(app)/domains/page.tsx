import { get } from "@/lib/api";
import { addDomain, verifyDomain } from "@/lib/actions";
import { ActionError, ErrorBanner, RecordsTable, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Domains({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const r = await get("/v1/domains");
  return (
    <>
      <h1>Domains</h1>
      <ActionError err={err} />
      <form action={addDomain} className="inline">
        <label>Domain<input name="domain" required placeholder="mail.example.com" /></label>
        <label>Stream
          <select name="stream"><option value="">default</option><option>transactional</option><option>marketing</option></select>
        </label>
        <button type="submit">Add domain</button>
      </form>
      {r.error ? <ErrorBanner error={r.error} /> : (
        <>
          {!(r.data as any[]).length && <p className="muted">No domains yet.</p>}
          {(r.data as any[]).map((d) => (
            <section key={d.id} aria-labelledby={`d-${d.id}`}>
              <h2 id={`d-${d.id}`}>{d.name} <StatusBadge status={d.status} /></h2>
              <RecordsTable records={d.records ?? []} />
              <form action={verifyDomain}><input type="hidden" name="id" value={d.id} /><button type="submit">Verify {d.name}</button></form>
            </section>
          ))}
        </>
      )}
    </>
  );
}
