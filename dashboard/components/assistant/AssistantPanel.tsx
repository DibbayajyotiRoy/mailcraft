"use client";
import { BotAvatar } from "bot-avatars";
import { Sparkles, Trash2, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Dialog as D } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import type { DoneStats } from "@/lib/assistant/types";
import { Composer } from "./Composer";
import { Markdown, splitNext } from "./Markdown";
import { hasPlaceholders } from "./VariablesSection";
import { ProposalCard } from "./ProposalCard";
import { Steps } from "./Steps";
import { useAssistant, useStatus, type Msg, type Status } from "./useAssistant";

/** Starter prompts follow the page: a template page leads with fixing it, an email page with its bounce. */
export function starters(path: string): string[] {
  const base = ["Set up a welcome email for new signups", "Send the Testing template to my Webinar list"];
  if (/^\/templates\/[^/]+/.test(path)) return ["Fix the lint errors in this template", "Make the subject line shorter", base[0]];
  if (/^\/emails\/[^/]+/.test(path)) return ["Why did this email bounce?", "What happened to this email?", base[0]];
  if (/^\/automations\/[^/]+/.test(path)) return ["How is this automation doing?", "Why is this failing?", base[1]];
  if (/^\/broadcasts\/[^/]+/.test(path)) return ["How is this broadcast doing?", "Which recipients bounced and why?", base[0]];
  return ["Set up a welcome email for new signups", "Fix the lint errors in my templates", base[1]];
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** Footer line: model, tokens, requests and times of the last turn, plus the locally counted daily requests. */
function UsageLine({ stats, status }: { stats?: DoneStats; status: Status | null }) {
  const bits = [
    stats ? `${k(stats.prompt || stats.est_input)} in / ${k(stats.completion)} out` : "",
    stats ? `${stats.rounds} request${stats.rounds === 1 ? "" : "s"}` : "",
    stats?.ttft_ms ? `first token ${secs(stats.ttft_ms)}` : "",
    stats ? `${secs(stats.total_ms)} total` : "",
    status?.requests_today ? `${status.requests_today} today (counted here)` : "",
    typeof status?.key?.limit_remaining === "number" ? `${status.key.limit_remaining} left on the key` : "",
  ].filter(Boolean);
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-subtle" aria-label="Usage of the last reply">
      <span>Free models only</span>{bits.length > 0 && <span className="tabular-nums">{bits.join(" · ")}</span>}
      <Link href="/settings#ai-usage" className="underline underline-offset-2 hover:text-fg">AI usage</Link>
    </p>
  );
}

function Setup({ status }: { status: Status }) {
  const bad = status.model?.error;
  return (
    <div className="space-y-3 text-base">
      <h3 className="text-md font-semibold">{bad ? "The assistant cannot start" : "The assistant is off"}</h3>
      {bad ? <p>{bad.message} {bad.hint}</p> : (
        <>
          <p>It runs on OpenRouter, server-side. A free OpenRouter key is enough: set it on the dashboard server and restart.</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs">OPENROUTER_API_KEY=sk-or-…</pre>
          <p className="text-sm text-muted">Only free, open-weight models that support tools are used (free models can be slow and are rate-limited per day). Pin one with <code className="font-mono">MAILCRAFT_ASSISTANT_MODEL</code>; anything that is not free is refused.</p>
        </>
      )}
      <Link href="/settings#ai-usage" className="text-accent underline underline-offset-2">See AI usage in Settings</Link>
    </div>
  );
}

function Message({ m, last, busy, phase, onApply, onCancel, onEdit, onDraft, onAsk }: {
  m: Msg; last: boolean; busy: boolean; phase: ReturnType<typeof useAssistant>["phase"];
  onApply: (pid: string, confirmed: boolean) => void; onCancel: (pid: string) => void; onEdit: (title: string) => void; onDraft: (text: string) => void; onAsk: (t: string) => void;
}) {
  if (m.role === "user") return <li className="flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-3 py-2 text-base">{m.text}</p></li>;
  const running = busy && last, { body, next } = splitNext(m.text);
  return (
    <li className="flex gap-2.5">
      {/* still avatar: the live one is in the header, and the orb below is this message's only moving part */}
      <span className="mt-0.5 size-6 shrink-0" aria-hidden><BotAvatar type="droid" size={24} paused interactive={false} /></span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <Steps steps={m.steps} running={running} phase={phase} />
        {body && <Markdown text={body} />}
        {m.stopped && <p className="text-sm text-muted">Stopped.</p>}
        {m.error && (
          <div role="alert" className="rounded-md bg-bad-bg px-3 py-2 text-sm text-bad"><p className="font-medium">{m.error.message}</p>{m.error.hint && <p>{m.error.hint}</p>}</div>
        )}
        {m.cards.map((c) => (
          <ProposalCard key={c.proposal.id} card={c} onApply={(ok) => onApply(c.proposal.id, ok)} onCancel={() => onCancel(c.proposal.id)} onEdit={() => onEdit(c.proposal.title)} onTweak={onDraft} />
        ))}
        {last && !busy && next.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested follow-ups">
            {next.map((t) => <button key={t} type="button" onClick={() => onAsk(t)} className="min-h-7 rounded-full border border-border bg-surface px-3 py-1 text-left text-sm hover:bg-surface-2 pointer-coarse:min-h-11">{t}</button>)}
          </div>
        )}
      </div>
    </li>
  );
}

/** Header button (also Cmd/Ctrl+K) and the right-hand panel. The conversation lives in sessionStorage; the server keeps nothing. */
export function AssistantLauncher() {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(""), [mac, setMac] = useState(false);
  const path = usePathname(), router = useRouter();
  const a = useAssistant(path, () => router.refresh());
  const status = useStatus(open);
  const input = useRef<HTMLTextAreaElement | null>(null), scroller = useRef<HTMLDivElement>(null), stick = useRef(true);
  const draftFor = (t: string) => { setDraft(t); requestAnimationFrame(() => input.current?.focus()); };

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform));
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); } };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [a.msgs, a.phase]);

  const off = status?.configured === false || !!status?.model?.error;
  const lastStats = [...a.msgs].reverse().find((m) => m.stats)?.stats;
  const lastBot = a.msgs.at(-1);
  const announce = a.busy ? a.phase?.label ?? "Thinking…" : lastBot?.role === "assistant" ? (lastBot.cards.length ? `Proposal ready: ${lastBot.cards.at(-1)!.proposal.title}${hasPlaceholders(lastBot.cards.at(-1)!.proposal.variables) ? ". It needs a value before it can be sent." : ""}` : lastBot.error ? lastBot.error.message : lastBot.text ? "Reply ready" : "") : "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <D.Trigger asChild>
        <Button variant="ghost" aria-label="Assistant" aria-keyshortcuts="Control+K Meta+K" className="gap-1.5">
          <Sparkles aria-hidden /><span className="max-md:sr-only">Assistant</span>
          <kbd className="hidden rounded-sm border border-border px-1 font-sans text-xs text-muted lg:inline">{mac ? "⌘K" : "Ctrl K"}</kbd>
        </Button>
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-fade-in" />
        <D.Content onOpenAutoFocus={(e) => { e.preventDefault(); input.current?.focus(); }}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(480px,100%)] flex-col border-l border-border bg-bg shadow-pop focus:outline-none data-[state=open]:animate-fade-in max-sm:w-full max-sm:border-l-0">
          <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <span className="size-7 shrink-0" aria-hidden><BotAvatar type="droid" size={28} state={a.busy ? "working" : "default"} interactive={false} /></span>
            <D.Title className="text-md font-semibold">Assistant</D.Title>
            <D.Description className="sr-only">Ask in plain language to set up automations and broadcasts, fix templates, manage contacts and understand your mail. It proposes changes; you apply them.</D.Description>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Clear conversation" disabled={!a.msgs.length} onClick={() => { a.clear(); input.current?.focus(); }}><Trash2 aria-hidden /></Button>
              <D.Close asChild><Button variant="ghost" size="icon" aria-label="Close assistant"><X aria-hidden /></Button></D.Close>
            </div>
          </header>

          <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto px-3 py-4" tabIndex={-1}>
            {off && status ? <Setup status={status} /> : a.msgs.length === 0 ? (
              <div className="space-y-4">
                <div><h3 className="text-md font-semibold">What would you like to do?</h3><p className="mt-1 text-sm text-muted">I can set up automations and broadcasts, fix templates, manage contacts and lists, and explain why an email bounced. I propose every change first; nothing happens until you press Apply.</p></div>
                <ul className="flex flex-col gap-2" aria-label="Starter prompts">
                  {starters(path).map((s) => <li key={s}><button type="button" onClick={() => void a.send(s)} className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-left text-base hover:bg-surface-2 pointer-coarse:min-h-11">{s}</button></li>)}
                </ul>
              </div>
            ) : (
              <div role="log" aria-label="Conversation" aria-live="off"><ol className="space-y-4">
                {a.msgs.map((m, i) => (
                  <Message key={m.id} m={m} last={i === a.msgs.length - 1} busy={a.busy} phase={a.phase} onAsk={(t) => void a.send(t)}
                    onApply={(pid, ok) => void a.apply(m.id, pid, ok)} onCancel={(pid) => a.cancel(m.id, pid)}
                    onEdit={(title) => draftFor(`Change the proposal "${title}": `)} onDraft={draftFor} />
                ))}
              </ol></div>
            )}
          </div>
          <div className="sr-only" role="status" aria-live="polite">{announce}</div>

          <footer className={cn("space-y-2 border-t border-border px-3 pb-3 pt-2.5")}>
            <Composer busy={a.busy} disabled={off} model={status?.model?.chain?.[0]} draft={draft} setDraft={setDraft} onSend={(t) => void a.send(t)} onStop={a.stop} inputRef={input} />
            <UsageLine stats={lastStats} status={status} />
          </footer>
        </D.Content>
      </D.Portal>
    </Dialog>
  );
}
