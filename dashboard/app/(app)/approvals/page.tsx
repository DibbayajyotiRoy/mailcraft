import { get } from "@/lib/api";
import { decide } from "@/lib/actions";
import { ActionError, ErrorBanner, Json, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Approvals({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const r = await get("/v1/approvals");
  return (
    <>
      <h1>Approvals</h1>
      <ActionError err={err} />
      {r.error ? <ErrorBanner error={r.error} /> : (
        <>
          {!(r.data as any[]).length && <p className="muted">The queue is empty.</p>}
          {(r.data as any[]).map((a) => {
            const pv = a.payload?.preview; // email approvals carry {subject, text, has_html}
            return (
              <section key={a.id} aria-labelledby={`a-${a.id}`}>
                <h2 id={`a-${a.id}`}>{pv?.subject ?? a.kind} {a.status && <StatusBadge status={a.status} />}</h2>
                {pv?.text ? <pre>{pv.text}</pre> : <Json value={a.payload} />}
                <form action={decide} className="inline">
                  <input type="hidden" name="id" value={a.id} />
                  <button type="submit" name="decision" value="approve">Approve</button>
                  <button type="submit" name="decision" value="reject" className="danger">Reject</button>
                </form>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
