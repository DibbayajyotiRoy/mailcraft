import Link from "next/link";
import { get } from "@/lib/api";
import { ErrorBanner, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Contacts({ searchParams }: { searchParams: Promise<{ tab?: string; cursor?: string }> }) {
  const { tab, cursor } = await searchParams;
  const seg = tab === "segments";
  const r = await get(seg ? "/v1/segments" : `/v1/contacts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  return (
    <>
      <h1>Contacts</h1>
      <nav aria-label="Contacts sections" className="tabs">
        <Link href="/contacts" aria-current={seg ? undefined : "page"}>Contacts</Link>
        <Link href="/contacts?tab=segments" aria-current={seg ? "page" : undefined}>Segments</Link>
      </nav>
      {r.error ? <ErrorBanner error={r.error} /> : seg ? (
        <table>
          <thead><tr><th scope="col">Name</th><th scope="col">ID</th></tr></thead>
          <tbody>{(r.data as any[]).map((s) => <tr key={s.id}><td>{s.name}</td><td><code>{s.id}</code></td></tr>)}
            {!(r.data as any[]).length && <tr><td colSpan={2} className="muted">No segments.</td></tr>}</tbody>
        </table>
      ) : (
        <>
          <table>
            <thead><tr><th scope="col">Email</th><th scope="col">Name</th><th scope="col">Status</th></tr></thead>
            <tbody>{(r.data as any[]).map((c) => (
              <tr key={c.id ?? c.email}><td>{c.email}</td><td>{c.name ?? [c.first_name, c.last_name].filter(Boolean).join(" ")}</td><td>{c.status && <StatusBadge status={c.status} />}</td></tr>
            ))}
              {!(r.data as any[]).length && <tr><td colSpan={3} className="muted">No contacts.</td></tr>}</tbody>
          </table>
          {r.next_cursor && <Link rel="next" href={`/contacts?cursor=${encodeURIComponent(r.next_cursor)}`}>Next page</Link>}
        </>
      )}
    </>
  );
}
