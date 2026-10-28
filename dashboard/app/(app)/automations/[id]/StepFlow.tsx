import type { ReactNode } from "react";
import { ArrowDown, CircleStop, Clock, GitBranch, Hourglass, Mail, Sparkles, Tag, UserPen, Users, Zap } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { ruleWords } from "@/lib/rules";
import { StepStats, type StepStat } from "../editor/StepStats";
import { branchLabels, durationWords, flowSteps, triggerWords, type Slot, type Step } from "./steps";

const TYPE_LABEL: Record<string, string> = {
  trigger: "Trigger", condition: "Condition", delay: "Wait", wait_for_event: "Wait for event", send_email: "Send email",
  update_contact: "Update contact", add_to_segment: "Add to segment", exit: "Exit",
};

function Node({ icon: Icon, tone = "neutral", type, id, children, className }: { icon: typeof Zap; tone?: "accent" | "neutral"; type: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("w-full rounded-lg border border-border bg-bg p-4 shadow-[0_1px_2px_rgb(0_0_0/.04)]", className)}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn("grid size-7 place-items-center rounded-md", tone === "accent" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}><Icon className="size-4" /></span>
        <h3 className="text-sm font-medium">{TYPE_LABEL[type] ?? type}</h3>
        <code className="ml-auto truncate text-xs text-subtle">{id}</code>
      </div>
      <div className="mt-3 grid gap-2 text-sm">{children}</div>
    </div>
  );
}

function Pill({ icon: Icon, children }: { icon: typeof Clock; children: ReactNode }) {
  return <div className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted"><Icon aria-hidden className="size-3.5 shrink-0" /><span className="min-w-0 break-words">{children}</span></div>;
}

function SendNode({ s, slots }: { s: Step; slots?: Slot[] }) {
  const c = s.config ?? {}, llm = c.mode === "llm";
  return (
    <Node icon={Mail} tone="accent" type="send_email" id={s.key}>
      <p>Template <Link href={`/templates/${encodeURIComponent(c.template ?? "")}`} className="font-mono text-[12.5px] text-accent hover:underline">{c.template}</Link>
        {c.subject && <> · subject “{c.subject}”</>}</p>
      <div className="flex flex-wrap items-center gap-2">
        {llm ? <Badge tone="info"><Sparkles aria-hidden className="size-3" />AI-written</Badge> : <Badge tone="neutral">Static copy</Badge>}
        {c.topic && <Badge tone="neutral">topic: {c.topic}</Badge>}
        {c.from && <span className="text-xs text-muted">from {c.from}</span>}
      </div>
      {llm && (
        <>
          <div>
            <p className="text-xs font-medium text-muted">Slots the model writes</p>
            {slots && slots.length ? (
              <ul className="mt-1.5 grid gap-1.5">
                {slots.map((sl) => (
                  <li key={sl.name} className="rounded-md bg-surface-2 px-3 py-2 text-xs">
                    <code className="font-medium text-fg">{sl.name}</code>{sl.max_len != null && <span className="text-muted"> · up to {sl.max_len} characters</span>}
                    {sl.fallback && <p className="mt-0.5 text-muted">Fallback: {sl.fallback}</p>}
                  </li>
                ))}
              </ul>
            ) : <p className="mt-1 text-xs text-muted">Slots are defined in the template; none could be read.</p>}
          </div>
          {c.instructions && <div><p className="text-xs font-medium text-muted">Step instructions</p><p className="mt-1 whitespace-pre-wrap text-sm">{c.instructions}</p></div>}
          <div>
            <p className="text-xs font-medium text-muted">Extra instructions <span className="font-normal">(read-only)</span></p>
            {c.custom_instructions
              ? <p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">{c.custom_instructions}</p>
              : <p className="mt-1 text-sm text-muted">None. Workspace instructions apply.</p>}
          </div>
        </>
      )}
    </Node>
  );
}

function StepNode({ s, slots }: { s: Step; slots?: Slot[] }) {
  const c = s.config ?? {};
  switch (s.type) {
    case "trigger": return <Node icon={Zap} tone="accent" type="trigger" id={s.key}><p>{triggerWords(c)}</p></Node>;
    case "send_email": return <SendNode s={s} slots={slots} />;
    case "delay": return <Pill icon={Clock}>Wait {durationWords(c.duration)}</Pill>;
    case "wait_for_event": return (
      <div className="grid justify-items-center gap-1.5">
        <Pill icon={Hourglass}>Wait up to {durationWords(c.timeout)} for “{c.event}”{ruleWords(c.filter) ? ` when ${ruleWords(c.filter)}` : ""}</Pill>
        {branchLabels(s.next).length > 0 && <ul className="flex flex-wrap justify-center gap-2">{branchLabels(s.next).map(([k, v]) => <li key={k}><Badge tone="neutral">{k} → <code>{v}</code></Badge></li>)}</ul>}
      </div>
    );
    case "condition": return (
      <Node icon={GitBranch} type="condition" id={s.key}>
        <p>If {ruleWords(c.rule) ?? "the condition holds"}</p>
        {branchLabels(s.next).length > 0 && <ul className="flex flex-wrap gap-2">{branchLabels(s.next).map(([k, v]) => <li key={k}><Badge tone="neutral">{k} → <code>{v}</code></Badge></li>)}</ul>}
      </Node>
    );
    case "update_contact": return (
      <Node icon={UserPen} type="update_contact" id={s.key}>
        <ul className="grid gap-1">{Object.entries(c.set ?? {}).map(([k, v]) => <li key={k}>Set <code className="text-[12.5px]">{k}</code> to <code className="text-[12.5px]">{String(v)}</code></li>)}</ul>
      </Node>
    );
    case "add_to_segment": return <Node icon={Users} type="add_to_segment" id={s.key}><p>Add the contact to segment “{c.segment}”</p></Node>;
    case "exit": return <Node icon={CircleStop} type="exit" id={s.key}><p>The run ends{c.reason ? `: ${c.reason}` : "."}</p></Node>;
    default: return <Node icon={Tag} type={s.type} id={s.key}><p className="text-muted">Unknown step type.</p></Node>;
  }
}

/** Read-only vertical flow, plain CSS. Slots are passed in per template alias; `stats` (per step key) adds the contact counts under each step. */
export function StepFlow({ automation, slots, stats }: { automation: any; slots: Record<string, Slot[]>; stats?: Record<string, StepStat> | null }) {
  const steps = flowSteps(automation);
  if (!steps.length) return <p className="text-sm text-muted">This automation has no steps.</p>;
  return (
    <ol aria-label="Automation steps" className="mx-auto grid max-w-[560px] justify-items-center rounded-lg bg-surface-2 p-4 sm:p-8 [background-image:radial-gradient(var(--border-strong)_1px,transparent_1px)] [background-size:16px_16px]">
      {steps.map((s, i) => (
        <li key={s.key + i} id={`step-${s.key}`} tabIndex={-1} aria-label={`${TYPE_LABEL[s.type] ?? s.type} ${s.key}`} className="grid w-full scroll-mt-20 justify-items-center rounded-lg focus:outline-2 focus:outline-offset-4 focus:outline-accent">
          {i > 0 && <div aria-hidden className="flex h-8 flex-col items-center text-border-strong"><span className="w-0.5 flex-1 bg-current" /><ArrowDown className="-mt-1 size-3.5" /></div>}
          <StepNode s={s} slots={slots[s.config?.template]} />
          {stats && <StepStats stat={stats[s.key]} className="mt-2 [&_dl]:justify-center" />}
        </li>
      ))}
    </ol>
  );
}
