"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import type { ApiError } from "@/lib/api";
import { askableVars, composeBody, type Compose, type Errors, type Mode } from "@/lib/compose";
import type { Sender } from "@/lib/senders";
import { FromPicker } from "./from-picker";

export type ComposeTemplate = { id: string; name?: string; alias?: string; variables?: unknown };
type Send = (body: Record<string, unknown>) => Promise<{ id?: string; status?: string; error?: ApiError }>;

const blank = (from: string): Compose => ({ from, to: "", subject: "", stream: "transactional", mode: "text", text: "", html: "", template: "", vars: {} });

/** "New email" on the Emails page: one message through POST /v1/emails. The API judges everything beyond the basic checks, and its error (code, message, hint) is shown as is. */
export function ComposeEmail({ defaultFrom, senders, templates, send }: { defaultFrom: string; senders?: Sender[]; templates: ComposeTemplate[]; send: Send }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [c, setC] = useState<Compose>(blank(defaultFrom));
  const [errors, setErrors] = useState<Errors>({});
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [busy, start] = useTransition();
  const set = (p: Partial<Compose>) => setC((x) => ({ ...x, ...p }));
  const tpl = templates.find((t) => t.id === c.template);
  const vars = askableVars(tpl?.variables);

  function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const r = composeBody(c);
    setApiError(null);
    if ("errors" in r) return setErrors(r.errors);
    setErrors({});
    start(async () => {
      const res = await send(r.body);
      if (res.error) return setApiError(res.error);
      const pending = res.status === "pending_approval";
      toast.success(pending ? "Sent for approval" : "Email queued", {
        description: pending ? <Link href="/approvals" className="underline">Open approvals</Link> : res.id ? <Link href={`/emails/${encodeURIComponent(res.id)}`} className="underline">View email</Link> : undefined,
      });
      setOpen(false);
      setC(blank(defaultFrom));
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><SquarePen aria-hidden />New email</Button></DialogTrigger>
      <DialogContent title="New email" description="Sends one message now, through your delivery settings." className="max-h-[calc(100dvh-32px)] max-w-xl overflow-y-auto">
        <form onSubmit={submit} noValidate className="grid gap-4">
          <Field label="From" error={errors.from}>{(a) => <FromPicker {...a} senders={senders} value={c.from} onChange={(from) => set({ from })} />}</Field>
          <Field label="To" description="Separate several addresses with commas." error={errors.to}>{(a) => <Input {...a} autoComplete="off" value={c.to} onChange={(e) => set({ to: e.target.value })} placeholder="ada@example.com, grace@example.com" />}</Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Subject" description={c.mode === "template" ? "Optional: blank uses the template’s subject." : undefined} error={errors.subject}>{(a) => <Input {...a} value={c.subject} onChange={(e) => set({ subject: e.target.value })} />}</Field>
            <Field label="Stream">{(a) => <Select {...a} value={c.stream} onChange={(e) => set({ stream: e.target.value as Compose["stream"] })}><option value="transactional">Transactional</option><option value="marketing">Marketing</option></Select>}</Field>
          </div>
          <Tabs value={c.mode} onValueChange={(m) => set({ mode: m as Mode })}>
            <TabsList aria-label="Message content"><TabsTrigger value="text">Plain text</TabsTrigger><TabsTrigger value="html">HTML</TabsTrigger><TabsTrigger value="template">Use a template</TabsTrigger></TabsList>
            <TabsContent value="text"><Field label="Message" error={errors.content}>{(a) => <Textarea {...a} rows={7} value={c.text} onChange={(e) => set({ text: e.target.value })} />}</Field></TabsContent>
            <TabsContent value="html"><Field label="HTML" error={errors.content}>{(a) => <Textarea {...a} mono rows={7} value={c.html} onChange={(e) => set({ html: e.target.value })} />}</Field></TabsContent>
            <TabsContent value="template" className="grid gap-4">
              <Field label="Template" error={errors.content} description={templates.length ? undefined : "No templates yet. Import one on the Templates page."}>
                {(a) => <Select {...a} value={c.template} onChange={(e) => set({ template: e.target.value, vars: {} })}><option value="">Choose a template</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name ?? t.alias ?? t.id}</option>)}</Select>}
              </Field>
              {vars.map((v) => (
                <Field key={v} label={<code className="text-[12.5px]">{v}</code>}>{(a) => <Input {...a} value={c.vars[v] ?? ""} onChange={(e) => set({ vars: { ...c.vars, [v]: e.target.value } })} />}</Field>
              ))}
            </TabsContent>
          </Tabs>
          {apiError && <ErrorState error={apiError} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Send email</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
