"use client";
// "Write with AI" in the New email dialog: a prompt row, a status row, and fields that fill live while the model writes.
// The model streams one JSON object; the server turns it into { field, delta } events (app/api/compose/write). Nothing is sent from here.
import { BorderBeam } from "border-beam";
import { Check, Circle, RefreshCw, Sparkles, Square, Undo2 } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useReducedMotion, useResolvedTheme } from "@/components/assistant/theme";
import { Button } from "@/components/ui/button";
import { Busy } from "@/components/ui/busy";
import { ErrorState } from "@/components/ui/error-state";
import { control } from "@/components/ui/field";
import type { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Compose } from "@/lib/compose";
import { shown } from "@/lib/assistant/reset";
import { applyField, doneLabel, restoreFields, shortName, snapshot, writingLabel, type Snap } from "@/lib/compose-ai/apply";
import { TONES, type Tone, type WriteEvent, type WriteRequest, type WriteUsage } from "@/lib/compose-ai/events";
import { fieldsFor } from "@/lib/compose-ai/prompt";

/** What the dialog knows that the model should too. Contact names only, never addresses. */
export type AiContext = { vars: string[]; fromName?: string; names: string[]; count: number };
type Phase = "idle" | "writing" | "done" | "stopped" | "error";
type State = { phase: Phase; fields: string[]; done: string[]; cur: string | null; started: boolean; incomplete: boolean; error?: ApiError; usage?: WriteUsage; announce: string };
const IDLE: State = { phase: "idle", fields: [], done: [], cur: null, started: false, incomplete: false, announce: "" };

/** One NDJSON event into the status state. Pure. */
function step(s: State, e: WriteEvent): State {
  if ("error" in e) return { ...s, phase: "error", cur: null, error: shown(e.error), incomplete: s.started, announce: s.started ? "The draft is incomplete. Edit it or regenerate before sending." : "" };
  if ("field" in e) {
    if ("delta" in e) return s.cur === e.field && s.started ? s : { ...s, started: true, cur: e.field };
    return s.done.includes(e.field) ? s : { ...s, started: true, done: [...s.done, e.field], cur: s.cur === e.field ? null : s.cur, announce: doneLabel(e.field) };
  }
  return { ...s, phase: "done", cur: null, usage: e.usage, announce: "Done. Written by AI: check it before you send." };
}

export type Writer = ReturnType<typeof useWriteWithAI>;

export function useWriteWithAI(c: Compose, setC: Dispatch<SetStateAction<Compose>>, ctx: AiContext) {
  const cRef = useRef(c), ctxRef = useRef(ctx);
  cRef.current = c; ctxRef.current = ctx;
  const abort = useRef<AbortController | null>(null), snap = useRef<Snap | null>(null), touched = useRef(new Set<string>());
  const last = useRef<{ prompt: string; tone?: Tone } | null>(null), t0 = useRef(0);
  const [s, setS] = useState<State>(IDLE);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (s.phase !== "writing") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [s.phase]);
  useEffect(() => () => abort.current?.abort(), []);

  const start = useCallback(async (prompt: string, tone?: Tone) => {
    const cur = cRef.current, x = ctxRef.current;
    abort.current?.abort();
    if (cur.mode === "template" && !cur.template) return setS({ ...IDLE, phase: "error", error: { code: "no_template", message: "Choose a template first.", hint: "Write with AI fills the template's variables." } });
    const ac = (abort.current = new AbortController());
    snap.current ??= snapshot(cur);
    last.current = { prompt, tone };
    const seen = new Set<string>();
    t0.current = Date.now(); setNow(t0.current);
    setS({ ...IDLE, phase: "writing", fields: fieldsFor(cur.mode, x.vars) });
    const live = () => abort.current === ac;
    try {
      const req: WriteRequest = { prompt, tone, mode: cur.mode, template: cur.mode === "template" ? cur.template : undefined, fromName: x.fromName, names: x.names, count: x.count };
      const res = await fetch("/api/compose/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req), signal: ac.signal });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        return live() ? setS((p) => ({ ...p, phase: "error", cur: null, error: { code: j.code ?? `http_${res.status}`, message: j.message ?? "Write with AI is unavailable.", hint: j.hint } })) : undefined;
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !live() || ac.signal.aborted) break;
        buf += dec.decode(value, { stream: true });
        const evs: WriteEvent[] = [];
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          try { if (line) evs.push(JSON.parse(line)); } catch { /* a garbled line is skipped */ }
        }
        if (!evs.length) continue;
        // One render per network read, however many events it carried.
        const ops: { field: string; chunk: string; replace: boolean }[] = [];
        for (const e of evs) if ("field" in e && "delta" in e && e.delta) { ops.push({ field: e.field, chunk: e.delta, replace: !seen.has(e.field) }); seen.add(e.field); touched.current.add(e.field); }
        if (ops.length) setC((p) => ops.reduce((acc, o) => applyField(acc, o.field, o.chunk, o.replace), p));
        setS((p) => evs.reduce(step, p));
      }
      if (live()) setS((p) => (p.phase !== "writing" ? p : ac.signal.aborted ? { ...p, phase: "stopped", cur: null } : { ...p, phase: "error", cur: null, incomplete: p.started, error: { code: "stream_closed", message: "The connection closed before the email was finished.", hint: "What was written is kept. Edit it, or Regenerate." } }));
    } catch (e) {
      if (!live()) return;
      if (ac.signal.aborted) return setS((p) => (p.phase === "writing" ? { ...p, phase: "stopped", cur: null } : p));
      setS((p) => ({ ...p, phase: "error", cur: null, incomplete: p.started, error: { code: "unreachable", message: `Could not reach the server: ${(e as Error).message}`, hint: "What was written is kept. Edit it, or Regenerate." } }));
    }
  }, [setC]);

  const stop = useCallback(() => {
    abort.current?.abort();
    setS((p) => (p.phase === "writing" ? { ...p, phase: "stopped", cur: null, announce: "Stopped. What was written is kept." } : p));
  }, []);
  /** The user changed a field themselves: the incomplete draft is theirs now, and Send is theirs again. */
  const edited = useCallback(() => setS((p) => (p.incomplete ? { ...p, incomplete: false } : p)), []);
  const reset = useCallback(() => { abort.current?.abort(); abort.current = null; snap.current = null; touched.current.clear(); setS(IDLE); }, []);
  const undo = useCallback(() => {
    const sn = snap.current, fields = [...touched.current];
    if (sn) setC((p) => restoreFields(p, sn, fields));
    snap.current = null; touched.current.clear();
    setS({ ...IDLE, announce: "Restored what was there before." });
  }, [setC]);

  const writing = s.phase === "writing";
  const active = writing && s.started ? s.cur ?? s.fields.find((f) => !s.done.includes(f)) ?? null : null;
  const ms = writing ? Math.max(0, (now || Date.now()) - t0.current) : s.usage?.ms ?? 0;
  return { ...s, writing, active, ms, canUndo: !writing && touched.current.size > 0, again: last.current, start, stop, undo, reset, edited };
}

const TONE_LABEL: Record<Tone, string> = { friendly: "Friendly", short: "Short", formal: "Formal" };
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** The button, the prompt row, and the status row. */
export function WriteWithAI({ ai, mode }: { ai: Writer; mode: Compose["mode"] }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(""), [tone, setTone] = useState<Tone | undefined>();
  const uid = useId();
  const go = () => { if (draft.trim() && !ai.writing) ai.start(draft.trim(), tone); };
  const showPrompt = ai.phase === "idle" || (ai.phase === "error" && !ai.canUndo);
  const vars = ai.fields.filter((f) => f.startsWith("var:"));
  // The control that had focus unmounts when the row changes: hand focus to Stop while writing, and back to Regenerate when it ends (unless the user moved on to a field).
  const stopRef = useRef<HTMLButtonElement>(null), againRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ai.phase === "writing") stopRef.current?.focus();
    else if (ai.phase !== "idle" && (!document.activeElement || document.activeElement === document.body)) againRef.current?.focus();
  }, [ai.phase]);
  return (
    <div className="grid gap-2">
      {showPrompt && !open && <div><Button variant="secondary" size="sm" aria-expanded={false} aria-controls={`${uid}-p`} onClick={() => setOpen(true)}><Sparkles aria-hidden />Write with AI</Button></div>}
      {showPrompt && open && (
        <div id={`${uid}-p`} className="grid gap-2 rounded-md border border-border bg-surface p-3">
          <label htmlFor={`${uid}-q`} className="text-sm font-medium">What should this email say?</label>
          <textarea id={`${uid}-q`} autoFocus rows={2} value={draft} maxLength={1000} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }}
            placeholder={mode === "template" ? "e.g. Welcome Ana and mention the setup call on Thursday" : "e.g. Invite Ana to Thursday's product demo"}
            className={cn(control(), "min-h-16 resize-y py-2")} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="group" aria-label="Tone" className="flex gap-1.5">
              {TONES.map((t) => (
                <button key={t} type="button" aria-pressed={tone === t} onClick={() => setTone(tone === t ? undefined : t)}
                  className={cn("h-7 rounded-full border px-3 text-xs font-medium transition-colors pointer-coarse:h-11", tone === t ? "border-accent bg-accent-soft text-fg" : "border-border-strong text-muted hover:text-fg")}>{TONE_LABEL[t]}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="sm" disabled={!draft.trim()} onClick={go}><Sparkles aria-hidden />Write</Button>
            </div>
          </div>
          <p className="text-xs text-muted">Free models write a draft into the fields below. Nothing is sent until you press Send.</p>
          {ai.error && <ErrorState error={ai.error} />}
        </div>
      )}
      {!showPrompt && (
        <div className="grid gap-2 rounded-md border border-border bg-surface p-3" data-ai-phase={ai.phase}>
          {ai.writing ? (
            <div className="flex items-center justify-between gap-2">
              <span aria-hidden="true" className="inline-flex items-center gap-3">
                <Busy state={ai.started ? "composing" : "working"} label={ai.active ? writingLabel(ai.active) : "Thinking…"} />
                <span className="text-xs tabular-nums text-subtle">{secs(ai.ms)}</span>
              </span>
              <Button ref={stopRef} variant="secondary" size="sm" onClick={ai.stop}><Square aria-hidden className="fill-current" />Stop</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="inline-flex items-center gap-2 text-sm text-muted"><Sparkles aria-hidden className="size-4 shrink-0 text-accent" />
                {ai.phase === "stopped" ? "Stopped. What was written is kept." : ai.phase === "error" ? `Stopped early. What was written is kept${ai.incomplete ? ", but it may be cut off. Edit it or Regenerate to send" : ""}.` : `Written by AI${ai.usage ? ` · ${ai.usage.tokens}${ai.usage.estimated ? "~" : ""} tokens · ${secs(ai.usage.ms)} · ${ai.usage.model.split("/").pop()?.replace(/:free$/, "")}` : ""}. Check it, then send.`}
              </p>
              <div className="flex gap-2">
                <Button ref={againRef} variant="secondary" size="sm" onClick={() => ai.again && ai.start(ai.again.prompt, ai.again.tone)}><RefreshCw aria-hidden />Regenerate</Button>
                {ai.canUndo && <Button variant="ghost" size="sm" onClick={ai.undo}><Undo2 aria-hidden />Undo AI</Button>}
              </div>
            </div>
          )}
          {vars.length > 0 && (
            <ul aria-label="Variables" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {vars.map((f) => {
                const st = ai.done.includes(f) ? "done" : ai.active === f ? "writing" : "waiting";
                return (
                  <li key={f} data-state={st} className="inline-flex items-center gap-1.5">
                    {st === "done" ? <Check aria-hidden className="size-3.5 text-ok" /> : <Circle aria-hidden className={cn("size-3.5", st === "writing" ? "text-accent" : "text-subtle")} />}
                    <code>{shortName(f)}</code><span className="sr-only">{st}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {ai.phase === "error" && ai.error && <ErrorState error={ai.error} />}
        </div>
      )}
      {/* Polite, and only when a field completes (or the run ends): never per token. */}
      <p className="sr-only" role="status" aria-live="polite" data-ai-live>{ai.announce}</p>
    </div>
  );
}

/** Wraps one form control: the beam runs under it while it is the field being written, with a caret after its text. The control itself stays mounted. */
export function Live({ ai, field, text, multiline, mono, children }: { ai: Writer; field: string; text: string; multiline?: boolean; mono?: boolean; children: ReactNode }) {
  const on = ai.active === field, theme = useResolvedTheme(), reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null), ghost = useRef<HTMLDivElement>(null);
  const caret: ReactNode = on ? <span aria-hidden data-caret={reduced ? "still" : "blink"} className={cn("visible ml-px inline-block h-[1.1em] w-[2px] translate-y-[2px] bg-accent", !reduced && "animate-caret")} /> : null;
  // A one-line field scrolls to its end while it grows; the caret overlay follows.
  useLayoutEffect(() => {
    const el = box.current?.querySelector("input");
    if (on && !multiline && el && ghost.current) { el.scrollLeft = el.scrollWidth; ghost.current.scrollLeft = el.scrollLeft; }
  }, [on, text, multiline]);
  return (
    <div data-live-field={field} data-streaming={String(on)}>
      <BorderBeam active={on && !reduced} size="line" colorVariant="ocean" theme={theme} strength={0.85} borderRadius={6} className="block w-full">
        {multiline ? (
          // The mirror sizes the grid cell, so the box grows with the text (no scrollbar to throw the caret off) and the caret sits right after the last character.
          <div ref={box} className="grid [&>textarea]:[grid-area:1/1] [&>textarea]:resize-none [&>textarea]:overflow-hidden">
            <div aria-hidden className={cn(control({ mono }), "invisible whitespace-pre-wrap break-words py-2 [grid-area:1/1]")}>{text}{"​"}{caret}</div>
            {children}
          </div>
        ) : (
          <div ref={box} className="relative">
            {children}
            {on && <div ref={ghost} aria-hidden className="pointer-events-none absolute inset-0 flex items-center overflow-hidden rounded-sm border border-transparent px-3 text-[16px] sm:text-sm"><span className="whitespace-pre text-transparent">{text}</span>{caret}</div>}
          </div>
        )}
      </BorderBeam>
    </div>
  );
}
