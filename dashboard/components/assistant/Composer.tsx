"use client";
// The prompt bar is adapted from "Prompt Bar" on beautifului.dev (https://github.com/TurboKach/ai-native-react-components),
// MIT License, Copyright (c) 2026 Turbo: the "/" command and "@" mention menus (arrow keys + Enter) and the model chip.
// Restyled to mailcraft's tokens; dictation and the glimm shader are left out. The border beam is the single effect here.
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { BorderBeam } from "border-beam";
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ALLOWED_TYPES, MAX_FILE_BYTES, MAX_FILES, parseFile, type Attachment, type ParseError } from "@/lib/assistant/attachments";
import { useReducedMotion, useResolvedTheme } from "./theme";

export type Mentions = { template: string[]; list: string[]; automation: string[] };
type Option = { key: string; label: string; hint: string; insert: string };

export const COMMANDS: Option[] = [
  { key: "automation", label: "/automation", hint: "Set up an automation", insert: "Set up an automation that " },
  { key: "broadcast", label: "/broadcast", hint: "Send a template to a list or a few people", insert: "Send the template @template: to " },
  { key: "fix-template", label: "/fix-template", hint: "Fix this template's lint errors", insert: "Fix the lint errors in this template" },
  { key: "contacts", label: "/contacts", hint: "Add or update contacts", insert: "Add or update these contacts: " },
  { key: "bounce", label: "/bounce", hint: "Explain why an email bounced", insert: "Why did this email bounce? " },
];

/** The word being typed at the caret: "/command" only at the very start, "@mention" after whitespace. */
export function token(text: string, caret: number): { kind: "slash" | "at"; query: string; start: number } | null {
  const head = text.slice(0, caret);
  const s = /^\/([\w-]*)$/.exec(head);
  if (s) return { kind: "slash", query: s[1].toLowerCase(), start: 0 };
  const a = /(^|\s)@([\w:.-]*)$/.exec(head);
  return a ? { kind: "at", query: a[2].toLowerCase(), start: head.length - a[2].length - 1 } : null;
}

let cache: Mentions | null = null;
const shortModel = (m?: string) => (m ? m.split("/").pop()!.replace(/:free$/, "") : "free model");

export function Composer({ busy, disabled, model, draft, setDraft, onSend, onStop, inputRef }: {
  busy: boolean; disabled?: boolean; model?: string; draft: string; setDraft: (s: string) => void; onSend: (t: string, attachments?: Attachment[]) => void; onStop: () => void; inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [caret, setCaret] = useState(0), [active, setActive] = useState(0), [dismissed, setDismissed] = useState(false);
  const [mentions, setMentions] = useState<Mentions | null>(cache);
  const [files, setFiles] = useState<(Attachment | ParseError)[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const theme = useResolvedTheme(), reduced = useReducedMotion();
  const uid = useId(), listId = `${uid}-menu`;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const tok = dismissed ? null : token(draft, caret);

  useEffect(() => {
    if (tok?.kind !== "at" || mentions) return;
    fetch("/api/assistant/mentions").then((r) => r.json()).then((j) => { cache = j; setMentions(j); }).catch(() => {});
  }, [tok?.kind, mentions]);

  const options = useMemo<Option[]>(() => {
    if (!tok) return [];
    if (tok.kind === "slash") return COMMANDS.filter((c) => c.key.startsWith(tok.query));
    const q = tok.query.replace(/^(template|list|automation):/, "");
    const all = (["template", "list", "automation"] as const).flatMap((k) => (mentions?.[k] ?? []).map((n) => ({ key: `${k}:${n}`, label: n, hint: k, insert: `@${k}:${n} ` })));
    return all.filter((o) => o.label.toLowerCase().includes(q)).slice(0, 8);
  }, [tok?.kind, tok?.query, mentions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [tok?.kind, tok?.query]);
  useEffect(() => { const el = inputRef.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 168) + "px"; } }, [draft, inputRef]);

  const pick = (o: Option) => {
    if (!tok) return;
    const next = draft.slice(0, tok.start) + o.insert + draft.slice(caret);
    setDraft(next);
    setDismissed(false);
    const pos = tok.start + o.insert.length;
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos, pos); setCaret(pos); });
  };
  const handleFiles = async (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list).slice(0, MAX_FILES);
    const parsed = await Promise.all(picked.map(parseFile));
    setFiles((prev) => [...prev, ...parsed].slice(0, MAX_FILES));
  };
  const submit = () => {
    if ((draft.trim() || files.some((f) => "kind" in f)) && !busy && !disabled) {
      const good = files.filter((f): f is Attachment => "kind" in f);
      if (good.length) onSend(draft, good);
      else onSend(draft);
      setDraft("");
      setFiles([]);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (tok && options.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(options[active]); return; }
    }
    if (tok && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.files;
    if (items && items.length) { e.preventDefault(); void handleFiles(items); }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void handleFiles(e.dataTransfer.files);
  };

  return (
    <div className="relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}>
      {tok && (
        <div className="absolute inset-x-0 bottom-full z-10 mb-2 rounded-lg border border-border bg-bg p-1 shadow-pop">
          {options.length ? (
            <ul id={listId} role="listbox" aria-label={tok.kind === "slash" ? "Commands" : "Mentions"}>
              {options.map((o, i) => (
                <li key={o.key} id={`${uid}-o${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(o)}
                  className={cn("flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm pointer-coarse:min-h-11", i === active && "bg-surface-2")}>
                  <span className="shrink-0 font-medium">{o.label}</span><span className="min-w-0 truncate text-muted">{o.hint}</span>
                </li>
              ))}
            </ul>
          ) : <p className="px-2 py-2 text-sm text-muted">{tok.kind === "at" && !mentions ? "Loading…" : "No matches"}</p>}
          <p className="border-t border-border px-2 pt-1 text-xs text-subtle">{tok.kind === "slash" ? "Pick a command" : "Mention a template, list or automation"} · ↑ ↓ Enter · Esc</p>
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <div key={i} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", "kind" in f ? "border-border bg-surface" : "border-bad bg-bad-bg text-bad")}>
              <span className="truncate max-w-[180px]">{"kind" in f ? f.name : f.name}</span>
              {"kind" in f ? <span className="text-muted">({f.kind})</span> : <span title={f.message}>!</span>}
              <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="ml-1 rounded-full hover:bg-surface-2" aria-label={`Remove ${"kind" in f ? f.name : f.name}`}><X className="size-3" /></button>
            </div>
          ))}
        </div>
      )}
      <span className="sr-only" role="status">{tok ? (options.length ? `${options.length} suggestion${options.length === 1 ? "" : "s"}, use the arrow keys` : "No suggestions") : ""}</span>
      {/* line beam: from submit until the turn finishes (these runs take longer than 3s); the rotating types need reduced motion handled here */}
      <BorderBeam active={busy && !reduced} size="line" colorVariant="ocean" theme={theme} strength={0.85} borderRadius={12} className="block w-full">
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className={cn("rounded-lg border bg-bg focus-within:border-accent", dragOver ? "border-accent ring-1 ring-accent" : "border-input")}>
          <textarea ref={inputRef} rows={1} value={draft} disabled={disabled} aria-label="Message the assistant" placeholder="Ask about your mail. / for commands, @ to mention"
            aria-autocomplete="list" aria-haspopup="listbox" aria-controls={tok && options.length ? listId : undefined} aria-activedescendant={tok && options.length ? `${uid}-o${active}` : undefined}
            onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); setDismissed(false); }} onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={onKey} onPaste={onPaste}
            className="block max-h-42 w-full resize-none bg-transparent px-3 pt-2.5 text-md outline-none placeholder:text-subtle disabled:opacity-50 md:text-base" />
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
            <div className="flex items-center gap-2">
              <input ref={fileInput} type="file" accept={ALLOWED_TYPES.join(",")} multiple className="sr-only" onChange={(e) => { void handleFiles(e.target.files); if (e.target) e.target.value = ""; }} />
              <Button type="button" variant="ghost" size="icon" aria-label="Attach file" disabled={disabled || files.length >= MAX_FILES} onClick={() => fileInput.current?.click()}><Paperclip aria-hidden className="size-4" /></Button>
              <span className="min-w-0 truncate rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted" title={model ? `${model}: free, open-weight` : "Free, open-weight models only"}>{shortModel(model)} · free</span>
            </div>
            {busy
              ? <Button type="button" variant="secondary" size="icon" aria-label="Stop" onClick={onStop}><Square aria-hidden className="fill-current" /></Button>
              : <Button type="submit" size="icon" aria-label="Send message" disabled={(!draft.trim() && !files.some((f) => "kind" in f)) || disabled}><ArrowUp aria-hidden /></Button>}
          </div>
        </form>
      </BorderBeam>
    </div>
  );
}
