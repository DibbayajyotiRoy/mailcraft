"use client";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { CircleCheck, CircleX, Eye, Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button, SubmitButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { TypeNameConfirm } from "@/components/ui/type-name-confirm";
import { ContactDiff, type PreviewRow, type PreviewSummary } from "../contacts/ContactDiff";
import { formatNumber } from "@/lib/format";
import { deleteSource, previewSource, saveSource, syncSource, testSource, toggleSource, type Result, type SourcePreview } from "./actions";

export type Source = {
  id: string; name: string; url: string; enabled: boolean; interval_minutes: number; full_sync_hours: number; last_full_at?: string | null;
  last_run_at?: string | null; last_status?: "ok" | "error" | null; last_error?: string | null; created_at?: string;
  last_counts?: { created?: number; updated?: number; skipped?: number; deleted?: number; fetched?: number; reasons?: Record<string, number> } | null;
  list?: { id: string; name: string } | null;
};

const every = (m: number) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? "hour" : "hours"}` : `${m} ${m === 1 ? "minute" : "minutes"}`);

/** Inline result of a one-shot action (aria-live so a failure is read out, not only coloured). */
function Outcome({ s }: { s: Result }) {
  return (
    <span role="status" aria-live="polite" className="text-sm">
      {s.ok && <span className="inline-flex items-center gap-1 text-ok"><CircleCheck aria-hidden className="size-4 shrink-0" />{s.ok}</span>}
      {s.error && <span className="inline-flex items-center gap-1 text-bad"><CircleX aria-hidden className="size-4 shrink-0" />{s.error}</span>}
    </span>
  );
}

function EnabledSwitch({ source }: { source: Source }) {
  const [s, act, pending] = useActionState(toggleSource, {} as Result);
  const [on, setOn] = useState(source.enabled);
  const [, start] = useTransition();
  const seen = useRef<Result>(undefined);
  useEffect(() => { setOn(source.enabled); }, [source.enabled]);
  useEffect(() => {
    if (seen.current === s) return;
    seen.current = s;
    if (s.ok) toast.success(s.ok); else if (s.error) { toast.error(s.error); setOn(source.enabled); }
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="inline-flex items-center gap-2 text-sm text-muted">
      <Switch checked={on} disabled={pending} aria-label={`Sync ${source.name} automatically`}
        onCheckedChange={(v) => { setOn(v); start(() => { const d = new FormData(); d.set("id", source.id); d.set("enabled", String(v)); act(d); }); }} />
      {on ? "On" : "Paused"}
    </label>
  );
}

function ActionButton({ source, action, label, icon: Icon, done }: { source: Source; action: typeof testSource; label: string; icon: typeof Plug; done?: boolean }) {
  const [s, act] = useActionState(action, {} as Result);
  return (
    <form action={act} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={source.id} />
      <SubmitButton size="sm" variant="secondary" aria-label={`${label} ${source.name}`}><Icon aria-hidden />{label}</SubmitButton>
      {(done || s.ok || s.error) && <Outcome s={s} />}
    </form>
  );
}

/** Dry run of the next sync: first page only, nothing written, shown as a diff. */
function Preview({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<SourcePreview | "loading" | null>(null);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setRes("loading");
    previewSource(source.id).then((r) => { if (!stale) setRes(r); });
    return () => { stale = true; };
  }, [open, source.id]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="secondary" aria-label={`Preview the next sync of ${source.name}`}><Eye aria-hidden />Preview sync</Button></DialogTrigger>
      <DialogContent title={`Next sync of ${source.name}`} description="What the next run would change. Nothing is written." className="max-h-[calc(100dvh-2rem)] max-w-4xl overflow-y-auto">
        {res === "loading" || res === null ? <p role="status" className="text-sm text-muted">Reading the first page from the source…</p>
          : res.error ? <p role="alert" className="text-sm font-medium text-bad">{res.error}</p>
          : <ContactDiff caption={`Next sync of ${source.name}`} rows={(res.rows ?? []) as PreviewRow[]} summary={res.summary as PreviewSummary} listName={res.list?.name}
              sample={`A sample: only the first page${res.hasMore ? " (there is more)" : ""}. A full read happens every ${source.full_sync_hours || "no"} hours.`.replace("every no hours", "never")} />}
      </DialogContent>
    </Dialog>
  );
}

function SourceForm({ source, close }: { source?: Source; close: () => void }) {
  const [s, act] = useActionState(saveSource, {} as Result);
  const [t, test] = useActionState(testSource, {} as Result);
  const seen = useRef<Result>(undefined);
  useEffect(() => { if (s.ok && seen.current !== s) { seen.current = s; toast.success(s.ok); close(); } }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form action={act} className="grid gap-4">
      {source && <input type="hidden" name="id" value={source.id} />}
      <Field label="Name" description="Shown in Settings and, by default, as the name of the list its contacts go on.">{(a) => <Input {...a} name="name" defaultValue={source?.name} required maxLength={100} autoComplete="off" placeholder="Acme app" />}</Field>
      <Field label="URL" description="The endpoint that lists your contacts. An internal address is fine.">{(a) => <Input {...a} name="url" type="url" mono defaultValue={source?.url} required autoComplete="off" placeholder="http://acme-api.internal:8080/internal/contacts" />}</Field>
      <Field label="API key" description={source ? "Leave blank to keep the stored key. Type a new one to rotate it. It is never shown again." : "Sent as a Bearer token. Stored encrypted and never shown again."}>
        {(a) => <Input {...a} name="key" type="password" mono required={!source} autoComplete="new-password" placeholder={source ? "••••••••••••" : "sk_…"} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Check every (minutes)">{(a) => <Input {...a} name="interval_minutes" type="number" min={1} max={1440} defaultValue={source?.interval_minutes ?? 15} required />}</Field>
        <Field label="Read everything every (hours)" description="0 = never. Catches changes the source does not timestamp.">{(a) => <Input {...a} name="full_sync_hours" type="number" min={0} max={720} defaultValue={source?.full_sync_hours ?? 24} required />}</Field>
      </div>
      {!source && <Field label="List name" description="Contacts from this source go on this list. Blank = the source's name. You can rename it later.">{(a) => <Input {...a} name="list_name" autoComplete="off" maxLength={100} />}</Field>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="secondary" size="sm" formAction={test}><Plug aria-hidden />Test connection</Button>
        <Outcome s={t} />
      </div>
      {s.error && <p role="alert" className="text-sm font-medium text-bad">{s.error}</p>}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
        <SubmitButton>{source ? "Save changes" : "Add source"}</SubmitButton>
      </div>
    </form>
  );
}

/** Add (no `source`) or edit / rotate the key of one. `children` is the trigger. */
function SourceDialog({ source, children }: { source?: Source; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent title={source ? `Edit ${source.name}` : "Add a contact source"} description="mailcraft pulls contacts from this address on a schedule. It never connects to the other product's database."
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <SourceForm source={source} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function Row({ source }: { source: Source }) {
  const [del, setDel] = useState(false);
  const c = source.last_counts;
  const status = source.last_status === "ok" ? <StatusBadge status="done" label="Last sync worked" size="sm" /> : source.last_status === "error" ? <StatusBadge status="failed" label="Last sync failed" size="sm" /> : <StatusBadge status="pending" label="Not synced yet" size="sm" />;
  return (
    <li className="grid gap-3 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{source.name}</span>
        {status}
        <span className="ml-auto"><EnabledSwitch source={source} /></span>
      </div>
      <p className="break-all font-mono text-xs text-muted">{source.url}</p>
      <p className="text-sm text-muted">
        Every {every(source.interval_minutes)}{source.full_sync_hours ? `, reads everything every ${source.full_sync_hours} h` : ""}.
        {source.last_run_at && <> Last run <RelativeTime value={source.last_run_at} />.</>}
        {c && source.last_status && <> {formatNumber(c.created ?? 0)} new, {formatNumber(c.updated ?? 0)} updated, {formatNumber(c.skipped ?? 0)} skipped, {formatNumber(c.deleted ?? 0)} suppressed (deleted at the source).</>}
        {source.list && <> Contacts go on <Link href={`/contacts?list=${encodeURIComponent(source.list.id)}`} className="font-medium text-accent hover:underline">{source.list.name}</Link>.</>}
      </p>
      {source.last_status === "error" && source.last_error && <p role="alert" className="rounded-md bg-bad-bg px-3 py-2 text-sm text-bad">{source.last_error}</p>}
      <div className="flex flex-wrap items-start gap-2">
        <ActionButton source={source} action={testSource} label="Test connection" icon={Plug} />
        <ActionButton source={source} action={syncSource} label="Sync now" icon={RefreshCw} />
        <Preview source={source} />
        <SourceDialog source={source}><Button size="sm" variant="ghost" aria-label={`Edit ${source.name}`}><Pencil aria-hidden />Edit</Button></SourceDialog>
        <Button size="sm" variant="ghost" aria-label={`Delete ${source.name}`} onClick={() => setDel(true)}><Trash2 aria-hidden />Delete</Button>
      </div>
      <TypeNameConfirm open={del} onOpenChange={setDel} title="Delete this contact source?" expected={source.name} confirmLabel="Delete source" action={deleteSource} fields={{ id: source.id, name: source.name }}
        description={<>Syncing from <strong>{source.name}</strong> stops. Its contacts stay, and so does every suppression.</>}>
        {source.list && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="delete_list" className="mt-0.5 size-4 accent-[var(--accent)]" />
            <span><span className="font-medium">Also delete the list {source.list.name}</span><span className="block text-muted">Otherwise the list stays, marked as detached. Either way the contacts stay.</span></span>
          </label>
        )}
      </TypeNameConfirm>
    </li>
  );
}

export function SourcesCard({ sources, canEdit = true }: { sources: Source[]; canEdit?: boolean }) {
  return (
    <Card id="sources" aria-labelledby="sources-h" className="scroll-mt-20">
      <CardHeader title={<span id="sources-h">Contact sources</span>} description="Pull your contact list from another product's API, kept in sync on a schedule. Each source gets its own list."
        action={<SourceDialog><Button variant="secondary" disabled={!canEdit}><Plus aria-hidden />Add source</Button></SourceDialog>} />
      <CardBody>
        {sources.length ? <ul className="grid divide-y divide-border rounded-md border border-border" aria-label="Contact sources">{sources.map((s) => <Row key={s.id} source={s} />)}</ul>
          : <p className="text-sm text-muted">No sources yet. Add the URL of an endpoint that lists your users and the API key that identifies mailcraft to it. The contract is in docs/CONTACT-SOURCES.md.</p>}
      </CardBody>
    </Card>
  );
}
