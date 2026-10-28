import Link from "next/link";
import { Plus } from "lucide-react";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button-variants";
import { RetryError } from "@/components/ui/error-state";
import { parseErr } from "@/lib/err";
import { AutomationsList, type AutomationRow } from "./AutomationsList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automations" };

export default async function Automations({ searchParams }: { searchParams: Promise<{ err?: string; archived?: string }> }) {
  const { err, archived } = await searchParams;
  const e = parseErr(err);
  const r = await get(archived ? "/v1/automations?status=archived" : "/v1/automations");
  return (
    <>
      <PageHeader title="Automations" description="Lifecycle emails that run when a contact does something."
        action={<Link href="/automations/new" className={buttonVariants()}><Plus aria-hidden />New automation</Link>} />
      {e && <div className="mb-4"><RetryError error={e} /></div>}
      {r.error ? <RetryError error={r.error} /> : <AutomationsList automations={(Array.isArray(r.data) ? r.data : []) as AutomationRow[]} archived={!!archived} />}
      <p className="mt-4 text-sm"><Link href={archived ? "/automations" : "/automations?archived=1"} className="text-muted hover:text-fg hover:underline">{archived ? "Back to automations" : "Show archived"}</Link></p>
    </>
  );
}
