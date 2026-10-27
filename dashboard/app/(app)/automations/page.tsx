import Link from "next/link";
import { get } from "@/lib/api";
import { ErrorBanner, StatusBadge } from "@/components/ui";
import { StateButton } from "@/components/StateButton";

export const dynamic = "force-dynamic";

export default async function Automations({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const r = await get("/v1/automations");
  return (
    <>
      <h1>Automations</h1>
      {err && <ErrorBanner error={{ code: err.split("|")[0], message: err.split("|")[1], hint: err.split("|")[2] || undefined }} />}
      {r.error ? <ErrorBanner error={r.error} /> : (
        <table>
          <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
          <tbody>{(r.data as any[]).map((a) => (
            <tr key={a.id}><td><Link href={`/automations/${a.id}`}>{a.name ?? a.id}</Link></td><td><StatusBadge status={a.status} /></td>
              <td><StateButton id={a.id} status={a.status} from="/automations" /></td></tr>
          ))}
            {!(r.data as any[]).length && <tr><td colSpan={3} className="muted">No automations.</td></tr>}</tbody>
        </table>
      )}
    </>
  );
}
