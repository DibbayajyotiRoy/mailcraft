"use client";
import { useActionState, useRef, useState, type ReactNode } from "react";
import { createKey } from "@/lib/actions";
import { Button, SubmitButton } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";
import { CopyField } from "@/components/ui/copy";
import { Field, Input, Select } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/error-state";

/** Submit button that asks first (kill switch engage, revoke). Thin wrapper on AlertDialog; submits its form on confirm. */
export function ConfirmButton({ message, children, className, title = "Are you sure?" }: { message: string; children: ReactNode; className?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  return (
    <>
      <Button ref={ref} type="submit" variant={className?.includes("danger") ? "danger-outline" : "primary"}
        onClick={(e) => { if (!confirmed.current) { e.preventDefault(); setOpen(true); } confirmed.current = false; }}>{children}</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent title={title} description={message} confirmLabel={typeof children === "string" ? children : "Confirm"}
          onConfirm={() => { confirmed.current = true; ref.current?.form?.requestSubmit(ref.current); }} />
      </AlertDialog>
    </>
  );
}

export function KeyForm() {
  const [s, act] = useActionState(createKey, {} as { secret?: string; error?: string });
  return (
    <form action={act} className="grid max-w-[560px] gap-4">
      <Field label="Name">{(a) => <Input {...a} name="name" required />}</Field>
      <Field label="Environment">{(a) => <Select {...a} name="env"><option>test</option><option>live</option></Select>}</Field>
      <Field label="Scopes (read, send, manage; space or comma separated)">{(a) => <Input {...a} name="scopes" defaultValue="read send" />}</Field>
      <div><SubmitButton>Create key</SubmitButton></div>
      {s.error && <ErrorState error={{ code: "error", message: s.error }} />}
      {s.secret && (
        <div role="status" className="grid gap-2 rounded-lg border border-ok/40 bg-ok-bg p-4 text-sm text-ok">
          Copy this secret now; it is shown only once.
          <CopyField value={s.secret} label="API key secret" className="text-fg" />
        </div>
      )}
    </form>
  );
}
