import Link from "next/link";
import { Archive } from "lucide-react";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button-variants";
import { EmptyState } from "@/components/ui/empty-state";
import { RetryError } from "@/components/ui/error-state";
import { fromAutomation } from "../../editor/model";
import { Editor } from "../../editor/Editor";
import { loadOptions } from "../../editor/options";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit automation" };

export default async function EditAutomation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [a, { options, error }] = await Promise.all([get(`/v1/automations/${encodeURIComponent(id)}`), loadOptions()]);
  const name: string = a.data?.name ?? id;
  const crumb = [{ label: "Automations", href: "/automations" }, { label: name, href: `/automations/${encodeURIComponent(id)}` }, { label: "Edit" }];
  if (a.error || !a.data || Array.isArray(a.data)) return <><PageHeader breadcrumb={crumb} title="Edit automation" /><RetryError error={a.error ?? { code: "bad_response", message: "The API returned an unexpected response for this page." }} /></>;
  if (a.data.status === "archived") return (
    <>
      <PageHeader breadcrumb={crumb} title="Edit automation" />
      <EmptyState icon={Archive} title="This automation is archived" description="Restore it as a draft to change it." action={<Link href={`/automations/${encodeURIComponent(id)}`} className={buttonVariants({ variant: "secondary" })}>Back to the automation</Link>} />
    </>
  );
  return (
    <>
      <PageHeader breadcrumb={crumb} title={`Edit ${name}`} description={`Version ${a.data.current_version ?? a.data.version ?? 1}`} />
      {error && <div className="mb-4"><RetryError error={error} /></div>}
      <Editor mode="edit" id={a.data.id ?? id} status={a.data.status} version={a.data.current_version ?? a.data.version ?? 1} initial={fromAutomation(a.data)} options={options} stats={a.data.stats ?? {}} />
    </>
  );
}
