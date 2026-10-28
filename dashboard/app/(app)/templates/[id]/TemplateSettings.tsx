"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { updateTemplateDetails } from "../actions";

/** Rename, change the alias, or move between transactional and marketing. Applies at once; no new version. */
export function TemplateSettings({ template: t }: { template: any }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: t.name ?? "", alias: t.alias ?? "", stream: t.stream ?? "transactional" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const aliasChanged = f.alias.trim() !== (t.alias ?? "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await updateTemplateDetails({ id: t.id, ...f });
    setBusy(false);
    if (r.error) return setError(r.error);
    setError(null);
    setOpen(false);
    toast.success("Template settings saved");
    router.refresh();
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setError(null); setF({ name: t.name ?? "", alias: t.alias ?? "", stream: t.stream ?? "transactional" }); } }}>
      <DialogTrigger asChild><Button variant="secondary" aria-label="Template settings"><Settings aria-hidden /><span className="max-sm:hidden">Settings</span></Button></DialogTrigger>
      <DialogContent title="Template settings" description="These apply immediately and do not create a new version.">
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Name">{(a) => <Input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />}</Field>
          <Field label="Alias" description={aliasChanged ? "Sends and automations that use the old alias will stop finding this template. Update them first." : "What sends and automations reference, e.g. template: welcome."}>
            {(a) => <Input {...a} value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} required className="font-mono" />}
          </Field>
          <Field label="Stream" description="Marketing templates get the unsubscribe footer and need the workspace postal address.">
            {(a) => <Select {...a} value={f.stream} onChange={(e) => setF({ ...f, stream: e.target.value })}><option value="transactional">Transactional</option><option value="marketing">Marketing</option></Select>}
          </Field>
          {error && <ErrorState error={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={!f.name.trim() || !f.alias.trim()}>Save settings</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
