"use client";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronRight, ShieldCheck } from "lucide-react";
import { saveInstructions, type InstructionsState } from "@/lib/actions";
import { Button, SubmitButton } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

export const MAX = 2000;
export const PRESETS: { label: string; text: string }[] = [
  { label: "Friendly founder", text: "Write like a friendly founder emailing one person: first person, warm, plain words, short paragraphs. Sign off casually." },
  { label: "Concise and technical", text: "Be concise and technical. Short sentences, no filler or exclamation marks. Name the exact feature or step; skip marketing language." },
  { label: "Warm and supportive", text: "Be warm and supportive. Acknowledge the reader's situation first, encourage without pressure, and offer help in one sentence." },
];

/** What the model will see: pure text, no LLM call. */
export function previewText(text: string) {
  return `Writing preferences from the workspace (lower priority than mailcraft's rules):\n${text.trim()}`;
}

export function InstructionsForm({ initial }: { initial: string }) {
  const [s, act, pending] = useActionState(saveInstructions, {} as InstructionsState);
  const [text, setText] = useState(initial);
  const [show, setShow] = useState(false);
  const id = useId();
  const over = text.length > MAX;
  const near = !over && text.length > MAX * 0.9;
  const toasted = useRef<InstructionsState>(undefined);
  useEffect(() => { if (s.ok && toasted.current !== s) { toasted.current = s; toast.success(s.ok); } }, [s]);
  return (
    <Card id="ai-writing" aria-labelledby={`${id}-h`} className="scroll-mt-20">
      <form action={act}>
        <CardHeader title={<span id={`${id}-h`}>AI writing</span>} description="Tell the model how your emails should sound. It shapes tone and style only." />
        <CardBody className="grid gap-3">
          <label htmlFor={`${id}-t`} className="text-sm font-medium">Custom instructions</label>
          <Textarea id={`${id}-t`} name="custom_instructions" rows={7} value={text} onChange={(e) => setText(e.target.value)}
            aria-describedby={`${id}-n ${id}-c`} aria-invalid={over} placeholder="e.g. Write like a friendly founder. Keep emails under 120 words." />
          <p id={`${id}-c`} aria-live="polite" className={cn("text-xs tabular-nums", over ? "font-medium text-bad" : near ? "text-warn" : "text-muted")}>
            <span data-testid="count">{text.length}</span> / {MAX} characters{over && " — too long"}
          </p>
          <p id={`${id}-n`} className="flex gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
            <span>Shapes tone and style of AI-written emails. It cannot override mailcraft&apos;s safety rules: no invented features, links come only from your templates, and unsubscribe is always included.</span>
          </p>
          <div role="group" aria-label="Example instructions" className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Examples:</span>
            {PRESETS.map((p) => <Button key={p.label} size="sm" variant="secondary" onClick={() => setText(p.text)}>{p.label}</Button>)}
          </div>
          <div>
            <Button variant="ghost" size="sm" className="-ml-2" aria-expanded={show} aria-controls={`${id}-p`} onClick={() => setShow(!show)}>
              <ChevronRight aria-hidden className={cn("transition-transform duration-[var(--dur-fast)]", show && "rotate-90")} />Preview with a sample email
            </Button>
            {show && (
              <div id={`${id}-p`} className="mt-2 rounded-md border border-border bg-surface-2 p-3">
                <p className="mb-2 text-sm text-muted">Sample: &ldquo;Welcome email for a new signup&rdquo;. The model is given this extra guidance (no email is generated here):</p>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12.5px] leading-5">{text.trim() ? previewText(text) : "(no custom instructions: mailcraft's defaults apply)"}</pre>
              </div>
            )}
          </div>
          {s.error && <p role="alert" className="text-sm font-medium text-bad">{s.error}</p>}
          {s.ok && <p role="status" className="inline-flex items-center gap-1 text-sm text-ok"><Check aria-hidden className="size-4" />{s.ok}</p>}
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="secondary" name="intent" value="clear" disabled={pending || (!initial && !text)} onClick={() => setText("")}>Clear</Button>
          <SubmitButton name="intent" value="save" disabled={pending || over}>Save</SubmitButton>
        </CardFooter>
      </form>
    </Card>
  );
}
