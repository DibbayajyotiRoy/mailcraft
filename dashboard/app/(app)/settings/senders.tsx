"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Button, SubmitButton } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { byTransport, findSender, senderLabel, type Sender } from "@/lib/senders";
import type { Result } from "./actions";
import { AddressRows } from "./address-rows";
import { AddRelay } from "./delivery";
import { saveAddresses, setDefaultFrom } from "./senders-actions";

/** Runs `act`'s result through a toast once, and calls `done` (closes a dialog). */
function useToasted(s: Result, done?: () => void) {
  const shown = useRef<Result>(undefined);
  useEffect(() => { if (s.ok && shown.current !== s) { shown.current = s; toast.success(s.ok); done?.(); } }, [s, done]);
}

function DefaultFrom({ senders, defaultFrom, canEdit }: { senders: Sender[]; defaultFrom: string; canEdit: boolean }) {
  const [s, act] = useActionState(setDefaultFrom, {} as Result);
  useToasted(s);
  return (
    <form action={act} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
      <Field label="Default From" description="Used when an email, broadcast or automation step does not pick a sender.">
        {(a) => (
          <Select {...a} name="default_from" defaultValue={findSender(senders, defaultFrom)?.address ?? ""} disabled={!canEdit}>
            <option value="">None</option>
            {senders.map((x) => <option key={x.address} value={x.address}>{senderLabel(x)}</option>)}
          </Select>
        )}
      </Field>
      <SubmitButton variant="secondary" disabled={!canEdit}>Save default</SubmitButton>
      {s.error && <p role="alert" className="text-sm font-medium text-bad sm:col-span-2">{s.error}</p>}
    </form>
  );
}

function EditAddresses({ id, name, rows }: { id: string; name: string; rows: Sender[] }) {
  const [open, setOpen] = useState(false);
  const [s, act] = useActionState(saveAddresses, {} as Result);
  useToasted(s, () => setOpen(false));
  const login = rows.find((r) => r.kind === "login");
  if (!login) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="secondary" size="sm" aria-label={`Edit addresses of ${name}`}><Pencil aria-hidden />Edit addresses</Button></DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-32px)] max-w-xl overflow-y-auto" title={`Addresses of ${name}`} description="The mailbox keeps signing in with its login; the From header shows the address you send as.">
        <form action={act} className="grid gap-4">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="login" value={login.address} />
          <AddressRows login={login.address} loginName={login.display_name ?? ""}
            aliases={rows.filter((r) => r.kind === "alias").map((r) => ({ address: r.address, name: r.display_name ?? "" }))} />
          {s.error && <p role="alert" className="text-sm font-medium text-bad">{s.error}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
            <SubmitButton>Save addresses</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({ s }: { s: Sender }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        {s.display_name ? <p className="truncate font-medium">{s.display_name}</p> : null}
        <p className={s.display_name ? "truncate font-mono text-xs text-muted" : "truncate font-mono text-[13px]"}>{s.address}</p>
      </div>
      {s.kind === "alias" && <span className="text-xs text-muted">alias</span>}
      {s.is_default && <span className="rounded-full bg-accent-soft px-2 text-xs text-accent">default</span>}
      {s.status && <StatusBadge status={s.status} size="sm" />}
    </li>
  );
}

/** The From addresses, derived from the connected mailboxes (nothing is stored here but the default). */
export function SendersCard({ senders, defaultFrom, canEdit }: { senders: Sender[]; defaultFrom: string; canEdit: boolean }) {
  const groups = byTransport(senders);
  return (
    <Card id="senders" aria-labelledby="senders-h" className="scroll-mt-20">
      <CardHeader title={<span id="senders-h">Senders</span>}
        description="The addresses you can send as. They come from your connected mailboxes: the login and any aliases, each with the name recipients see."
        action={senders.length ? <AddRelay canEdit={canEdit} mailbox /> : undefined} />
      <CardBody className="grid gap-5">
        {!senders.length ? (
          <EmptyState title="No sender addresses yet"
            description="Connect a mailbox (Zoho, Google Workspace, Outlook) and its address shows up here. You can also type any address on a verified domain wherever you pick a From."
            action={<AddRelay canEdit={canEdit} mailbox />} />
        ) : (
          <>
            <DefaultFrom senders={senders} defaultFrom={defaultFrom} canEdit={canEdit} />
            {groups.map(([tid, rows]) => {
              const via = rows[0].transport;
              const mailbox = rows.some((r) => r.kind === "login");
              return (
                <section key={tid || "none"} aria-label={via ? `Senders sending via ${via}` : "Other senders"} className="grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{via ? <>Sends via <span className="font-mono text-[13px]">{via}</span></> : "No delivery path"}</h3>
                    {mailbox && canEdit && <EditAddresses id={tid} name={via ?? "mailbox"} rows={rows} />}
                  </div>
                  <ul className="grid divide-y divide-border rounded-md border border-border" aria-label={`Senders${via ? ` via ${via}` : ""}`}>
                    {rows.map((r) => <Row key={r.address} s={r} />)}
                  </ul>
                </section>
              );
            })}
          </>
        )}
      </CardBody>
    </Card>
  );
}
