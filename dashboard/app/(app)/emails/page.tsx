import Link from "next/link";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { RelativeTime } from "@/components/ui/relative-time";
import { ComposeEmail } from "@/components/emails/compose";
import { EmailFilters } from "@/components/emails/email-filters";
import { EmailsTable } from "@/components/emails/emails-table";
import { Peek } from "@/components/emails/peek";
import { EmailTrail, PolicyDecisions, type MailEvent } from "@/components/emails/trail";
import { RetryError } from "@/components/ui/error-state";
import { MessagePreview } from "@/components/monitor/message-preview";
import { emailsHref, type EmailQuery } from "@/components/monitor/helpers";
import { initialFrom, sendersOf } from "@/lib/senders";
import { createContact, findContact, searchContacts, sendEmail } from "./actions";

export const dynamic = "force-dynamic";

export default async function Emails({ searchParams }: { searchParams: Promise<EmailQuery> }) {
  const query = await searchParams;
  const { status, cursor, open } = query;
  const q = new URLSearchParams({ limit: "25" });
  for (const k of ["status", "q", "from", "to"] as const) if (query[k]) q.set(k, query[k]!); // filtered by the API
  if (cursor) q.set("cursor", cursor);
  const [r, peek, peekEv, settings, tpls, snd] = await Promise.all([
    get(`/v1/emails?${q}`),
    open ? get(`/v1/emails/${encodeURIComponent(open)}`) : null,
    open ? get(`/v1/emails/${encodeURIComponent(open)}/events`) : null,
    get("/v1/settings"),
    get("/v1/templates"),
    get("/v1/senders"),
  ]);
  const senders = sendersOf(snd);
  const compose = <ComposeEmail defaultFrom={initialFrom(settings.data?.default_from, senders)} senders={senders} templates={Array.isArray(tpls.data) ? tpls.data : []} send={sendEmail} contacts={{ search: searchContacts, find: findContact, create: createContact }} />;
  const header = <PageHeader title="Emails" description="Every message you send, and what happened to it." action={compose} />;
  if (r.error) return <>{header}<EmailFilters query={query} /><RetryError error={r.error} /></>;

  const rows: any[] = r.data ?? [];
  const filtered = !!(status || query.q || query.from || query.to);
  const pe = peek?.data;
  return (
    <>
      {header}
      <EmailFilters query={query} />
      {!rows.length ? (
        filtered || cursor ? (
          <EmptyState variant="no-results" title="No emails match" description="Nothing matches these filters. Try a wider search or date range."
            action={<Button asChild variant="secondary"><Link href="/emails">Clear filters</Link></Button>} />
        ) : (
          <EmptyState title="No emails yet" description="Send your first email via the API. It appears here within seconds."
            action={<div className="grid w-full max-w-lg gap-3 text-left"><CodeBlock language="bash" code={'curl -X POST $MAILCRAFT_API_URL/v1/emails \\\n  -H "Authorization: Bearer $MAILCRAFT_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"from":"you@yourdomain.com","to":"test@example.com","subject":"Hello","text":"It works."}\''} />
              <Button asChild variant="primary" className="justify-self-center"><Link href="/keys">Create an API key</Link></Button></div>} />
        )
      ) : (
        <>
          <EmailsTable rows={rows} query={query} />
          <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3 text-sm">
            <span className="text-muted">{rows.length} {rows.length === 1 ? "email" : "emails"}</span>
            <span className="flex gap-2">
              {cursor && <Button asChild variant="secondary"><Link href={emailsHref(query, { cursor: undefined, open: undefined })}>First page</Link></Button>}
              {r.next_cursor && <Button asChild variant="secondary"><Link rel="next" href={emailsHref(query, { cursor: r.next_cursor, open: undefined })}>Next page</Link></Button>}
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
              <section aria-labelledby="pk-m"><h3 id="pk-m" className="mb-3 text-sm font-medium">Message</h3><MessagePreview html={pe.html} text={pe.text} title={`Preview of ${pe.subject || "email"}`} /></section>
              <section aria-labelledby="pk-t"><h3 id="pk-t" className="mb-3 text-sm font-medium">Delivery timeline</h3>
                {peekEv?.error ? <RetryError error={peekEv.error} /> : <EmailTrail events={(peekEv?.data as MailEvent[]) ?? []} status={pe.status} approvalHref="/approvals" label="Delivery timeline (peek)" />}
              </section>
              <section aria-labelledby="pk-p"><h3 id="pk-p" className="mb-3 text-sm font-medium">Policy decisions</h3><PolicyDecisions decisions={pe.policy_decisions ?? []} /></section>
              <Button asChild variant="primary" className="justify-self-start"><Link href={`/emails/${encodeURIComponent(pe.id)}`}>Open full page</Link></Button>
            </div>
          )}
        </Peek>
      )}
    </>
  );
}
