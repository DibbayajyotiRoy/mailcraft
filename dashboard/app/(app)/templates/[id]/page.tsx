import { api, get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { ApiErrorState } from "../../_p3/ApiErrorState";
import { parseErr } from "../../_p3/err";
import { TemplateDetail } from "./TemplateDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Template" };

export default async function TemplateDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const e = parseErr(err);
  const [t, p] = await Promise.all([get(`/v1/templates/${encodeURIComponent(id)}`), api("POST", `/v1/templates/${encodeURIComponent(id)}/preview`, { variables: {} })]);
  const shaped = !t.error && t.data && !Array.isArray(t.data) && typeof t.data === "object";
  if (t.error || !shaped) return (
    <>
      <PageHeader title="Template" breadcrumb={[{ label: "Templates", href: "/templates" }, { label: id }]} />
      <ApiErrorState error={t.error ?? { code: "bad_response", message: "The API returned an unexpected response for this page.", hint: "Check the API base URL and that the server is up to date." }} />
    </>
  );
  return (
    <>
      {e && <div className="mb-4"><ApiErrorState error={e} /></div>}
      <TemplateDetail template={{ ...t.data, id: t.data.id ?? id }} initial={p.error ? { error: p.error } : { preview: Array.isArray(p.data) ? {} : p.data }} />
    </>
  );
}
