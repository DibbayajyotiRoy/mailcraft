"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Send } from "lucide-react";
import { Personalization } from "@/components/Personalization";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyValue } from "@/components/ui/stat-card";
import { toast } from "@/components/ui/toast";
import { MessagePreview } from "@/components/monitor/message-preview";
import type { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { every, REASON } from "@/lib/broadcast";
import { varsOf, type Parsed, type Recipient } from "@/lib/csv";
import type { Draft, Out } from "@/app/(app)/broadcasts/actions";
import { RecipientsStep } from "./recipients";

export type Tpl = { id: string; name?: string; alias?: string; subject?: string; status?: string };
type Actions = {
  preview: (d: Draft, r: Recipient) => Promise<Out<{ subject: string; html: string; text: string }>>;
  create: (d: Draft, rs: Recipient[], dryRun: boolean) => Promise<Out>;
  sendTest: (body: Record<string, unknown>) => Promise<{ id?: string; error?: ApiError }>;
};
type Plan = { queued: number; skipped: { email: string; reason: string; detail?: string | null }[]; schedule?: { daily_cap: number | null; transport_daily_cap: number | null; spacing_seconds: number; first_at: string; last_at: string } };

const STEPS = ["Recipients", "Content", "Review"] as const;
const when = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

export function NewBroadcast({ templates, defaultFrom, actions }: { templates: Tpl[]; defaultFrom: string; actions: Actions }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [list, setList] = useState<Parsed | null>(null);
  const [d, setD] = useState<Draft>({ template_id: templates[0]?.id ?? "", from: defaultFrom, stream: "marketing" });
  const recipients = list?.recipients ?? [];
  const published = templates;
  const ready = [recipients.length > 0, !!d.template_id && !!d.from.trim()];

  return (
    <div className="grid gap-6">
      <ol aria-label="Steps" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-2", i === step ? "font-medium text-fg" : "text-muted")}>
            <span aria-hidden className={cn("grid size-5 place-items-center rounded-full text-xs tabular-nums", i === step ? "bg-accent text-accent-fg" : i < step ? "bg-ok-bg text-ok" : "bg-surface-2")}>{i + 1}</span>{s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <CardHeader title="Who gets it" description="Upload a CSV, or type a few recipients to try it out." />
          <CardBody className="grid gap-4">
            <RecipientsStep onActive={setList} />
            <StepNav next={{ label: "Content", disabled: !ready[0], onClick: () => setStep(1) }}
              hint={ready[0] ? `${recipients.length} ${recipients.length === 1 ? "recipient" : "recipients"} selected.` : "Add at least one valid recipient to continue."} />
          </CardBody>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader title="What they get" description="Pick a published template. The preview is rendered the way the worker will send it." action={<Personalization />} />
          <CardBody className="grid gap-4">
            {!published.length ? (
              <EmptyState title="No published templates" description="Publish a template first; broadcasts send the published version." action={<Button asChild variant="secondary"><Link href="/templates">Open templates</Link></Button>} />
            ) : (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
                <div className="grid content-start gap-4">
                  <Field label="Template">{(a) => <Select {...a} value={d.template_id} onChange={(e) => setD({ ...d, template_id: e.target.value })}>{published.map((t) => <option key={t.id} value={t.id}>{t.name ?? t.alias ?? t.id}</option>)}</Select>}</Field>
                  <Field label="Subject" description="Optional. Blank uses the template’s subject. Same {{ }} values work here.">{(a) => <Input {...a} value={d.subject ?? ""} onChange={(e) => setD({ ...d, subject: e.target.value })} placeholder={published.find((t) => t.id === d.template_id)?.subject} />}</Field>
                  <Field label="From" description="An address on a verified domain.">{(a) => <Input {...a} inputMode="email" autoComplete="off" value={d.from} onChange={(e) => setD({ ...d, from: e.target.value })} placeholder="you@yourdomain.com" />}</Field>
                  <Field label="Stream" description="Marketing adds the unsubscribe footer and honours opt-outs.">{(a) => <Select {...a} value={d.stream} onChange={(e) => setD({ ...d, stream: e.target.value as Draft["stream"] })}><option value="marketing">Marketing</option><option value="transactional">Transactional</option></Select>}</Field>
                </div>
                <PreviewPane draft={d} recipients={recipients} preview={actions.preview} />
              </div>
            )}
            <StepNav back={() => setStep(0)} next={{ label: "Review", disabled: !ready[1] || !published.length, onClick: () => setStep(2) }}
              hint={!d.from.trim() ? "Enter the From address to continue." : undefined} />
          </CardBody>
        </Card>
      )}

      {step === 2 && <Review draft={d} setDraft={setD} recipients={recipients} templates={templates} actions={actions} back={() => setStep(1)}
        done={(id) => { toast.success("Broadcast queued", { description: "Progress is on this page." }); router.push(`/broadcasts/${id}`); }} />}
    </div>
  );
}

function StepNav({ back, next, hint }: { back?: () => void; next: { label: string; disabled?: boolean; onClick: () => void }; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p className="text-sm text-muted" role="status">{hint}</p>
      <div className="flex gap-2">
        {back && <Button variant="secondary" onClick={back}><ChevronLeft aria-hidden />Back</Button>}
        <Button onClick={next.onClick} disabled={next.disabled}>{next.label}<ChevronRight aria-hidden /></Button>
      </div>
    </div>
  );
}

/** Live preview for one recipient at a time; re-renders (debounced) when the draft or the chosen recipient changes. */
function PreviewPane({ draft, recipients, preview }: { draft: Draft; recipients: Recipient[]; preview: Actions["preview"] }) {
  const [i, setI] = useState(0);
  const [state, setState] = useState<{ loading: boolean; data?: { subject: string; html: string; text: string }; error?: ApiError }>({ loading: true });
  const who = recipients[Math.min(i, recipients.length - 1)];
  const key = JSON.stringify([draft.template_id, draft.subject, draft.stream, who]);
  useEffect(() => {
    if (!who || !draft.template_id) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      preview(draft, who).then((r) => live && setState(r.error ? { loading: false, error: r.error } : { loading: false, data: r.data }))
        .catch(() => live && setState({ loading: false, error: { code: "unreachable", message: "Could not reach the dashboard server.", hint: "Check your connection and try again." } }));
    }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const shown = recipients.slice(0, 50);
  return (
    <div className="grid content-start gap-3">
      <Field label="Preview as" description={recipients.length > shown.length ? `The first ${shown.length} of ${recipients.length} recipients.` : undefined}>
        {(a) => <Select {...a} value={Math.min(i, shown.length - 1)} onChange={(e) => setI(Number(e.target.value))}>{shown.map((r, n) => <option key={r.email} value={n}>{r.email}</option>)}</Select>}
      </Field>
      <div aria-live="polite" aria-busy={state.loading}>
        {state.error ? <ErrorState error={state.error} />
          : !state.data ? <Skeleton className="h-[420px] w-full rounded-lg" />
            : (
              <div className={cn("grid gap-2 transition-opacity", state.loading && "opacity-60")}>
                <p className="truncate text-sm text-muted">Subject: <span className="text-fg">{state.data.subject}</span></p>
                <MessagePreview html={state.data.html} text={state.data.text} title={`Preview for ${who?.email}`} />
              </div>
            )}
      </div>
    </div>
  );
}

function Review({ draft, setDraft, recipients, templates, actions, back, done }: {
  draft: Draft; setDraft: (d: Draft) => void; recipients: Recipient[]; templates: Tpl[]; actions: Actions; back: () => void; done: (id: string) => void;
}) {
  const [plan, setPlan] = useState<{ loading: boolean; data?: Plan; error?: ApiError }>({ loading: true });
  const [sendErr, setSendErr] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, start] = useTransition();
  const [testTo, setTestTo] = useState("");
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, startTest] = useTransition();
  const tpl = templates.find((t) => t.id === draft.template_id);
  const cap = draft.max_per_day;
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setPlan((p) => ({ ...p, loading: true }));
    const t = setTimeout(() => {
      actions.create(draft, recipients, true).then((r) => n === seq.current && setPlan(r.error ? { loading: false, error: r.error } : { loading: false, data: r.data }));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cap]);
  const p = plan.data;
  const byReason = useMemo(() => {
    const m = new Map<string, number>();
    p?.skipped.forEach((s) => m.set(s.reason, (m.get(s.reason) ?? 0) + 1));
    return [...m];
  }, [p]);

  function send() {
    setSendErr(null);
    start(async () => {
      const r = await actions.create(draft, recipients, false);
      if (r.error) return setSendErr(r.error);
      done(r.data.id);
    });
  }
  function test() {
    setTestMsg(null);
    const addr = testTo.trim();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) return setTestMsg({ ok: false, text: "Enter a valid email address to send the test to." });
    startTest(async () => {
      const first = recipients[0];
      const pv = await actions.preview(draft, first);
      if (pv.error) return setTestMsg({ ok: false, text: `${pv.error.message}${pv.error.hint ? ` ${pv.error.hint}` : ""}` });
      const r = await actions.sendTest({ from: draft.from.trim(), to: [addr], stream: draft.stream, subject: pv.data!.subject, template: { id: draft.template_id, variables: varsOf(first) } });
      setTestMsg(r.error ? { ok: false, text: `${r.error.code}: ${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ""}` } : { ok: true, text: `Test sent to ${addr}, personalized as ${first.email}.` });
    });
  }

  const n = p?.queued ?? 0;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <Card>
        <CardHeader title="Check before sending" description="Nothing is sent until you confirm." />
        <CardBody className="grid gap-5">
          <KeyValue items={[
            ["Template", tpl?.name ?? tpl?.alias ?? draft.template_id],
            ["From", <span key="f" className="font-mono text-xs">{draft.from}</span>],
            ["Subject", draft.subject?.trim() || <span key="s" className="text-muted">template’s own</span>],
            ["Stream", draft.stream],
            ["Recipients", `${recipients.length} ${recipients.length === 1 ? "address" : "addresses"}`],
          ]} />
          <div aria-live="polite" aria-busy={plan.loading} className="grid gap-3">
            {plan.error ? <ErrorState error={plan.error} />
              : !p ? <Skeleton className="h-24 w-full" />
                : (
                  <div className={cn("grid gap-3 text-sm", plan.loading && "opacity-60")}>
                    <p><strong className="tabular-nums">{p.queued}</strong> will be queued{p.skipped.length > 0 && <>, <strong className="tabular-nums">{p.skipped.length}</strong> left out</>}.</p>
                    {byReason.length > 0 && (
                      <details open={byReason.length <= 3}>
                        <summary className="inline-flex h-7 cursor-pointer items-center text-muted underline underline-offset-2 pointer-coarse:h-11">Why some were left out</summary>
                        <ul className="mt-2 grid gap-1 text-xs">{byReason.map(([r, c]) => (
                          <li key={r}><strong className="tabular-nums">{c}</strong> {REASON[r] ?? r}
                            <span className="text-muted"> · {p.skipped.filter((s) => s.reason === r).slice(0, 3).map((s) => s.email + (s.detail ? ` (${s.detail})` : "")).join(", ")}{c > 3 ? ", …" : ""}</span></li>
                        ))}</ul>
                      </details>
                    )}
                    {p.schedule?.daily_cap ? (
                      <p className="rounded-md border border-border bg-surface-2 p-3">
                        Paced at <strong>{p.schedule.daily_cap}</strong> a day ({every(p.schedule.spacing_seconds)}) to stay under your sending limit.
                        The first goes out {new Date(p.schedule.first_at).getTime() - Date.now() < 60_000 ? "now" : `at ${when(p.schedule.first_at)}`}, the last around {when(p.schedule.last_at)}.
                      </p>
                    ) : (
                      <p className="rounded-md border border-warn/40 bg-warn-bg p-3 text-warn">
                        No daily limit is set on your delivery transport, so all {p.queued} go out as fast as rate limits allow. Set a limit below if your mailbox has a daily cap.
                      </p>
                    )}
                  </div>
                )}
            <Field label="Limit per day (optional)" description="Spreads the broadcast out. The lowest of this and your transport’s daily cap applies.">
              {(a) => <Input {...a} type="number" inputMode="numeric" min={1} className="max-w-40" value={cap ?? ""} onChange={(e) => setDraft({ ...draft, max_per_day: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : undefined })} />}
            </Field>
          </div>
          {sendErr && <ErrorState error={sendErr} />}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <Button variant="secondary" onClick={back}><ChevronLeft aria-hidden />Back</Button>
            <Button onClick={() => setConfirm(true)} disabled={!n || !!plan.error || plan.loading} loading={busy}><Send aria-hidden />Send to {n} {n === 1 ? "recipient" : "recipients"}</Button>
          </div>
        </CardBody>
      </Card>

      <Card className="self-start">
        <CardHeader title="Send a test first" description={`Sends one email to you, personalized as ${recipients[0]?.email ?? "the first recipient"}.`} />
        <CardBody className="grid gap-3">
          <Field label="Send test to" error={testMsg && !testMsg.ok ? testMsg.text : undefined}>{(a) => <Input {...a} inputMode="email" autoComplete="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />}</Field>
          <div><Button variant="secondary" onClick={test} loading={testing}>Send test</Button></div>
          {testMsg?.ok && <p role="status" className="text-sm text-ok">{testMsg.text}</p>}
        </CardBody>
      </Card>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent destructive={false} title={`Send to ${n} ${n === 1 ? "recipient" : "recipients"}?`}
          description={`This queues ${n} ${n === 1 ? "email" : "emails"} from ${draft.from.trim()} using “${tpl?.name ?? tpl?.alias}”. ${p?.schedule?.daily_cap ? `They go out over time, ending around ${when(p.schedule.last_at)}.` : "They start going out right away."} The kill switch can pause everything.`}
          confirmLabel={`Send to ${n} ${n === 1 ? "recipient" : "recipients"}`} onConfirm={send} />
      </AlertDialog>
    </div>
  );
}
