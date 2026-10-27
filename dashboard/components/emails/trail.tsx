import Link from "next/link";
import type { ReactNode } from "react";
import { EventTimeline, type TimelineEvent } from "@/components/ui/event-timeline";
import { StatusBadge } from "@/components/ui/badge";
import { explainDiagnostic, gap, policyTone } from "@/components/monitor/helpers";

export type MailEvent = { type: string; enhanced_code?: string | null; diagnostic?: string | null; occurred_at: string };
const PROBLEM = new Set(["bounced", "failed", "deferred", "complained", "suppressed"]);

/** The server's own words, with the SMTP code picked out in mono and a plain-English line + tip. */
export function BounceCallout({ code, text, status }: { code?: string | null; text?: string | null; status: string }) {
  const why = explainDiagnostic(code, text);
  const tone = status === "deferred" ? "border-warn/30 bg-warn-bg text-warn" : "border-bad/40 bg-bad-bg text-bad";
  return (
    <div className={`mt-2 rounded-md border p-3 text-sm ${tone}`}>
      <p className="font-medium">{why.title}</p>
      {(code || text) && (
        <p className="mt-1 break-words font-mono text-xs text-fg">
          {code && <strong className="mr-2 rounded-sm bg-surface-3 px-1">{code}</strong>}{text}
        </p>
      )}
      <p className="mt-1.5"><span className="font-medium">What to do:</span> {why.tip}</p>
    </div>
  );
}

/** The envelope trail for one email: events with +gap between them and diagnostics inline. */
export function EmailTrail({ events, status, approvalHref, label = "Delivery timeline" }: { events: MailEvent[]; status?: string; approvalHref?: string; label?: string }) {
  const list: TimelineEvent[] = events.map((x, i) => {
    const g = i > 0 ? gap(events[i - 1].occurred_at, x.occurred_at) : "";
    const detail: ReactNode = (g || PROBLEM.has(x.type) || (x.type === "pending_approval" && approvalHref)) ? (
      <>
        {g && <span className="font-mono text-xs" title="Time since the previous event">{g}</span>}
        {PROBLEM.has(x.type) && (x.diagnostic || x.enhanced_code || x.type === "bounced") && <BounceCallout code={x.enhanced_code} text={x.diagnostic} status={x.type} />}
        {x.type === "pending_approval" && approvalHref && <Link href={approvalHref} className="ml-2 text-accent underline underline-offset-2">Review approval</Link>}
      </>
    ) : undefined;
    return { status: x.type, at: x.occurred_at, detail };
  });
  if (!list.length) return <p className="text-sm text-muted">{status === "pending_approval" ? "Waiting for approval before anything happens." : "No events yet. They appear as the message moves through delivery."}</p>;
  return <EventTimeline events={list} label={label} />;
}

export function PolicyDecisions({ decisions }: { decisions: any[] }) {
  if (!decisions.length) return <p className="text-sm text-muted">No policy rules fired.</p>;
  return (
    <>
      <ul className="grid gap-2.5">
        {decisions.map((d, i) => {
          const { rule, decision, ...rest } = d ?? {};
          const reason = rest.reason ?? rest.detail ?? Object.entries(rest).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${k}: ${v}`).join(", ");
          return (
            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
              <span className="font-mono text-xs">{String(rule ?? "rule")}</span>
              <StatusBadge status={policyTone(String(decision ?? "pass"))} size="sm" />
              {reason && <span className="w-full text-xs text-muted">{reason}</span>}
            </li>
          );
        })}
      </ul>
      <details className="mt-3 text-sm">
        <summary className="inline-flex h-7 items-center text-muted underline underline-offset-2 hover:text-fg pointer-coarse:h-11">View raw</summary>
        <pre tabIndex={0} className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[12.5px] leading-5">{JSON.stringify(decisions, null, 2)}</pre>
      </details>
    </>
  );
}
