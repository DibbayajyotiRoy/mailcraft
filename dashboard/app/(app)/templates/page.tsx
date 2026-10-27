import Link from "next/link";
import { get } from "@/lib/api";
import { importTemplate } from "@/lib/actions";
import { ActionError, ErrorBanner, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Templates({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const r = await get("/v1/templates");
  return (
    <>
      <h1>Templates</h1>
      <ActionError err={err} />
      {r.error ? <ErrorBanner error={r.error} /> : (
        <table>
          <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Export</th></tr></thead>
          <tbody>
            {(r.data as any[]).map((t) => (
              <tr key={t.id}>
                <td><Link href={`/templates/${t.id}`}>{t.name ?? t.id}</Link></td>
                <td>{t.status && <StatusBadge status={t.status} />}</td>
                <td>{["json", "html", "mjml"].map((f) => <a key={f} href={`/templates/${t.id}/export?format=${f}`} className="gap">{f}</a>)}</td>
              </tr>
            ))}
            {!(r.data as any[]).length && <tr><td colSpan={3} className="muted">No templates.</td></tr>}
          </tbody>
        </table>
      )}
      <h2>Import</h2>
      <form action={importTemplate} className="stack">
        <label>Name<input name="name" required /></label>
        <label>Format<select name="format"><option>json</option><option>html</option><option>mjml</option></select></label>
        <label>Content<textarea name="content" rows={10} required /></label>
        <button type="submit">Import template</button>
      </form>
    </>
  );
}
