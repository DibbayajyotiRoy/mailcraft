"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Pencil, Plus, Search, Trash2, UserPlus, Users } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/field";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { TypeNameConfirm } from "@/components/ui/type-name-confirm";
import { formatNumber } from "@/lib/format";
import { deleteSegment } from "./actions";
import { AddContact } from "./ContactForm";
import { ImportContacts } from "./ImportContacts";
import { AddMembers, SegmentDialog } from "./SegmentForm";
import { fullName, initials, isSuppressed, memberCount, segmentRule, type Contact, type Segment } from "./util";

export type { Contact, Segment };

function Avatar({ c }: { c: Contact }) {
  return <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-medium text-accent">{initials(c)}</span>;
}

export function SuppressedBadge({ c }: { c: Contact }) {
  const reason = c.suppression_reason?.replace(/_/g, " ");
  const badge = <Badge tone="bad" size="sm" className="border border-bad" tabIndex={reason ? 0 : undefined}>suppressed</Badge>;
  return reason ? <Tooltip content={reason}>{badge}</Tooltip> : badge;
}

function ContactsTab({ contacts, error, search }: { contacts: Contact[] | null; error: ApiError | null; search: string }) {
  if (error || !contacts) return <ErrorState error={error ?? { code: "unknown", message: "Contacts could not be loaded." }} />;
  if (!contacts.length && !search) {
    return (
      <EmptyState icon={Users} title="No contacts yet" description="Add people one at a time, import a CSV, or let your app create them when it sends an event or an email."
        action={<div className="flex flex-wrap justify-center gap-2"><AddContact label="Add your first contact" /><ImportContacts /></div>} />
    );
  }
  return (
    <div className="grid gap-4">
      <form action="/contacts" method="get" role="search" className="relative w-full max-w-sm">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <Input type="search" name="q" aria-label="Search contacts" placeholder="Search by email or name, then Enter" className="pl-9" defaultValue={search} />
      </form>
      <p role="status" className="sr-only">{contacts.length} contacts{search ? ` matching ${search}` : ""}</p>
      {!contacts.length ? (
        <EmptyState variant="no-results" title="No contacts match" description={`No contact has “${search}” in their email or name.`} action={<Button asChild variant="secondary"><a href="/contacts">Clear search</a></Button>} />
      ) : (
        <Table caption="Contacts">
          <THead><TR><TH>Contact</TH><TH>Name</TH><TH>Status</TH><TH>Added</TH></TR></THead>
          <TBody>
            {contacts.map((c) => (
              <TR key={c.id ?? c.email}>
                <TD label="Contact">
                  <span className="inline-flex items-center gap-2"><Avatar c={c} />
                    <Link href={`/contacts/${encodeURIComponent(c.id ?? c.email)}`} className="rounded-sm font-medium text-accent hover:underline">{c.email}</Link>
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
    </div>
  );
}

function SegmentsTab({ segments, error, events, attrs }: { segments: Segment[] | null; error: ApiError | null; events: string[]; attrs: string[] }) {
  const [del, setDel] = useState<Segment | null>(null);
  if (error || !segments) return <ErrorState error={error ?? { code: "unknown", message: "Segments could not be loaded." }} />;
  const names = segments.map((s) => s.name);
  const create = (label: string) => <SegmentDialog names={names} events={events} attrs={attrs}><Button><Plus aria-hidden />{label}</Button></SegmentDialog>;
  if (!segments.length) {
    return <EmptyState icon={Users} title="No segments yet" description="A segment is a saved group of contacts, like everyone on the pro plan or anyone who has not logged in for 30 days." action={create("Create your first segment")} />;
  }
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">{create("New segment")}</div>
      <Table caption="Segments">
        <THead><TR><TH>Segment</TH><TH>Who is in it</TH><TH className="text-right">Members</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
        <TBody>
          {segments.map((s) => {
            const n = memberCount(s);
            return (
              <TR key={s.id}>
                <TD label="Segment"><span className="font-medium">{s.name}</span></TD>
                <TD label="Who is in it" className="max-md:text-right md:max-w-md">{segmentRule(s)}</TD>
                <TD label="Members" num>{n != null ? formatNumber(n) : <Tooltip content="The API does not report member counts for this segment yet"><span tabIndex={0} className="text-subtle">-</span></Tooltip>}</TD>
                <TD label="Actions" className="max-md:pt-2">
                  <span className="flex flex-wrap justify-end gap-1">
                    {!s.filter && <AddMembers segment={s}><Button variant="ghost" size="sm" aria-label={`Add contacts to ${s.name}`}><UserPlus aria-hidden />Add contacts</Button></AddMembers>}
                    <SegmentDialog segment={s} names={names} events={events} attrs={attrs}><Button variant="ghost" size="sm" aria-label={`Edit ${s.name}`}><Pencil aria-hidden />Edit</Button></SegmentDialog>
                    <Button variant="ghost" size="sm" aria-label={`Delete ${s.name}`} onClick={() => setDel(s)}><Trash2 aria-hidden />Delete</Button>
                  </span>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      {del && (
        <TypeNameConfirm open onOpenChange={(o) => !o && setDel(null)} title="Delete this segment?" expected={del.name} confirmLabel="Delete segment"
          description={<>This deletes <strong>{del.name}</strong>. The contacts in it are kept. It cannot be deleted while an automation uses it.</>} action={deleteSegment} fields={{ id: del.id, name: del.name }} />
      )}
    </div>
  );
}

export function ContactsView({ contacts, segments, contactsError, segmentsError, tab, search = "", events = [] }: {
  search?: string; contacts: Contact[] | null; segments: Segment[] | null; contactsError: ApiError | null; segmentsError: ApiError | null; tab: "contacts" | "segments"; events?: string[];
}) {
  const [value, setValue] = useState(tab);
  const attrs = useMemo(() => [...new Set((contacts ?? []).flatMap((c) => Object.keys(c.properties ?? {})))].sort(), [contacts]);
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
      <TabsContent value="contacts"><ContactsTab contacts={contacts} error={contactsError} search={search} /></TabsContent>
      <TabsContent value="segments"><SegmentsTab segments={segments} error={segmentsError} events={events} attrs={attrs} /></TabsContent>
    </Tabs>
  );
}
