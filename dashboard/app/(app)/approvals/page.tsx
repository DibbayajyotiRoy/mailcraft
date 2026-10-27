import { get } from "@/lib/api";
import { decide } from "@/lib/actions";
import { ActionError, ErrorBanner, Json, Preview, StatusBadge } from "@/components/ui";

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
            const html = a.preview?.html ?? a.rendered?.html ?? a.html;
            return (
              <section key={a.id} aria-labelledby={`a-${a.id}`}>
                <h2 id={`a-${a.id}`}>{a.subject ?? a.summary ?? a.id} {a.status && <StatusBadge status={a.status} />}</h2>
                {html ? <Preview title={`Preview of ${a.id}`} html={html} /> : <Json value={a} />}
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
