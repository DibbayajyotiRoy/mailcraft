import Link from "next/link";
import { get } from "@/lib/api";
import { ErrorBanner, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";
const STATUSES = ["queued", "pending_approval", "sending", "deferred", "sent", "delivered", "bounced", "failed", "suppressed", "cancelled"];

export default async function Emails({ searchParams }: { searchParams: Promise<{ status?: string; cursor?: string }> }) {
  const { status, cursor } = await searchParams;
  const q = new URLSearchParams({ limit: "25" });
  if (status) q.set("status", status);
  if (cursor) q.set("cursor", cursor);
  const r = await get(`/v1/emails?${q}`);
  const next = new URLSearchParams(status ? { status } : {});
  if (r.next_cursor) next.set("cursor", r.next_cursor);
  return (
    <>
      <h1>Emails</h1>
      <form method="get" className="inline">
        <label>Status
          <select name="status" defaultValue={status ?? ""}>
            <option value="">All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>
      {r.error ? <ErrorBanner error={r.error} /> : (
        <>
          <table>
            <thead><tr><th scope="col">Subject</th><th scope="col">To</th><th scope="col">Status</th><th scope="col">Created</th></tr></thead>
            <tbody>
              {(r.data as any[]).map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/emails/${e.id}`}>{e.subject || "(no subject)"}</Link></td>
                  <td>{e.to_addr}</td><td><StatusBadge status={e.status} /></td><td>{e.created_at}</td>
                </tr>
              ))}
              {!(r.data as any[]).length && <tr><td colSpan={4} className="muted">No emails.</td></tr>}
            </tbody>
          </table>
          <nav aria-label="Pagination" className="inline">
            {cursor && <Link href={`/emails${status ? `?status=${status}` : ""}`}>First page</Link>}
            {r.next_cursor && <Link rel="next" href={`/emails?${next}`}>Next page</Link>}
          </nav>
        </>
      )}
    </>
  );
}
