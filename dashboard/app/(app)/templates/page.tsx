import { api, get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { RetryError } from "@/components/ui/error-state";
import { parseErr } from "@/lib/err";
import { ImportTemplate } from "./ImportTemplate";
import { TemplatesView, type TemplateRow } from "./TemplatesView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Templates" };
const THUMBS = 24; // thumbnails are rendered server-side for the first N; the rest show a placeholder

export default async function Templates({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const e = parseErr(err);
  const r = await get("/v1/templates");
  let rows: TemplateRow[] = [];
  if (!r.error) {
    const list = (Array.isArray(r.data) ? r.data : []) as TemplateRow[];
    const previews = await Promise.all(list.slice(0, THUMBS).map((t) => api("POST", `/v1/templates/${encodeURIComponent(t.id)}/preview`, { variables: {} })));
    rows = list.map((t, i) => ({ ...t, thumb: previews[i]?.data?.html ?? null }));
  }
  return (
    <>
      <PageHeader title="Templates" description="Reusable email layouts. Publish a template to use it in sends and automations." action={<ImportTemplate />} />
      {e && <div className="mb-4"><RetryError error={e} /></div>}
      {r.error ? <RetryError error={r.error} /> : <TemplatesView templates={rows} />}
    </>
  );
}
