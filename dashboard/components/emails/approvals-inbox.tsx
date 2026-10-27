"use client";
import { ArrowLeft, Check, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { AlertDialog, AlertDialogContent, Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { KeyValue } from "@/components/ui/stat-card";
import { RelativeTime } from "@/components/ui/relative-time";
import { MessagePreview } from "@/components/monitor/message-preview";
import { cn } from "@/lib/cn";
import { truncateId } from "@/lib/format";

export type Approval = { id: string; kind: string; status: string; requested_by?: string | null; created_at: string; reason?: string | null; payload?: any };
type Decision = "approve" | "reject";
const WHY: Record<string, string> = { email: "Policy requires approval", automation_first_send: "First send of an automation", go_live: "Request to go live" };
const KIND: Record<string, string> = { email: "Email", automation_first_send: "Automation", go_live: "Go live" };

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Two-pane approvals inbox. J/K move, A/R open the confirm dialog. Mobile: list, then a drill-in detail. */
export function ApprovalsInbox({ approvals, canDecide, decide }: { approvals: Approval[]; canDecide: boolean; decide: (d: FormData) => Promise<void> }) {
  const [sel, setSel] = useState<string | null>(approvals[0]?.id ?? null);
  const [drill, setDrill] = useState(false);
  const [confirm, setConfirm] = useState<Decision | null>(null);
  const [busy, start] = useTransition();
  const [reason, setReason] = useState("");
  const lastIdx = useRef(0);
  const idx = Math.max(0, approvals.findIndex((a) => a.id === sel));
  // After a decision the item leaves the list: auto-advance to whatever now sits at the same position.
  const cur = approvals.find((a) => a.id === sel) ?? approvals[Math.min(lastIdx.current, approvals.length - 1)];
  useEffect(() => { if (approvals.some((a) => a.id === sel)) lastIdx.current = idx; else { setSel(cur?.id ?? null); setDrill(false); } }, [approvals, sel, idx, cur]);

  const move = (d: number) => { const n = approvals[Math.min(approvals.length - 1, Math.max(0, idx + d))]; if (n) setSel(n.id); };
  const pending = cur?.status === "pending";
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || confirm) return;
      const k = e.key.toLowerCase();
      if (k === "j") move(1); else if (k === "k") move(-1);
      else if (canDecide && pending && k === "a") setConfirm("approve");
      else if (canDecide && pending && k === "r") setConfirm("reject");
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  function submit(decision: Decision) {
    if (!cur) return;
    const fd = new FormData(); fd.set("id", cur.id); fd.set("decision", decision);
    if (decision === "reject" && reason.trim()) fd.set("reason", reason.trim());
    start(() => decide(fd));
  }

  const pv = cur?.payload?.preview;
  const nRecipients = Array.isArray(cur?.payload?.email_ids) ? cur.payload.email_ids.length : undefined;
  return (
    <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section aria-label="Pending approvals" className={cn("min-w-0", drill && "max-lg:hidden")}>
        <ul className="grid gap-1.5">
          {approvals.map((a) => {
            const p = a.payload?.preview;
            return (
              <li key={a.id}>
                <button type="button" data-ui="button" aria-current={a.id === cur?.id ? "true" : undefined} onClick={() => { setSel(a.id); setDrill(true); }}
                  className="grid w-full gap-1 rounded-lg border border-border bg-surface p-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 aria-[current=true]:border-accent aria-[current=true]:bg-accent-soft pointer-coarse:min-h-11">
                  <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{p?.subject ?? KIND[a.kind] ?? a.kind}</span><RelativeTime value={a.created_at} className="shrink-0 text-xs text-muted" /></span>
                  <span className="truncate font-mono text-xs text-muted">{a.payload?.to ?? KIND[a.kind] ?? a.kind}</span>
                  <span className="flex flex-wrap gap-1.5"><Badge size="sm">{KIND[a.kind] ?? a.kind}</Badge><Badge size="sm" tone="warn">{WHY[a.kind] ?? "Held for review"}</Badge></span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 hidden text-xs text-muted lg:block">Shortcuts: <kbd className="rounded-sm border border-border px-1">J</kbd>/<kbd className="rounded-sm border border-border px-1">K</kbd> move, <kbd className="rounded-sm border border-border px-1">A</kbd> approve, <kbd className="rounded-sm border border-border px-1">R</kbd> reject.</p>
      </section>

      {cur && (
        <section aria-label="Approval detail" className={cn("min-w-0 rounded-lg border border-border bg-surface", !drill && "max-lg:hidden")}>
          <div className="grid gap-5 p-4">
            <Button variant="ghost" className="justify-self-start lg:hidden" onClick={() => setDrill(false)}><ArrowLeft aria-hidden />All approvals</Button>
            <div>
              <h2 className="text-md font-semibold">{pv?.subject ?? KIND[cur.kind] ?? cur.kind}</h2>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted"><StatusBadge status={cur.status} /><span>{WHY[cur.kind] ?? "Held for review"}</span></p>
            </div>
            {pv ? <MessagePreview html={pv.html} text={pv.text ?? pv.text_full} title={`Preview of ${pv.subject ?? "email"}`} /> : null}
            {pv && !pv.text && !pv.html && <p className="text-sm text-muted">This email has an HTML body only; open it after approval to see it rendered.</p>}
            <KeyValue items={[
              ["Kind", KIND[cur.kind] ?? cur.kind],
              ...(cur.payload?.from ? [["From", <span key="f" className="font-mono text-xs">{cur.payload.from}</span>] as [string, React.ReactNode]] : []),
              ...(cur.payload?.to ? [["To", <span key="t" className="font-mono text-xs">{cur.payload.to}</span>] as [string, React.ReactNode]] : []),
              ...(nRecipients !== undefined ? [["Recipients", nRecipients] as [string, React.ReactNode]] : []),
              ["Requested by", cur.requested_by ? <span key="r" className="font-mono text-xs" title={cur.requested_by}>key {truncateId(cur.requested_by, 6, 4)}</span> : "System"],
              ["Created", <RelativeTime key="c" value={cur.created_at} />],
            ]} />
            {!pv && <details className="text-sm"><summary className="inline-flex h-7 items-center text-muted underline underline-offset-2 pointer-coarse:h-11">View raw payload</summary><pre tabIndex={0} className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[12.5px] leading-5">{JSON.stringify(cur.payload, null, 2)}</pre></details>}
          </div>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-b-lg border-t border-border bg-surface p-3">
            {!canDecide && <p className="mr-auto text-sm text-muted">Only an admin key can approve or reject. Sign in with an admin key to decide.</p>}
            {canDecide && pending && <p className="mr-auto hidden text-xs text-muted sm:block">Agents cannot decide approvals.</p>}
            <Button variant="danger-outline" disabled={!canDecide || !pending || busy} onClick={() => setConfirm("reject")}><X aria-hidden />Reject</Button>
            <Button variant="approve" disabled={!canDecide || !pending || busy} loading={busy} onClick={() => setConfirm("approve")}><Check aria-hidden />Approve</Button>
          </div>
        </section>
      )}

      <AlertDialog open={confirm === "approve"} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        {confirm === "approve" && (
          <AlertDialogContent title="Approve this email?" description="It is queued and sent right away." confirmLabel="Approve" destructive={false} onConfirm={() => submit("approve")} />
        )}
      </AlertDialog>
      <Dialog open={confirm === "reject"} onOpenChange={(o) => { if (!o) { setConfirm(null); setReason(""); } }}>
        <DialogContent title="Reject this email?" description="It is cancelled and will not be sent. This cannot be undone."
          footer={<><DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose><Button variant="danger" onClick={() => submit("reject")}>Reject</Button></>}>
          <Field label="Reason (optional)" description={`${reason.length}/500. Recorded in the audit log and shown to the requester.`}>
            {(a) => <Textarea {...a} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </DialogContent>
      </Dialog>
    </div>
  );
}
