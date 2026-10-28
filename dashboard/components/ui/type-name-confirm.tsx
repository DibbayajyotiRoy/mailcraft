"use client";
import { useState, type ReactNode } from "react";
import { Button, SubmitButton } from "./button";
import { DialogClose, Dialog, DialogContent } from "./dialog";
import { Field, Input } from "./field";

/** Destructive confirm: the action only enables once the resource name is typed. `action` is a server action; `fields` are posted as hidden inputs. */
export function TypeNameConfirm({ open, onOpenChange, title, description, expected, confirmLabel, action, fields, children }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: ReactNode; expected: string;
  confirmLabel: string; action: (d: FormData) => void | Promise<void>; fields: Record<string, string>;
  /** Extra inputs posted with the form (an "also delete the list" checkbox). */
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setTyped(""); onOpenChange(o); }}>
      <DialogContent title={title} description={description}>
        <form action={action} className="grid gap-4">
          {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          {children}
          <Field label={<>Type <code className="font-mono text-[12.5px]">{expected}</code> to confirm</>}>
            {(a) => <Input {...a} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
            <SubmitButton variant="danger" disabled={typed !== expected}>{confirmLabel}</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
