"use client";
import { Plus } from "lucide-react";
import { useState } from "react";
import { addDomain } from "@/lib/actions";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";

const STREAMS = [
  ["transactional", "Transactional", "Receipts, resets, alerts. One recipient at a time."],
  ["marketing", "Marketing", "Newsletters and campaigns. Adds unsubscribe headers."],
] as const;

export function AddDomain({ label = "Add domain" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const bad = name !== "" && !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(name.trim());
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden />{label}</Button></DialogTrigger>
      <DialogContent title="Add a domain" description="Use a subdomain you control, such as mail.example.com. You will add DNS records next.">
        <form action={addDomain} className="grid gap-4">
          <Field label="Domain" error={bad ? "Enter a domain like mail.example.com" : undefined}>
            {(a) => <Input {...a} name="domain" required mono placeholder="mail.example.com" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">Stream</legend>
            {STREAMS.map(([v, t, d], i) => (
              <label key={v} className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input data-ui="radio" type="radio" name="stream" value={v} defaultChecked={i === 0} className="mt-1 size-4 accent-[var(--accent)]" />
                <span><span className="block text-sm font-medium">{t}</span><span className="block text-xs text-muted">{d}</span></span>
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
            <SubmitButton disabled={!name.trim() || bad}>Add domain</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
