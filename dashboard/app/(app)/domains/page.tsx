import { get } from "@/lib/api";
import { parseErr } from "@/lib/err";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SetupChecklist } from "@/components/onboarding/checklist";
import { ErrorState, RetryError } from "@/components/ui/error-state";
import { AddDomain } from "./add-domain";
import { DomainCard, type Domain } from "./domain-card";
import { Tips } from "./tips";

export const dynamic = "force-dynamic";

export default async function Domains({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const actionErr = parseErr(err);
  const [r, k] = await Promise.all([get("/v1/domains"), get("/v1/keys")]);
  const list: Domain[] = r.data ?? [];
  return (
    <>
      <PageHeader title="Domains" description="Verify the domains you send from. Receivers trust mail that proves it comes from you." action={list.length ? <AddDomain /> : undefined} />
      <div className="grid gap-6">
        {actionErr && <ErrorState error={actionErr} />}
        {r.error ? <RetryError error={r.error} /> : !list.length ? (
          <>
            <EmptyState title="No domains yet" description="Add the domain you want to send from. You will get a handful of DNS records to publish, then we check them." action={<AddDomain label="Add your first domain" />} />
            <SetupChecklist steps={[
              { id: "domain", title: "Add and verify a domain", why: "Receivers only trust mail from a domain with SPF and DKIM.", href: "/domains", cta: "Add domain", done: false, time: "10 minutes" },
              { id: "key", title: "Create an API key", why: "Your app or agent uses it to send.", href: "/keys", cta: "Create key", done: !!k.data?.length, time: "1 minute" },
            ]} />
          </>
        ) : (
          <>
            {list.map((d) => <DomainCard key={d.id} d={d} />)}
            <Tips />
          </>
        )}
      </div>
    </>
  );
}
