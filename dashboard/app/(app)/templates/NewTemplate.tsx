"use client";
import { useActionState, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input, Textarea } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { createTemplate } from "./actions";
import { validateImport } from "./ImportTemplate";

type Start = "html" | "mjml" | "blank";
const STARTS = [{ value: "html", label: "Paste HTML" }, { value: "mjml", label: "Paste MJML" }, { value: "blank", label: "Start from blank" }] as const;
const HINT = {
  html: "A full HTML document or a fragment. Use {{ variable }} for merge fields. You keep editing the HTML as you pasted it.",
  mjml: "An <mjml> document; it is compiled to responsive HTML. You keep editing the MJML.",
} as const;

/** New template: pick a starting point, name it, and land in the editor with a draft already saved. */
export function NewTemplate() {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<Start>("blank");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [errors, setErrors] = useState<{ name?: string; content?: string }>({});
  const [state, act] = useActionState(createTemplate, {} as { error?: ApiError });

  function onSubmit(ev: FormEvent) {
    const e = validateImport(name, start === "mjml" ? "mjml" : "html", start === "blank" ? "-" : content);
    setErrors(e);
    if (e.name || e.content) ev.preventDefault();
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus aria-hidden />New template</Button></DialogTrigger>
      <DialogContent title="New template" description="This saves a draft and opens it in the editor. Nothing is live until you publish." className="max-w-xl">
        <form action={act} onSubmit={onSubmit} noValidate className="grid gap-4">
          <Field label="Name" error={errors.name}>{(a) => <Input {...a} name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="welcome" autoComplete="off" />}</Field>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Start from</span>
            <SegmentedControl className="justify-self-start" label="Start from" value={start} onValueChange={setStart} options={STARTS.map((s) => ({ ...s }))} />
            <input type="hidden" name="start" value={start} />
          </div>
          {start === "blank" ? (
            <p className="text-sm text-muted">A small MJML layout with a heading, a paragraph and a button. Edit it in the next screen.</p>
          ) : (
            <Field label={start === "html" ? "HTML" : "MJML"} description={HINT[start]} error={errors.content}>
              {(a) => <Textarea {...a} name="content" mono rows={10} wrap="off" spellCheck={false} value={content} onChange={(e) => setContent(e.target.value)} />}
            </Field>
          )}
          {state.error && <ErrorState error={state.error} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <SubmitButton>Create and edit</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
