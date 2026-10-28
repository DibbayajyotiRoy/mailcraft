import Link from "next/link";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { ErrorState, RetryError } from "@/components/ui/error-state";
import { parseErr } from "@/lib/err";
import { ApprovalsInbox, type Approval } from "@/components/emails/approvals-inbox";
import { decideApproval } from "./actions";

export const dynamic = "force-dynamic";

export default async function Approvals({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const [r, st] = await Promise.all([get("/v1/approvals?status=pending&limit=100"), get("/v1/account/status")]);
  const canDecide: boolean = st.data?.scopes ? st.data.scopes.includes("admin") : true;
  const list: Approval[] = r.data ?? [];
  const actionErr = parseErr(err);
  return (
    <>
      <PageHeader title="Approvals" description={list.length ? `${list.length} waiting for a decision.` : "Emails held by a policy rule wait here."} />
      {actionErr && <ErrorState className="mb-4" error={actionErr} />}
      {r.error ? <RetryError error={r.error} /> : !list.length ? (
        <EmptyState title="Nothing waiting" description="Emails that trip a policy rule land here." action={<Button asChild variant="secondary"><Link href="/settings">Review policy in Settings</Link></Button>} />
      ) : <ApprovalsInbox approvals={list} canDecide={canDecide} decide={decideApproval} />}
    </>
  );
}
