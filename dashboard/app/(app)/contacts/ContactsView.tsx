"use client";
import Link from "next/link";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { ListMinus, ListPlus, Pencil, Plus, Search, Trash2, UserPlus, Users } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button, SubmitButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/field";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { TypeNameConfirm } from "@/components/ui/type-name-confirm";
import { formatNumber } from "@/lib/format";
import { deleteSegment, removeFromList, type FormState } from "./actions";
import { AddContact } from "./ContactForm";
import { ImportContacts } from "./ImportContacts";
import { AddToList, ListBadges, ListsTab } from "./ListsUI";
import { AddMembers, SegmentDialog } from "./SegmentForm";
import { cn } from "@/lib/cn";
import { fullName, initials, isSuppressed, memberCount, segmentRule, type Contact, type ListItem, type Segment } from "./util";

export type { Contact, Segment };

function Avatar({ c }: { c: Contact }) {
  return <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-medium text-accent">{initials(c)}</span>;
}

export function SuppressedBadge({ c }: { c: Contact }) {
  const reason = c.suppression_reason?.replace(/_/g, " ");
  const badge = <Badge tone="bad" size="sm" className="border border-bad" tabIndex={reason ? 0 : undefined}>suppressed</Badge>;
  return reason ? <Tooltip content={reason}>{badge}</Tooltip> : badge;
}

/** "All contacts" and one chip per list with its count. Plain links: the list is part of the URL, so it survives reloads and sharing. */
function ListFilter({ lists, active, search }: { lists: ListItem[]; active?: string; search: string }) {
  if (!lists.length) return null;
  const href = (id?: string) => {
    const qs = new URLSearchParams({ ...(id ? { list: id } : {}), ...(search ? { q: search } : {}) }).toString();
    return qs ? `/contacts?${qs}` : "/contacts";
  };
  const chip = (on: boolean) => cn("inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm transition-colors duration-[var(--dur-fast)] pointer-coarse:h-11",
    on ? "border-accent bg-accent-soft font-medium text-fg" : "border-border text-muted hover:bg-surface-2 hover:text-fg");
  return (
    <nav aria-label="Filter by list" className="-mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex gap-2">
        <li><Link href={href()} aria-current={!active ? "page" : undefined} className={chip(!active)}>All contacts</Link></li>
        {lists.map((l) => (
          <li key={l.id}><Link href={href(l.id)} aria-current={active === l.id ? "page" : undefined} className={chip(active === l.id)}>{l.name}<span className="text-xs tabular-nums text-subtle">{formatNumber(l.member_count)}</span></Link></li>
        ))}
      </ul>
    </nav>
  );
}

/** Shown while rows are ticked: add them to a list, or (inside a list) take them off it. */
function BulkBar({ ids, contacts, lists, active, clear }: { ids: string[]; contacts: Contact[]; lists: ListItem[]; active?: ListItem; clear: () => void }) {
  const [s, act] = useActionState<FormState, FormData>(removeFromList, {});
  const seen = useRef<FormState>(undefined);
  useEffect(() => {
    if (seen.current === s) return;
    seen.current = s;
    if (s.ok) { toast.success(s.ok); clear(); } else if (s.error) toast.error(s.error.message);
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = ids.length, who = n === 1 ? contacts.find((c) => c.id === ids[0])?.email ?? "1 contact" : `${n} contacts`;
  return (
    <div role="region" aria-label="Selected contacts" className="flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-accent-soft px-3 py-2 text-sm">
      <span className="mr-auto font-medium" role="status">{n} selected</span>
      <AddToList ids={ids} label={who} lists={lists}><Button variant="secondary" size="sm"><ListPlus aria-hidden />Add to list</Button></AddToList>
      {active && (
        <form action={act}>
          {ids.map((id) => <input key={id} type="hidden" name="id" value={id} />)}
          <input type="hidden" name="list_id" value={active.id} /><input type="hidden" name="list_label" value={active.name} />
          <SubmitButton variant="secondary" size="sm"><ListMinus aria-hidden />Remove from {active.name}</SubmitButton>
        </form>
      )}
      <Button variant="ghost" size="sm" onClick={clear}>Clear</Button>
    </div>
  );
}

function ContactsTab({ contacts, error, search, lists, activeList }: { contacts: Contact[] | null; error: ApiError | null; search: string; lists: ListItem[]; activeList?: string }) {
  const [picked, setPicked] = useState<string[]>([]);
  if (error || !contacts) return <ErrorState error={error ?? { code: "unknown", message: "Contacts could not be loaded." }} />;
  const active = lists.find((l) => l.id === activeList);
  const filtered = !!activeList;
  if (!contacts.length && !search && !filtered) {
    return (
      <EmptyState icon={Users} title="No contacts yet" description="Add people one at a time, import a CSV, or let your app create them when it sends an event or an email."
        action={<div className="flex flex-wrap justify-center gap-2"><AddContact label="Add your first contact" /><ImportContacts lists={lists} /></div>} />
    );
  }
  const ids = contacts.flatMap((c) => (c.id ? [c.id] : []));
  // Ticks only count for people on screen: after a list, search or page change the old ones are gone from view.
  const sel = picked.filter((id) => ids.includes(id));
  const all = ids.length > 0 && ids.every((id) => sel.includes(id));
  const toggle = (id: string) => setPicked((p) => (sel.includes(id) ? p.filter((x) => x !== id) : [...sel, id]));
  return (
    <div className="grid gap-4">
      <ListFilter lists={lists} active={activeList} search={search} />
      <form action="/contacts" method="get" role="search" className="relative w-full max-w-sm">
        {activeList && <input type="hidden" name="list" value={activeList} />}
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <Input type="search" name="q" aria-label="Search contacts" placeholder={active ? `Search ${active.name}, then Enter` : "Search by email or name, then Enter"} className="pl-9" defaultValue={search} />
      </form>
      <p role="status" className="sr-only">{contacts.length} contacts{search ? ` matching ${search}` : ""}{active ? ` on ${active.name}` : ""}</p>
      {sel.length > 0 && <BulkBar ids={sel} contacts={contacts} lists={lists} active={active} clear={() => setPicked([])} />}
      {!contacts.length ? (
        <EmptyState variant="no-results" title={filtered && !search ? "Nobody is on this list yet" : "No contacts match"}
          description={filtered && !search ? "Tick contacts on All contacts and choose Add to list, or import a CSV into it." : `No contact has “${search}” in their email or name.`}
          action={<Button asChild variant="secondary"><a href={activeList ? `/contacts?list=${encodeURIComponent(activeList)}` : "/contacts"}>{search ? "Clear search" : "All contacts"}</a></Button>} />
      ) : (
        <Table caption={active ? `Contacts on ${active.name}` : "Contacts"}>
          <THead><TR>
            <TH className="w-10"><input type="checkbox" aria-label="Select all contacts on this page" className="size-4 accent-[var(--accent)]" checked={all} onChange={() => setPicked(all ? [] : ids)} /></TH>
            <TH>Contact</TH><TH>Name</TH><TH>Lists</TH><TH>Status</TH><TH>Added</TH></TR></THead>
          <TBody>
            {contacts.map((c) => (
              <TR key={c.id ?? c.email} className={cn(c.id && sel.includes(c.id) && "bg-accent-soft")}>
                <TD label="Select">{c.id && <input type="checkbox" aria-label={`Select ${c.email}`} className="size-4 accent-[var(--accent)]" checked={sel.includes(c.id)} onChange={() => toggle(c.id!)} />}</TD>
                <TD label="Contact">
                  <span className="inline-flex items-center gap-2"><Avatar c={c} />
                    <Link href={`/contacts/${encodeURIComponent(c.id ?? c.email)}`} className="rounded-sm font-medium text-accent hover:underline">{c.email}</Link>
                  </span>
                </TD>
                <TD label="Name">{fullName(c) || <span className="text-subtle">-</span>}</TD>
                <TD label="Lists">{c.lists?.length ? <ListBadges lists={c.lists} /> : <span className="text-subtle">-</span>}</TD>
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

export function ContactsView({ contacts, segments, lists = [], contactsError, segmentsError, tab, search = "", events = [], activeList }: {
  search?: string; contacts: Contact[] | null; segments: Segment[] | null; lists?: ListItem[]; contactsError: ApiError | null; segmentsError: ApiError | null;
  tab: "contacts" | "lists" | "segments"; events?: string[]; activeList?: string;
}) {
  const [value, setValue] = useState(tab);
  const attrs = useMemo(() => [...new Set((contacts ?? []).flatMap((c) => Object.keys(c.properties ?? {})))].sort(), [contacts]);
  // Lists are the manual segments; the Segments tab keeps the rule-based ones.
  const rules = useMemo(() => (segments ? segments.filter((s) => s.filter) : null), [segments]);
  function change(v: string) {
    setValue(v as typeof tab);
    const u = new URL(window.location.href);
    if (v === "contacts") u.searchParams.delete("tab"); else u.searchParams.set("tab", v);
    window.history.replaceState(null, "", u);
  }
  return (
    <Tabs value={value} onValueChange={change}>
      <TabsList aria-label="Contacts sections">
        <TabsTrigger value="contacts">Contacts{contacts && <span className="ml-1.5 text-xs text-subtle">{contacts.length}</span>}</TabsTrigger>
        <TabsTrigger value="lists">Lists<span className="ml-1.5 text-xs text-subtle">{lists.length}</span></TabsTrigger>
        <TabsTrigger value="segments">Segments{rules && <span className="ml-1.5 text-xs text-subtle">{rules.length}</span>}</TabsTrigger>
      </TabsList>
      <TabsContent value="contacts"><ContactsTab contacts={contacts} error={contactsError} search={search} lists={lists} activeList={activeList} /></TabsContent>
      <TabsContent value="lists"><ListsTab lists={lists} /></TabsContent>
      <TabsContent value="segments"><SegmentsTab segments={rules} error={segmentsError} events={events} attrs={attrs} /></TabsContent>
    </Tabs>
  );
}
