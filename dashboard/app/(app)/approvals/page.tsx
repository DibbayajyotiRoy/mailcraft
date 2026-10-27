import Link from "next/link";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { ApprovalsInbox, type Approval } from "@/components/emails/approvals-inbox";
import { RetryError } from "@/components/monitor/retry-error";
import { decideApproval } from "./actions";

export const dynamic = "force-dynamic";

export default async function Approvals({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const [r, st] = await Promise.all([get("/v1/approvals?status=pending&limit=100"), get("/v1/account/status")]);
  const canDecide: boolean = st.data?.scopes ? st.data.scopes.includes("admin") : true;
  const list: Approval[] = r.data ?? [];
  const [code, message, hint] = (err ?? "").split("|");
  return (
    <>
      <PageHeader title="Approvals" description={list.length ? `${list.length} waiting for a decision.` : "Emails held by a policy rule wait here."} />
      {err && <ErrorState className="mb-4" error={{ code, message: message || "The decision failed.", hint: hint || undefined }} />}
      {r.error ? <RetryError error={r.error} /> : !list.length ? (
        <EmptyState title="Nothing waiting" description="Emails that trip a policy rule land here." action={<Button asChild variant="secondary"><Link data-ui="link" href="/settings">Review policy in Settings</Link></Button>} />
      ) : <ApprovalsInbox approvals={list} canDecide={canDecide} decide={decideApproval} />}
    </>
  );
}
