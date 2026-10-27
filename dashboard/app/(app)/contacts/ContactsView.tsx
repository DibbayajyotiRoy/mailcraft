"use client";
import { useMemo, useState } from "react";
import { Search, Users } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/field";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/format";
import { ContactDrawer } from "./ContactDrawer";
import { fullName, initials, isSuppressed, matches, memberCount, segmentRule, type Contact, type Segment } from "./util";

export type { Contact, Segment };

function Avatar({ c }: { c: Contact }) {
  return <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-medium text-accent">{initials(c)}</span>;
}

export function SuppressedBadge({ c }: { c: Contact }) {
  const badge = <Badge tone="bad" size="sm" className="border border-bad" tabIndex={c.suppression_reason ? 0 : undefined}>suppressed</Badge>;
  return c.suppression_reason ? <Tooltip content={c.suppression_reason}>{badge}</Tooltip> : badge;
}

function ContactsTab({ contacts, error }: { contacts: Contact[] | null; error: ApiError | null }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Contact | null>(null);
  const shown = useMemo(() => (contacts ?? []).filter((c) => matches(c, q)), [contacts, q]);
  if (error || !contacts) return <ErrorState error={error ?? { code: "unknown", message: "Contacts could not be loaded." }} />;
  if (!contacts.length) {
    return (
      <div className="mx-auto grid max-w-2xl gap-4">
        <EmptyState icon={Users} title="No contacts yet" description="Contacts arrive through the API, the CLI, or when an event names an email address. Add your first one:" className="border-0 pb-2" />
        <CopyField value="mailcraft contacts upsert ana@example.com --first-name Ana" label="upsert command" />
        <CodeBlock language="bash" code={`curl -X PUT $MAILCRAFT_API_URL/v1/contacts \\\n  -H "Authorization: Bearer $MAILCRAFT_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"email":"ana@example.com","first_name":"Ana"}'`} />
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div className="relative w-full max-w-sm">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <Input type="search" aria-label="Search contacts" placeholder="Search by email or name" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p role="status" className="sr-only">{shown.length} of {contacts.length} contacts</p>
      {!shown.length ? (
        <EmptyState variant="no-results" title="No contacts match" description={`Nothing on this page matches “${q}”.`} action={<Button variant="secondary" onClick={() => setQ("")}>Clear search</Button>} />
      ) : (
        <Table caption="Contacts">
          <THead><TR><TH>Contact</TH><TH>Name</TH><TH>Status</TH><TH>Added</TH></TR></THead>
          <TBody>
            {shown.map((c) => (
              <TR key={c.id ?? c.email}>
                <TD label="Contact">
                  <span className="inline-flex items-center gap-2"><Avatar c={c} />
                    <button type="button" data-ui="link" onClick={() => setOpen(c)} aria-haspopup="dialog" className="rounded-sm text-left font-medium text-accent hover:underline">{c.email}</button>
                  </span>
                </TD>
                <TD label="Name">{fullName(c) || <span className="text-subtle">-</span>}</TD>
                <TD label="Status">{isSuppressed(c) ? <SuppressedBadge c={c} /> : c.status ? <StatusBadge status={c.status} size="sm" /> : <StatusBadge status="active" size="sm" />}</TD>
                <TD label="Added">{c.created_at ? <RelativeTime value={c.created_at} className="text-muted" /> : <span className="text-subtle">-</span>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <ContactDrawer contact={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function SegmentsTab({ segments, error }: { segments: Segment[] | null; error: ApiError | null }) {
  if (error || !segments) return <ErrorState error={error ?? { code: "unknown", message: "Segments could not be loaded." }} />;
  if (!segments.length) {
    return (
      <div className="mx-auto grid max-w-2xl gap-4">
        <EmptyState icon={Users} title="No segments yet" description="A segment is a saved filter over your contacts, e.g. everyone on the pro plan. Create one with the API:" className="border-0 pb-2" />
        <CodeBlock language="bash" code={`curl -X POST $MAILCRAFT_API_URL/v1/segments \\\n  -H "Authorization: Bearer $MAILCRAFT_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"pro","filter":{"field":"contact.plan","op":"eq","value":"pro"}}'`} />
      </div>
    );
  }
  return (
    <Table caption="Segments">
      <THead><TR><TH>Segment</TH><TH>Who is in it</TH><TH className="text-right">Members</TH></TR></THead>
      <TBody>
        {segments.map((s) => {
          const n = memberCount(s);
          return (
            <TR key={s.id}>
              <TD label="Segment"><span className="font-medium">{s.name}</span></TD>
              <TD label="Who is in it" className="max-md:text-right md:max-w-md">{segmentRule(s)}</TD>
              <TD label="Members" num>{n != null ? formatNumber(n) : <Tooltip content="The API does not report member counts for this segment yet"><span tabIndex={0} className="text-subtle">-</span></Tooltip>}</TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

export function ContactsView({ contacts, segments, contactsError, segmentsError, tab }: {
  contacts: Contact[] | null; segments: Segment[] | null; contactsError: ApiError | null; segmentsError: ApiError | null; tab: "contacts" | "segments";
}) {
  const [value, setValue] = useState(tab);
  function change(v: string) {
    setValue(v as typeof tab);
    const u = new URL(window.location.href);
    if (v === "segments") u.searchParams.set("tab", "segments"); else u.searchParams.delete("tab");
    window.history.replaceState(null, "", u);
  }
  return (
    <Tabs value={value} onValueChange={change}>
      <TabsList aria-label="Contacts sections">
        <TabsTrigger value="contacts">Contacts{contacts && <span className="ml-1.5 text-xs text-subtle">{contacts.length}</span>}</TabsTrigger>
        <TabsTrigger value="segments">Segments{segments && <span className="ml-1.5 text-xs text-subtle">{segments.length}</span>}</TabsTrigger>
      </TabsList>
      <TabsContent value="contacts"><ContactsTab contacts={contacts} error={contactsError} /></TabsContent>
      <TabsContent value="segments"><SegmentsTab segments={segments} error={segmentsError} /></TabsContent>
    </Tabs>
  );
}
