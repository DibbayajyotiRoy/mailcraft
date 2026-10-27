import { api, get } from "@/lib/api";
import { ErrorBanner, Json, Preview, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function TemplateDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [t, p] = await Promise.all([get(`/v1/templates/${encodeURIComponent(id)}`), api("POST", `/v1/templates/${encodeURIComponent(id)}/preview`, { variables: {} })]);
  if (t.error) return <><h1>Template</h1><ErrorBanner error={t.error} /></>;
  return (
    <>
      <h1>{t.data.name ?? id} {t.data.status && <StatusBadge status={t.data.status} />}</h1>
      <h2>Preview</h2>
      {p.error ? <ErrorBanner error={p.error} /> : (
        <>
          {p.data.subject && <p><strong>Subject:</strong> {p.data.subject}</p>}
          <Preview title="Template preview" html={p.data.html ?? ""} />
          {(p.data.lint ?? []).length > 0 && <><h3>Lint</h3><Json value={p.data.lint} /></>}
        </>
      )}
      <h2>Definition</h2>
      <Json value={t.data} />
    </>
  );
}
