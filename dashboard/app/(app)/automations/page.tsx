import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { ApiErrorState } from "../_p3/ApiErrorState";
import { parseErr } from "../_p3/err";
import { AutomationsList, type AutomationRow } from "./AutomationsList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automations" };

export default async function Automations({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const e = parseErr(err);
  const r = await get("/v1/automations");
  return (
    <>
      <PageHeader title="Automations" description="Lifecycle emails that run when a contact does something." />
      {e && <div className="mb-4"><ApiErrorState error={e} /></div>}
      {r.error ? <ApiErrorState error={r.error} /> : <AutomationsList automations={(Array.isArray(r.data) ? r.data : []) as AutomationRow[]} />}
    </>
  );
}
