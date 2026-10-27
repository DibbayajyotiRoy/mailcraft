"use client";
import { useState, type FormEvent } from "react";
import { Upload } from "lucide-react";
import { importTemplate } from "@/lib/actions";
import { Button, SubmitButton } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";

type Format = "json" | "html" | "mjml";
const HINT: Record<Format, string> = {
  json: "mailcraft block JSON: {\"version\":1,\"subject\":\"…\",\"blocks\":[…]}",
  html: "A full HTML document. Use {{ variable }} for merge fields.",
  mjml: "An <mjml> document; it is compiled to responsive HTML.",
};

/** Validates before submitting so a typo never costs a round trip: name required, content required, JSON must parse. */
export function validateImport(name: string, format: Format, content: string): { name?: string; content?: string } {
  const e: { name?: string; content?: string } = {};
  if (!name.trim()) e.name = "Give the template a name.";
  if (!content.trim()) e.content = "Paste the template or choose a file.";
  else if (format === "json") { try { JSON.parse(content); } catch { e.content = "This is not valid JSON."; } }
  return e;
}

export function ImportTemplate() {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>("html");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [errors, setErrors] = useState<{ name?: string; content?: string }>({});

  function onSubmit(ev: FormEvent) {
    const e = validateImport(name, format, content);
    setErrors(e);
    if (e.name || e.content) ev.preventDefault();
  }
  async function onFile(f?: File) {
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext === "json" || ext === "html" || ext === "mjml") setFormat(ext);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
    setContent(await f.text());
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Upload aria-hidden />Import template</Button></DialogTrigger>
      <DialogContent title="Import a template" description="Import creates a draft. Publish it when it looks right." className="max-w-xl">
        <form action={importTemplate} onSubmit={onSubmit} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <Field label="Name" error={errors.name}>{(a) => <Input {...a} name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="welcome" />}</Field>
            <Field label="Format">{(a) => <Select {...a} name="format" value={format} onChange={(e) => setFormat(e.target.value as Format)}><option value="html">HTML</option><option value="mjml">MJML</option><option value="json">JSON</option></Select>}</Field>
          </div>
          <Field label="File" description="Optional: .html, .mjml or .json fills the fields below.">{(a) => <Input {...a} type="file" accept=".html,.mjml,.json,text/html,application/json" onChange={(e) => onFile(e.target.files?.[0])} />}</Field>
          <Field label="Content" description={HINT[format]} error={errors.content}>{(a) => <Textarea {...a} name="content" mono rows={10} value={content} onChange={(e) => setContent(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <SubmitButton>Import</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
