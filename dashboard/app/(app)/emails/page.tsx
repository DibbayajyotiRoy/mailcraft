import Link from "next/link";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { RelativeTime } from "@/components/ui/relative-time";
import { EmailFilters } from "@/components/emails/email-filters";
import { EmailsTable } from "@/components/emails/emails-table";
import { Peek } from "@/components/emails/peek";
import { EmailTrail, PolicyDecisions, type MailEvent } from "@/components/emails/trail";
import { RetryError } from "@/components/monitor/retry-error";
import { emailsHref, filterEmails, type EmailQuery } from "@/components/monitor/helpers";

export const dynamic = "force-dynamic";

export default async function Emails({ searchParams }: { searchParams: Promise<EmailQuery> }) {
  const query = await searchParams;
  const { status, cursor, open } = query;
  const narrowed = !!(query.q || query.from || query.to);
  const q = new URLSearchParams({ limit: narrowed ? "100" : "25" }); // text/date filters narrow the fetched page, so fetch a wider one
  if (status) q.set("status", status);
  if (cursor) q.set("cursor", cursor);
  const [r, peek, peekEv] = await Promise.all([
    get(`/v1/emails?${q}`),
    open ? get(`/v1/emails/${encodeURIComponent(open)}`) : null,
    open ? get(`/v1/emails/${encodeURIComponent(open)}/events`) : null,
  ]);
  const header = <PageHeader title="Emails" description="Every message you send, and what happened to it." />;
  if (r.error) return <>{header}<EmailFilters query={query} /><RetryError error={r.error} /></>;

  const all: any[] = r.data ?? [];
  const rows = filterEmails(all, query);
  const filtered = !!(status || narrowed);
  const pe = peek?.data;
  return (
    <>
      {header}
      <EmailFilters query={query} />
      {!rows.length ? (
        filtered || cursor ? (
          <EmptyState variant="no-results" title="No emails match" description={all.length ? `${all.length} loaded emails were checked; try a wider search or date range.` : "Nothing matches these filters."}
            action={<Button asChild variant="secondary"><Link data-ui="link" href="/emails">Clear filters</Link></Button>} />
        ) : (
          <EmptyState title="No emails yet" description="Send your first email via the API. It appears here within seconds."
            action={<div className="grid w-full max-w-lg gap-3 text-left"><CodeBlock language="bash" code={'curl -X POST $MAILCRAFT_API_URL/v1/emails \\\n  -H "Authorization: Bearer $MAILCRAFT_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"from":"you@yourdomain.com","to":"test@example.com","subject":"Hello","text":"It works."}\''} />
              <Button asChild variant="primary" className="justify-self-center"><Link data-ui="link" href="/keys">Create an API key</Link></Button></div>} />
        )
      ) : (
        <>
          <EmailsTable rows={rows} query={query} />
          <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3 text-sm">
            <span className="text-muted">{rows.length} {rows.length === 1 ? "email" : "emails"}{rows.length !== all.length && ` of ${all.length} loaded`}</span>
            <span className="flex gap-2">
              {cursor && <Button asChild variant="secondary"><Link data-ui="link" href={emailsHref(query, { cursor: undefined, open: undefined })}>First page</Link></Button>}
              {r.next_cursor && <Button asChild variant="secondary"><Link data-ui="link" rel="next" href={emailsHref(query, { cursor: r.next_cursor, open: undefined })}>Next page</Link></Button>}
            </span>
          </nav>
        </>
      )}
      {open && (
        <Peek query={query} title={pe?.subject || "Email"}>
          {peek?.error ? <RetryError error={peek.error} /> : pe && (
            <div className="grid gap-5">
              <div>
                <h2 className="pr-10 text-md font-semibold">{pe.subject || "(no subject)"}</h2>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted"><StatusBadge status={pe.status} /><RelativeTime value={pe.created_at} /></p>
                <p className="mt-2 break-all font-mono text-xs text-muted">{pe.from_addr} to {pe.to_addr}</p>
              </div>
              <CopyField value={pe.id} label="message ID" />
              <section aria-labelledby="pk-t"><h3 id="pk-t" className="mb-3 text-sm font-medium">Delivery timeline</h3>
                {peekEv?.error ? <RetryError error={peekEv.error} /> : <EmailTrail events={(peekEv?.data as MailEvent[]) ?? []} status={pe.status} approvalHref="/approvals" label="Delivery timeline (peek)" />}
              </section>
              <section aria-labelledby="pk-p"><h3 id="pk-p" className="mb-3 text-sm font-medium">Policy decisions</h3><PolicyDecisions decisions={pe.policy_decisions ?? []} /></section>
              <Button asChild variant="primary" className="justify-self-start"><Link data-ui="link" href={`/emails/${encodeURIComponent(pe.id)}`}>Open full page</Link></Button>
            </div>
          )}
        </Peek>
      )}
    </>
  );
}
