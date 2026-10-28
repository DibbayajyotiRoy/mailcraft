"use client";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { ListPlus, Pencil, Plus, Trash2, UserPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { TypeNameConfirm } from "@/components/ui/type-name-confirm";
import { formatNumber } from "@/lib/format";
import { addToList, deleteList, removeFromList, saveList, type FormState } from "./actions";
import { AddMembers } from "./SegmentForm";
import { originLabel, pickableLists, type ListItem, type ListRef } from "./util";

/** The lists a contact is on, as small badges (a source's list reads "from <name>"). At most `max`, then "+N". */
export function ListBadges({ lists, max = 3 }: { lists?: ListRef[]; max?: number }) {
  if (!lists?.length) return null;
  return (
    <ul aria-label="Lists" className="flex flex-wrap gap-1">
      {lists.slice(0, max).map((l) => (
        <li key={l.id}>
          <Link href={`/contacts?list=${encodeURIComponent(l.id)}`} className="rounded-full focus-visible:outline-offset-1">
            <Badge size="sm" tone={l.origin === "source" ? "info" : "neutral"} className="hover:underline">{l.origin === "source" ? `from ${l.name}` : l.name}</Badge>
          </Link>
        </li>
      ))}
      {lists.length > max && <li><Tooltip content={lists.slice(max).map((l) => l.name).join(", ")}><span tabIndex={0}><Badge size="sm">+{lists.length - max}</Badge></span></Tooltip></li>}
    </ul>
  );
}

/** Add the given contacts to an existing list or to a new one named here. `children` is the trigger. */
export function AddToList({ ids, label, lists, children }: { ids: string[]; label: string; lists: ListItem[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent title="Add to a list" description={`${label}. They stay on every list they are already on.`}>
        <AddBody ids={ids} lists={pickableLists(lists)} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddBody({ ids, lists, close }: { ids: string[]; lists: ListItem[]; close: () => void }) {
  const [s, act] = useActionState<FormState, FormData>(addToList, {});
  const [pick, setPick] = useState(lists[0]?.id ?? "new");
  const [newName, setNewName] = useState(""); // controlled: a rejected add keeps it (React resets a <form action> once it settles)
  const seen = useRef<FormState>(undefined);
  useEffect(() => { if (s.ok && seen.current !== s) { seen.current = s; toast.success(s.ok); close(); } }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = lists.find((l) => l.id === pick)?.name ?? "";
  return (
    <form action={act} className="grid gap-4">
      {ids.map((id) => <input key={id} type="hidden" name="id" value={id} />)}
      <input type="hidden" name="list_label" value={label} />
      <Field label="List" error={s.error?.field === "list_id" ? s.error.message : undefined}>
        {(a) => (
          <Select {...a} name="list_id" value={pick} onChange={(e) => setPick(e.target.value)}>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({formatNumber(l.member_count)})</option>)}
            <option value="new">New list…</option>
          </Select>
        )}
      </Field>
      {pick === "new" && <Field label="New list name" error={s.error?.field === "new_name" ? s.error.message : undefined}>{(a) => <Input {...a} name="new_name" autoComplete="off" required placeholder="Webinar Oct 2026" value={newName} onChange={(e) => setNewName(e.target.value)} />}</Field>}
      {s.error && !["list_id", "new_name"].includes(s.error.field ?? "") && <ErrorState error={s.error} />}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
        <SubmitButton>Add {ids.length} {ids.length === 1 ? "contact" : "contacts"}</SubmitButton>
      </div>
    </form>
  );
}

function ListBody({ list, close }: { list?: ListItem; close: () => void }) {
  const [s, act] = useActionState<FormState, FormData>(saveList, {});
  const seen = useRef<FormState>(undefined);
  const [name, setName] = useState(list?.name ?? ""), [description, setDescription] = useState(list?.description ?? "");
  useEffect(() => { if (s.ok && seen.current !== s) { seen.current = s; toast.success(s.ok); close(); } }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form action={act} className="grid gap-4">
      {list && <input type="hidden" name="id" value={list.id} />}
      <Field label="Display name" error={s.error?.field === "name" ? s.error.message : undefined}>{(a) => <Input {...a} name="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="off" />}</Field>
      <Field label="Description" description="Optional. Where these people came from, or what the list is for.">{(a) => <Textarea {...a} name="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={500} />}</Field>
      {s.error && s.error.field !== "name" && <ErrorState error={s.error} />}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
        <SubmitButton>{list ? "Save changes" : "Create list"}</SubmitButton>
      </div>
    </form>
  );
}

/** Create (no `list`) or rename / describe a list. `children` is the trigger. */
export function ListDialog({ list, children }: { list?: ListItem; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent title={list ? `Edit ${list.name}` : "New list"} description="Lists group contacts by where they came from. A contact can be on many.">
        <ListBody list={list} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** The Lists tab: every list with where it came from, how many people are on it, and rename / add / delete. */
export function ListsTab({ lists }: { lists: ListItem[] }) {
  const [del, setDel] = useState<ListItem | null>(null);
  const create = (label: string) => <ListDialog><Button><Plus aria-hidden />{label}</Button></ListDialog>;
  if (!lists.length) {
    return <EmptyState title="No lists yet" description="A list keeps contacts grouped by where they came from: a CSV import, a contact source, or people you pick." action={create("Create your first list")} />;
  }
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">{create("New list")}</div>
      <Table caption="Lists">
        <THead><TR><TH>List</TH><TH>Origin</TH><TH className="text-right">Contacts</TH><TH>Created</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
        <TBody>
          {lists.map((l) => (
            <TR key={l.id}>
              <TD label="List">
                <Link href={`/contacts?list=${encodeURIComponent(l.id)}`} className="rounded-sm font-medium text-accent hover:underline">{l.name}</Link>
                {l.description && <p className="max-w-md text-xs text-muted">{l.description}</p>}
              </TD>
              <TD label="Origin"><Badge size="sm" tone={l.origin === "source" ? "info" : "neutral"}>{originLabel(l)}</Badge></TD>
              <TD label="Contacts" num>{formatNumber(l.member_count)}</TD>
              <TD label="Created">{l.created_at ? <RelativeTime value={l.created_at} className="text-muted" /> : <span className="text-subtle">-</span>}</TD>
              <TD label="Actions" className="max-md:pt-2">
                <span className="flex flex-wrap justify-end gap-1">
                  {!(l.origin === "source" && !l.detached) && <AddMembers segment={l}><Button variant="ghost" size="sm" aria-label={`Add contacts to ${l.name} by email`}><UserPlus aria-hidden />Add by email</Button></AddMembers>}
                  <ListDialog list={l}><Button variant="ghost" size="sm" aria-label={`Edit ${l.name}`}><Pencil aria-hidden />Edit</Button></ListDialog>
                  {l.origin === "source" && !l.detached
                    ? <Tooltip content="Fed by a contact source. Delete the source in Settings to remove this list."><span tabIndex={0}><Button variant="ghost" size="sm" disabled aria-label={`Delete ${l.name}`}><Trash2 aria-hidden />Delete</Button></span></Tooltip>
                    : <Button variant="ghost" size="sm" aria-label={`Delete ${l.name}`} onClick={() => setDel(l)}><Trash2 aria-hidden />Delete</Button>}
                </span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {del && (
        <TypeNameConfirm open onOpenChange={(o) => !o && setDel(null)} title="Delete this list?" expected={del.name} confirmLabel="Delete list"
          description={<>This deletes the list <strong>{del.name}</strong>. Its {formatNumber(del.member_count)} contacts are kept, and so are their suppressions.</>} action={deleteList} fields={{ id: del.id, name: del.name }} />
      )}
    </div>
  );
}

function RemoveChip({ contactId, list }: { contactId: string; list: ListRef }) {
  const [s, act] = useActionState<FormState, FormData>(removeFromList, {});
  const seen = useRef<FormState>(undefined);
  useEffect(() => {
    if (seen.current === s) return;
    seen.current = s;
    if (s.ok) toast.success(s.ok); else if (s.error) toast.error(s.error.message);
  }, [s]);
  return (
    <form action={act} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs font-medium">
      <input type="hidden" name="id" value={contactId} /><input type="hidden" name="list_id" value={list.id} /><input type="hidden" name="list_label" value={list.name} />
      <Link href={`/contacts?list=${encodeURIComponent(list.id)}`} className="hover:underline">{list.origin === "source" ? `from ${list.name}` : list.name}</Link>
      <SubmitButton variant="ghost" size="icon" aria-label={`Remove from ${list.name}`} className="size-5"><X aria-hidden className="size-3" /></SubmitButton>
    </form>
  );
}

/** The contact page's Lists card: the lists this person is on (removable) and an Add to list button. */
export function ContactLists({ contact, member, lists }: { contact: { id: string; email: string }; member: ListRef[]; lists: ListItem[] }) {
  const open = pickableLists(lists).filter((l) => !member.some((m) => m.id === l.id));
  return (
    <div className="grid gap-3">
      {member.length
        ? <ul aria-label="Lists" className="flex flex-wrap gap-2">{member.map((l) => <li key={l.id}><RemoveChip contactId={contact.id} list={l} /></li>)}</ul>
        : <p className="text-sm text-muted">Not on any list yet.</p>}
      <div><AddToList ids={[contact.id]} label={contact.email} lists={open}><Button variant="secondary" size="sm"><ListPlus aria-hidden />Add to list</Button></AddToList></div>
    </div>
  );
}
