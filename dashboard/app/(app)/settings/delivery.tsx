"use client";
import { useActionState, useEffect, useState } from "react";
import { CircleCheck, CircleX, Mail, Plus, Server } from "lucide-react";
import { Button, SubmitButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { StatusBadge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { addRelay, gmailStart, testTransport, type Result } from "./actions";

export type Transport = { id: string; kind: string; name?: string; label?: string; is_default?: boolean; status?: string; from?: string | null; detail?: Record<string, unknown> };
export const PRESETS = ["postmark", "mailgun", "resend", "brevo", "smtp2go", "ses", "custom"] as const;
const KIND: Record<string, string> = { sandbox: "Sandbox inbox", "gmail-oauth": "Gmail", "smtp-relay": "SMTP relay", ses: "Amazon SES", direct: "Direct from this server" };

/** Test button with its result inline (aria-live) so a failure is read out, not just coloured. */
export function TestButton({ id, label }: { id: string; label: string }) {
  const [s, act] = useActionState(testTransport, {} as Result);
  return (
    <form action={act} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="secondary" aria-label={`Test ${label}`}>Test connection</SubmitButton>
      <span role="status" aria-live="polite" className="text-sm">
        {s.ok && <span className="inline-flex items-center gap-1 text-ok"><CircleCheck aria-hidden className="size-4" />{s.ok}</span>}
        {s.error && <span className="inline-flex items-center gap-1 text-bad"><CircleX aria-hidden className="size-4" />{s.error}</span>}
      </span>
    </form>
  );
}

function AddRelay({ canEdit }: { canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [s, act] = useActionState(addRelay, {} as Result);
  const [seen, setSeen] = useState<Result>();
  useEffect(() => { if (s.ok && seen !== s) { setSeen(s); toast.success(s.ok); setOpen(false); } }, [s, seen]);
  const [preset, setPreset] = useState<string>("postmark");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="secondary" disabled={!canEdit}><Plus aria-hidden />Add relay</Button></DialogTrigger>
      <DialogContent title="Add an SMTP relay" description="Send through a provider that owns IP reputation. Credentials are encrypted and never shown again.">
        <form action={act} className="grid gap-4">
          <Field label="Provider">{(a) => <Select {...a} name="preset" value={preset} onChange={(e) => setPreset(e.target.value)}>{PRESETS.map((p) => <option key={p}>{p}</option>)}</Select>}</Field>
          <Field label="Username" description={preset === "postmark" ? "Postmark uses the server token as both username and password." : "Leave empty if the provider needs none."}>
            {(a) => <Input {...a} name="username" mono autoComplete="off" />}
          </Field>
          <Field label="Password or API key">{(a) => <Input {...a} name="password" type="password" mono required autoComplete="new-password" />}</Field>
          {preset === "custom" && <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field label="SMTP host">{(a) => <Input {...a} name="host" mono required placeholder="smtppro.zoho.in" autoComplete="off" />}</Field>
            <Field label="Port">{(a) => <Input {...a} name="port" type="number" inputMode="numeric" min={1} max={65535} defaultValue={587} required />}</Field>
          </div>}
          {preset === "custom" && <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="mailbox_sender" className="mt-0.5 size-4 accent-[var(--accent)]" />
            <span><span className="font-medium">Send as this mailbox</span><span className="block text-muted">For Zoho, Google Workspace or Outlook, which only accept the username as sender. Bounces go to that inbox.</span></span>
          </label>}
          {preset === "ses" && <Field label="AWS region">{(a) => <Input {...a} name="region" placeholder="us-east-1" autoComplete="off" />}</Field>}
          {s.error && <p role="alert" className="text-sm font-medium text-bad">{s.error}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
            <SubmitButton>Add relay</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GmailConnect({ canEdit }: { canEdit: boolean }) {
  const [s, act] = useActionState(gmailStart, {} as Result);
  const [uri, setUri] = useState("");
  useEffect(() => setUri(`${window.location.origin}/settings/gmail/callback`), []);
  useEffect(() => { if (s.url) window.location.assign(s.url); }, [s.url]);
  return (
    <form action={act} className="grid gap-1">
      <input type="hidden" name="redirect_uri" value={uri} />
      <div><SubmitButton variant="secondary" disabled={!canEdit || !uri}><Mail aria-hidden />Connect Gmail</SubmitButton></div>
      {s.error && <p role="alert" className="text-sm text-bad">{s.error}</p>}
    </form>
  );
}

export function DeliveryCard({ path, transports, canEdit }: { path?: { kind: string; detail?: string } | null; transports: Transport[]; canEdit: boolean }) {
  return (
    <Card id="delivery" aria-labelledby="delivery-h" className="scroll-mt-20">
      <CardHeader title={<span id="delivery-h">Delivery</span>} description="How mail leaves mailcraft. Test mode never leaves the box: it lands in the sandbox inbox."
        action={<div className="flex gap-2"><AddRelay canEdit={canEdit} /></div>} />
      <CardBody className="grid gap-4">
        <div className="flex items-center gap-3 rounded-md bg-surface-2 px-3 py-2.5">
          <Server aria-hidden className="size-4 text-muted" />
          <div className="min-w-0 text-sm">
            <p className="font-medium">{path ? KIND[path.kind] ?? path.kind : "Not configured"}</p>
            <p className="truncate text-muted">{path?.detail ?? (path ? "Active delivery path" : "Add a relay or connect Gmail to send real mail.")}</p>
          </div>
        </div>
        {transports.length > 0 ? (
          <ul className="grid divide-y divide-border rounded-md border border-border" aria-label="Transports">
            {transports.map((t) => {
              const name = t.name ?? t.kind;
              return (
                <li key={t.id} className="grid gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{name}</span>
                    <span className="text-sm text-muted">{KIND[t.kind] ?? t.kind}{t.from ? ` · ${t.from}` : ""}</span>
                    {t.is_default && <span className="rounded-full bg-accent-soft px-2 text-xs text-accent">default</span>}
                    {t.label && <span className="text-xs text-muted">{t.label}</span>}
                    {t.status && <span className="ml-auto"><StatusBadge status={t.status} size="sm" /></span>}
                  </div>
                  <TestButton id={t.id} label={name} />
                </li>
              );
            })}
          </ul>
        ) : <p className="text-sm text-muted">No relays connected yet.</p>}
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-sm text-muted">No domain yet? Send from your own Gmail address (low volume, labelled as such).</p>
          <GmailConnect canEdit={canEdit} />
        </div>
      </CardBody>
    </Card>
  );
}
