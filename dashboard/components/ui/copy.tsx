"use client";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

/** Copy button: swaps to "Copied" for 1.5s and announces it politely. */
export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(value); } catch { return; }
    setDone(true); clearTimeout(t.current); t.current = setTimeout(() => setDone(false), 1500);
  }
  return (
    <>
      <Button variant="ghost" size="icon" className={className} onClick={copy} aria-label={label}>{done ? <Check aria-hidden className="text-ok" /> : <Copy aria-hidden />}</Button>
      <span className="sr-only" role="status" aria-live="polite">{done ? "Copied" : ""}</span>
    </>
  );
}

/** Read-only mono value + copy button. Use for every id / key / DNS value. */
export function CopyField({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1 rounded-sm border border-border bg-surface-2 pl-3", className)}>
      <code aria-label={label} className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap py-1.5 text-[12.5px] leading-5">{value}</code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </div>
  );
}

/** Mono block with optional language chip and copy button. */
export function CodeBlock({ code, language, className, children }: { code: string; language?: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-surface-2", className)}>
      <div className="flex h-9 items-center justify-between border-b border-border pl-3 pr-1">
        <span className="text-xs font-medium text-muted">{language ?? "text"}</span>
        <CopyButton value={code} label="Copy code" />
      </div>
      <pre tabIndex={0} className="overflow-x-auto p-3 text-[12.5px] leading-5"><code>{children ?? code}</code></pre>
    </div>
  );
}
