"use client";
import { Plus, TriangleAlert } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { createKey } from "@/lib/actions";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/error-state";
import { MonoCopy } from "@/components/setup/mono-copy";

const SCOPES = [["read", "Read emails, domains and settings."], ["send", "Send email."], ["manage", "Create keys, change settings and policy."]] as const;
const ENVS = [["test", "Test", "Sandboxed. Nothing is delivered."], ["live", "Live", "Sends real email to real people."]] as const;
type S = { secret?: string; error?: string };

function Form({ onSecret, onDone }: { onSecret: () => void; onDone: () => void }) {
  const [s, act] = useActionState(createKey, {} as S);
  const [stored, setStored] = useState(false);
  useEffect(() => { if (s.secret) onSecret(); }, [s.secret, onSecret]);
  if (s.secret) {
    return (
      <div className="grid gap-4">
        <p className="flex items-start gap-2 text-sm font-medium text-warn"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />Copy this key now. You won&apos;t see this again.</p>
        <MonoCopy value={s.secret} label="API key secret" />
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input data-ui="checkbox" type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
          I&apos;ve stored this key somewhere safe.
        </label>
        <div className="flex justify-end"><Button disabled={!stored} onClick={onDone}>Done</Button></div>
      </div>
    );
  }
  return (
    <form action={act} className="grid gap-4">
      <Field label="Name" description="What this key is for, e.g. Production sender.">{(a) => <Input {...a} name="name" required autoComplete="off" />}</Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">Environment</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ENVS.map(([v, t, d]) => (
            <label key={v} className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
              <input data-ui="radio" type="radio" name="env" value={v} defaultChecked={v === "test"} className="mt-1 size-4 accent-[var(--accent)]" />
              <span><span className="flex items-center gap-1.5 text-sm font-medium"><span aria-hidden className={`size-2 rounded-full ${v === "live" ? "bg-live" : "bg-test"}`} />{t}</span><span className="block text-xs text-muted">{d}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">Scopes <span className="font-normal text-muted">(least privilege by default)</span></legend>
        {SCOPES.map(([v, d]) => (
          <label key={v} className="flex cursor-pointer items-start gap-3 text-sm">
            <input data-ui="checkbox" type="checkbox" name="scopes" value={v} defaultChecked={v !== "manage"} className="mt-0.5 size-4 accent-[var(--accent)]" />
            <span><span className="font-mono text-[12.5px]">{v}</span> <span className="text-muted">{d}</span></span>
          </label>
        ))}
      </fieldset>
      {s.error && <ErrorState error={{ code: "error", message: s.error }} />}
      <div className="flex justify-end"><SubmitButton>Create key</SubmitButton></div>
    </form>
  );
}

/** Create-key dialog. Once a secret exists the dialog cannot be dismissed (Esc, overlay, X) until the "stored" box is ticked. */
export function CreateKey({ label = "Create key" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [n, setN] = useState(0);
  const onSecret = () => setLocked(true);
  const done = () => { setLocked(false); setOpen(false); setN((x) => x + 1); };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && locked) return; setOpen(o); if (!o) setN((x) => x + 1); }}>
      <DialogTrigger asChild><Button><Plus aria-hidden />{label}</Button></DialogTrigger>
      <DialogContent title={locked ? "Your new API key" : "Create an API key"} description={locked ? "This is the only time the full key is shown." : "Keys authenticate your app, CLI or agent."}>
        <Form key={n} onSecret={onSecret} onDone={done} />
      </DialogContent>
    </Dialog>
  );
}
