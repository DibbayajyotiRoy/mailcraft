"use client";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Plain text shown as an HTML document so the iframe preview is uniform. */
export const textDoc = (t: string) => `<!doctype html><meta charset="utf-8"><body style="font:14px/1.6 system-ui,sans-serif;color:#171717;margin:16px;white-space:pre-wrap">${esc(t)}</body>`;

/** Preview (sandboxed iframe, no scripts, no same-origin) + Text tabs, with a desktop/mobile width toggle. */
export function MessagePreview({ html, text, title }: { html?: string | null; text?: string | null; title: string }) {
  const [narrow, setNarrow] = useState(false);
  if (!html && !text) return <p className="text-sm text-muted">No body available for this message.</p>;
  return (
    <Tabs defaultValue="preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList className="border-b-0">
          <TabsTrigger value="preview">Preview</TabsTrigger>
          {text && <TabsTrigger value="text">Text</TabsTrigger>}
        </TabsList>
        <div role="group" aria-label="Preview width" className="inline-flex gap-1">
          {([["Desktop", false], ["Mobile", true]] as const).map(([l, v]) => (
            <button key={l} type="button" data-ui="button" aria-pressed={narrow === v} onClick={() => setNarrow(v)}
              className="h-7 rounded-sm px-2 text-xs font-medium text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 aria-pressed:bg-accent-soft aria-pressed:text-fg pointer-coarse:h-11">{l}</button>
          ))}
        </div>
      </div>
      <TabsContent value="preview">
        <iframe title={title} sandbox="" srcDoc={html || textDoc(text ?? "")} className={cn("mx-auto block h-[420px] w-full rounded-md bg-white outline outline-1 -outline-offset-1 outline-black/10 transition-[max-width] duration-[var(--dur-base)]", narrow && "max-w-[375px]")} />
      </TabsContent>
      {text && <TabsContent value="text"><pre tabIndex={0} className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 font-mono text-[12.5px] leading-5">{text}</pre></TabsContent>}
    </Tabs>
  );
}
