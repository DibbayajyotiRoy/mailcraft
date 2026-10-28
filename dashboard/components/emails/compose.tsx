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
import { addRecipients, contactName, prefillVars, recipientProblem, splitAddresses, type ContactsApi, type Recipient } from "@/lib/recipients";
import { findSender, type Sender } from "@/lib/senders";
import { FromPicker } from "./from-picker";
import { NewContactsStep, type NewRow } from "./new-contacts-step";
import { RecipientPicker } from "./recipient-picker";
import { Live, useWriteWithAI, WriteWithAI } from "./write-with-ai";

export type ComposeTemplate = { id: string; name?: string; alias?: string; variables?: unknown };
type Send = (body: Record<string, unknown>) => Promise<{ id?: string; status?: string; error?: ApiError }>;

const blank = (from: string): Compose => ({ from, to: "", subject: "", stream: "transactional", mode: "text", text: "", html: "", template: "", vars: {} });

/** "New email" on the Emails page: one message through POST /v1/emails. The API judges everything beyond the basic checks, and its error (code, message, hint) is shown as is.
 *  With `contacts`, To suggests contacts, and an address that is not a contact yet is added first (a second step in this dialog), then the email is sent. */
export function ComposeEmail({ defaultFrom, senders, templates, send, contacts }: { defaultFrom: string; senders?: Sender[]; templates: ComposeTemplate[]; send: Send; contacts?: ContactsApi }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [c, setC] = useState<Compose>(blank(defaultFrom));
  const [errors, setErrors] = useState<Errors>({});
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [busy, start] = useTransition();
  const [to, setTo] = useState<Recipient[]>([]);
  const [draft, setDraft] = useState("");
  const [fresh, setFresh] = useState<NewRow[] | null>(null); // the "add new contacts" step; null = the message form
  const [freshError, setFreshError] = useState<ApiError | null>(null);
  const set = (p: Partial<Compose>) => { if ("subject" in p || "text" in p || "html" in p || "vars" in p) ai.edited(); setC((x) => ({ ...x, ...p })); };
  const changeTo = (r: Recipient[]) => { setTo(r); setErrors((e) => ({ ...e, to: undefined })); };
  const tpl = templates.find((t) => t.id === c.template);
  const vars = askableVars(tpl?.variables);
  const body = (rs: Recipient[]) => composeBody({ ...c, to: rs.map((r) => r.email).join(", "), vars: prefillVars(c.vars, vars, rs) });
  const varsShown = prefillVars(c.vars, vars, to);
  // Write with AI: names of picked contacts and the sender's display name, never addresses.
  const ai = useWriteWithAI(c, setC, { vars, count: to.length, names: to.flatMap((r) => (r.contact ? [contactName(r.contact)] : [])).filter(Boolean),
    fromName: findSender(senders ?? [], c.from)?.display_name || /^([^<]+?)\s*<[^>]+>\s*$/.exec(c.from)?.[1] || undefined });

  function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (ai.writing || ai.incomplete) return; // Send waits for the draft to finish (or Stop), and for a cut-off one to be edited or regenerated
    const rs = addRecipients(to, splitAddresses(draft)); // text still in the box counts
    const r = body(rs), problem = recipientProblem(rs);
    setApiError(null);
    if ("errors" in r || problem) return setErrors({ ...("errors" in r ? r.errors : {}), ...(problem ? { to: problem } : {}) });
    setErrors({});
    setTo(rs); setDraft("");
    start(async () => {
      let list = rs;
      if (contacts) {
        // Exact re-check of every address that did not come from a suggestion: it may be a contact, or suppressed.
        const unknown = rs.filter((x) => !x.contact);
        const found = await Promise.all(unknown.map((x) => contacts.find(x.email)));
        const err = found.find((f) => f.error)?.error;
        if (err) return setApiError(err);
        list = rs.map((x) => (x.contact ? x : { ...x, contact: found[unknown.indexOf(x)].contact ?? undefined }));
        setTo(list);
        const bad = recipientProblem(list);
        if (bad) return setErrors({ to: bad });
        const news = list.filter((x) => !x.contact);
        if (news.length) { setFreshError(null); return setFresh(news.map((x) => ({ email: x.email, first_name: "", last_name: "", timezone: "" }))); }
      }
      await deliver(list);
    });
  }

  async function deliver(list: Recipient[]) {
    const r = body(list);
    if ("errors" in r) return setErrors(r.errors);
    const res = await send(r.body);
    if (res.error) return setApiError(res.error);
    const pending = res.status === "pending_approval";
    toast.success(pending ? "Sent for approval" : "Email queued", {
      description: pending ? <Link href="/approvals" className="underline">Open approvals</Link> : res.id ? <Link href={`/emails/${encodeURIComponent(res.id)}`} className="underline">View email</Link> : undefined,
    });
    setOpen(false); ai.reset();
    setC(blank(defaultFrom)); setTo([]); setDraft(""); setFresh(null);
    router.refresh();
  }

  /** Step two: add each new address as a contact, then send. A contact that was added stays added (and known) if a later step fails. */
  function createAndSend() {
    if (!contacts || !fresh) return;
    setFreshError(null);
    start(async () => {
      let list = to, left = fresh;
      for (const row of fresh) {
        const res = await contacts.create({ email: row.email, first_name: row.first_name.trim() || undefined, last_name: row.last_name.trim() || undefined, timezone: row.timezone || undefined });
        if (res.error) { setTo(list); setFresh(left); return setFreshError({ ...res.error, message: `${row.email}: ${res.error.message}` }); }
        list = list.map((x) => (x.email === row.email ? { ...x, contact: { email: row.email, first_name: row.first_name.trim() || null } } : x));
        left = left.filter((x) => x !== row);
      }
      setTo(list); setFresh(null);
      await deliver(list);
    });
  }

  const onOpenChange = (o: boolean) => { setOpen(o); if (!o) { setFresh(null); ai.reset(); } };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild><Button><SquarePen aria-hidden />New email</Button></DialogTrigger>
      <DialogContent title={fresh ? `Add ${fresh.length} new contact${fresh.length === 1 ? "" : "s"}` : "New email"} description={fresh ? "Then your email is sent." : "Sends one message now, through your delivery settings."} className="max-h-[calc(100dvh-32px)] max-w-xl overflow-y-auto">
        {fresh ? <NewContactsStep rows={fresh} onRows={setFresh} busy={busy} error={freshError} onBack={() => setFresh(null)} onSubmit={createAndSend} /> : (
        <form onSubmit={submit} noValidate className="grid gap-4">
          <Field label="From" error={errors.from}>{(a) => <FromPicker {...a} senders={senders} value={c.from} onChange={(from) => set({ from })} />}</Field>
          <Field label="To" description={contacts ? "Search your contacts, or type an address. Commas separate several." : "Separate several addresses with commas."} error={errors.to ?? recipientProblem(to)}>
            {(a) => <RecipientPicker {...a} recipients={to} onRecipients={changeTo} draft={draft} onDraft={setDraft} search={contacts?.search} />}
          </Field>
          <WriteWithAI ai={ai} mode={c.mode} />
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Subject" description={c.mode === "template" ? "Optional: blank uses the template’s subject." : undefined} error={errors.subject}>{(a) => <Live ai={ai} field="subject" text={c.subject}><Input {...a} value={c.subject} readOnly={ai.active === "subject"} onChange={(e) => set({ subject: e.target.value })} /></Live>}</Field>
            <Field label="Stream">{(a) => <Select {...a} value={c.stream} onChange={(e) => set({ stream: e.target.value as Compose["stream"] })}><option value="transactional">Transactional</option><option value="marketing">Marketing</option></Select>}</Field>
          </div>
          <Tabs value={c.mode} onValueChange={(m) => set({ mode: m as Mode })}>
            <TabsList aria-label="Message content"><TabsTrigger value="text">Plain text</TabsTrigger><TabsTrigger value="html">HTML</TabsTrigger><TabsTrigger value="template">Use a template</TabsTrigger></TabsList>
            <TabsContent value="text"><Field label="Message" error={errors.content}>{(a) => <Live ai={ai} field="text" text={c.text} multiline><Textarea {...a} rows={7} value={c.text} readOnly={ai.active === "text"} onChange={(e) => set({ text: e.target.value })} /></Live>}</Field></TabsContent>
            <TabsContent value="html"><Field label="HTML" error={errors.content}>{(a) => <Live ai={ai} field="html" text={c.html} multiline mono><Textarea {...a} mono rows={7} value={c.html} readOnly={ai.active === "html"} onChange={(e) => set({ html: e.target.value })} /></Live>}</Field></TabsContent>
            <TabsContent value="template" className="grid gap-4">
              <Field label="Template" error={errors.content} description={templates.length ? undefined : "No templates yet. Import one on the Templates page."}>
                {(a) => <Select {...a} value={c.template} onChange={(e) => { ai.reset(); set({ template: e.target.value, vars: {} }); }}><option value="">Choose a template</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name ?? t.alias ?? t.id}</option>)}</Select>}
              </Field>
              {vars.map((v) => (
                <Field key={v} label={<code className="text-[12.5px]">{v}</code>}>{(a) => <Live ai={ai} field={`var:${v}`} text={varsShown[v] ?? ""}><Input {...a} value={varsShown[v] ?? ""} readOnly={ai.active === `var:${v}`} onChange={(e) => set({ vars: { ...c.vars, [v]: e.target.value } })} /></Live>}</Field>
              ))}
            </TabsContent>
          </Tabs>
          {apiError && <ErrorState error={apiError} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={ai.writing || ai.incomplete}>Send email</Button>
          </div>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
