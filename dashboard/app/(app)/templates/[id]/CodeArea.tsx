"use client";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { indentEdit } from "./util";

/** A monospace <textarea> with a line-number gutter, cursor position, and Tab / Shift+Tab indenting.
 *  Tab traps focus unless you press Esc first (WCAG 2.1.2): Esc, then Tab moves on. No editor dependency. */
export function CodeArea({ value, onChange, label, describedBy, className }: {
  value: string; onChange: (v: string) => void; label: string; describedBy?: string; className?: string;
}) {
  const ta = useRef<HTMLTextAreaElement>(null), gutter = useRef<HTMLPreElement>(null);
  const pending = useRef<[number, number] | null>(null), released = useRef(false);
  const [pos, setPos] = useState({ ln: 1, col: 1 });
  const lines = value.split("\n").length;

  // A programmatic edit re-renders the controlled value, which moves the caret to the end: put it back.
  useLayoutEffect(() => {
    if (pending.current && ta.current) { ta.current.setSelectionRange(...pending.current); pending.current = null; }
  }, [value]);

  function track() {
    const el = ta.current; if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    setPos({ ln: before.split("\n").length, col: before.length - before.lastIndexOf("\n") });
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") { released.current = true; return; }
    if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey) { released.current = false; return; }
    if (released.current) { released.current = false; return; } // Esc, then Tab: leave the box
    e.preventDefault();
    const el = e.currentTarget, ed = indentEdit(el.value, el.selectionStart, el.selectionEnd, e.shiftKey);
    el.setSelectionRange(ed.from, ed.to);
    // execCommand keeps the browser's undo stack; where it is missing (jsdom) fall back to the controlled value.
    if (document.execCommand?.("insertText", false, ed.text)) el.setSelectionRange(ed.selStart, ed.selEnd);
    else { pending.current = [ed.selStart, ed.selEnd]; onChange(el.value.slice(0, ed.from) + ed.text + el.value.slice(ed.to)); }
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-sm border border-input bg-bg focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-[var(--accent)]">
        <pre ref={gutter} aria-hidden data-testid="gutter" className="m-0 select-none overflow-hidden border-r border-border bg-surface-2 px-2 py-2 pb-6 text-right font-mono text-[12.5px] leading-5 text-subtle">
          {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
        </pre>
        <textarea ref={ta} value={value} aria-label={label} aria-describedby={describedBy} wrap="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onKeyUp={track} onClick={track} onSelect={track} onBlur={() => { released.current = false; }}
          onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
          className="min-w-0 flex-1 resize-none whitespace-pre bg-transparent px-3 py-2 font-mono text-[12.5px] leading-5 text-fg outline-none" />
      </div>
      <p className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-xs text-muted" data-testid="code-status">
        <span>{lines} {lines === 1 ? "line" : "lines"} · {(new Blob([value]).size / 1024).toFixed(1)} KB</span>
        <span>Ln {pos.ln}, Col {pos.col}</span>
      </p>
    </div>
  );
}
