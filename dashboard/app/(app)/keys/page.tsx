import { get } from "@/lib/api";
import { revokeKey } from "@/lib/actions";
import { ActionError, ErrorBanner } from "@/components/ui";
import { ConfirmButton, KeyForm } from "@/components/Confirm";

export const dynamic = "force-dynamic";

export default async function Keys({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const r = await get("/v1/keys");
  return (
    <>
      <h1>API keys</h1>
      <ActionError err={err} />
      {r.error ? <ErrorBanner error={r.error} /> : (
        <table>
          <thead><tr><th scope="col">Name</th><th scope="col">Prefix</th><th scope="col">Scopes</th><th scope="col">Created</th><th scope="col">Revoke</th></tr></thead>
          <tbody>{(r.data as any[]).map((k) => (
            <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix ?? k.key_prefix}</code></td><td>{(k.scopes ?? []).join(" ")}</td><td>{k.created_at}</td>
              <td><form action={revokeKey}><input type="hidden" name="id" value={k.id} /><ConfirmButton className="danger" message={`Revoke key ${k.name}?`}>Revoke</ConfirmButton></form></td></tr>
          ))}
            {!(r.data as any[]).length && <tr><td colSpan={5} className="muted">No keys.</td></tr>}</tbody>
        </table>
      )}
      <h2>Create key</h2>
      <KeyForm />
    </>
  );
}
