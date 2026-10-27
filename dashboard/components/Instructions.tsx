"use client";
import { useActionState, useId, useState } from "react";
import { saveInstructions, type InstructionsState } from "@/lib/actions";

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
  return (
    <form action={act} className="stack">
      <label htmlFor={`${id}-t`}>Custom instructions</label>
      <textarea id={`${id}-t`} name="custom_instructions" rows={7} value={text} onChange={(e) => setText(e.target.value)}
        aria-describedby={`${id}-n ${id}-c`} aria-invalid={over} placeholder="e.g. Write like a friendly founder. Keep emails under 120 words." />
      <p id={`${id}-c`} className={over ? "hint over" : "hint"} aria-live="polite"><span data-testid="count">{text.length}</span> / {MAX} characters{over && " — too long"}</p>
      <p id={`${id}-n`} className="hint">
        Shapes tone and style of AI-written emails. It cannot override mailcraft&apos;s safety rules: no invented features, links come only from your templates, and unsubscribe is always included.
      </p>
      <div role="group" aria-label="Example instructions" className="inline">
        <span className="muted">Examples:</span>
        {PRESETS.map((p) => <button type="button" key={p.label} className="secondary" onClick={() => setText(p.text)}>{p.label}</button>)}
      </div>
      <div className="inline">
        <button type="submit" name="intent" value="save" disabled={pending || over}>Save</button>
        <button type="submit" name="intent" value="clear" className="secondary" disabled={pending || !initial && !text} onClick={() => setText("")}>Clear</button>
        <button type="button" className="secondary" aria-expanded={show} aria-controls={`${id}-p`} onClick={() => setShow(!show)}>Preview with a sample email</button>
      </div>
      {show && (
        <div id={`${id}-p`} className="json">
          <p className="muted">Sample: &ldquo;Welcome email for a new signup&rdquo;. The model is given this extra guidance (no email is generated here):</p>
          <pre>{text.trim() ? previewText(text) : "(no custom instructions: mailcraft's defaults apply)"}</pre>
        </div>
      )}
      {s.error && <div role="alert" className="banner">{s.error}</div>}
      {s.ok && <div role="status" className="notice">{s.ok}</div>}
    </form>
  );
}
