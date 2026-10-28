"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Monitor, Save, Smartphone } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { toast } from "@/components/ui/toast";
import { saveTemplate } from "../actions";
import { CodeArea } from "./CodeArea";
import { DraftState } from "./DraftState";
import { LintList } from "./LintList";
import { PublishButton } from "./PublishButton";
import { TemplateSettings } from "./TemplateSettings";
import { useUnsavedGuard } from "./useUnsavedGuard";
import { API_LIMIT_CHARS, PLATFORM_VARS, contentBody, hasPreheaderField, hasSubjectField, isUnpublished, jsonError, sampleVariables, sourceOf, templateVariables, type Draft, type Lint } from "./util";

export type Preview = { subject?: string; html?: string; text?: string; lint?: Lint[]; variables?: string[] };
export type PreviewState = { preview?: Preview; error?: ApiError };

const DEVICES = [{ v: "desktop", label: "Desktop", Icon: Monitor, w: "100%" }, { v: "mobile", label: "Mobile", Icon: Smartphone, w: "375px" }] as const;
const PANES = [{ value: "code", label: "Code" }, { value: "preview", label: "Preview" }] as const;
export const PREVIEW_DEBOUNCE_MS = 600;
const FORMAT_NAME = { html: "HTML", mjml: "MJML", json: "block JSON" } as const;

/** Edit a template in its own source format (HTML, MJML or block JSON) with a live, debounced preview and lint.
 *  Save adds a new draft version; Publish (existing) makes the newest draft live. */
export function TemplateEditor({ template: t, values, onValuesChange, initial, onClose }: {
  template: any; values: Record<string, string>; onValuesChange: (v: Record<string, string>) => void; initial: PreviewState; onClose: () => void;
}) {
  const router = useRouter();
  const name: string = t.name ?? t.alias ?? t.id;
  const [draft, setDraft] = useState<Draft>(() => {
    const s = sourceOf(t);
    return { format: s.format, body: s.text, subject: t.subject ?? "", preheader: t.preheader ?? "" };
  });
  const [base, setBase] = useState(draft);
  const [pv, setPv] = useState<PreviewState>(initial);
  const [rendering, setRendering] = useState(false);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [pane, setPane] = useState<"code" | "preview">("code");
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, startSave] = useTransition();
  const set = (patch: Partial<Draft>) => { setDraft((d) => ({ ...d, ...patch })); setSaveError(null); };

  const { format } = draft;
  const showSubject = hasSubjectField(format), showPreheader = hasPreheaderField(format, draft.body);
  const dirty = JSON.stringify(contentBody(draft)) !== JSON.stringify(contentBody(base));
  const problem = format === "json" ? jsonError(draft.body) : null;
  const tooBig = draft.body.length > API_LIMIT_CHARS;
  const vars = pv.preview?.variables ?? templateVariables(t);
  const own = vars.filter((v) => !PLATFORM_VARS.includes(v));
  const { dialog, ask } = useUnsavedGuard(dirty);

  // Live preview + lint: one debounced request per pause in typing; a newer edit cancels the one in flight.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; } // the server already rendered the saved version
    if (problem || tooBig) return;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      setRendering(true);
      try {
        const res = await fetch(`/templates/${encodeURIComponent(t.id)}/preview`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
          body: JSON.stringify({ variables: sampleVariables(vars, values), ...contentBody(draft) }),
        });
        const j = await res.json();
        // Keep the last good render on screen when the new text does not compile (mid-typing).
        setPv((p) => (j.error ? { preview: p.preview, error: j.error } : { preview: j.data }));
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPv((p) => ({ preview: p.preview, error: { code: "unreachable", message: "Could not reach the dashboard server.", hint: "Check your connection; your edits are still here." } }));
      } finally { if (!ctl.signal.aborted) setRendering(false); }
    }, PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [draft, values, vars.join("\n")]);

  function save() {
    if (!dirty || saving || problem || tooBig) return;
    startSave(async () => {
      const r = await saveTemplate({ id: t.id, draft });
      if (r.error) { setSaveError(r.error); toast.error("Not saved"); return; }
      setBase(draft);
      setSaveError(null);
      toast.success(`Saved as draft v${r.version}. Publish it when it looks right.`);
      router.refresh();
    });
  }
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); saveRef.current(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const dev = DEVICES.find((d) => d.v === device)!;
  const lint = pv.preview?.lint ?? [];
  const status = problem ? `Fix the JSON to update the preview: ${problem}` : rendering ? "Updating preview…" : dirty ? "Preview shows your unsaved edits." : "Preview shows the saved draft.";

  return (
    <>
      {dialog}
      <PageHeader
        breadcrumb={[{ label: "Templates", href: "/templates" }, { label: name }, { label: "Edit" }]}
        title={<span className="inline-flex flex-wrap items-center gap-3">{name}{t.status && <StatusBadge status={t.status} />}{dirty && <Badge tone="warn">Unsaved changes</Badge>}</span>}
        description={<>Editing the {FORMAT_NAME[format]} source. <kbd className="rounded-sm border border-border bg-surface-2 px-1 font-mono text-xs">Ctrl/⌘ S</kbd> saves a new draft.</>}
        action={<>
          <TemplateSettings template={t} />
          <Button variant="secondary" onClick={() => ask(onClose)}>Close</Button>
          <Button onClick={save} loading={saving} disabled={!dirty || !!problem || tooBig}><Save aria-hidden />Save draft</Button>
          {dirty ? <Button disabled title="Save your changes before publishing">Publish</Button> : <PublishButton id={t.id} name={name} disabled={t.status === "published" && !isUnpublished(t)} />}
        </>}
      />
      <DraftState template={t} className="mb-4" />
      {saveError && <ErrorState className="mb-4" error={saveError} />}

      <div className="mb-3 lg:hidden"><SegmentedControl label="Editor pane" value={pane} onValueChange={setPane} options={PANES.map((p) => ({ ...p }))} /></div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="Source" className={pane === "code" ? "grid min-w-0 content-start gap-4" : "hidden min-w-0 content-start gap-4 lg:grid"}>
          {showSubject && (
            <div className={showPreheader ? "grid gap-4 sm:grid-cols-2" : "grid"}>
              <Field className="content-start" label="Subject" description="Merge fields like {{ first_name }} work here too.">{(a) => <Input {...a} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />}</Field>
              {showPreheader && <Field className="content-start" label="Preheader" description="The grey preview text after the subject in an inbox list.">{(a) => <Input {...a} value={draft.preheader} onChange={(e) => set({ preheader: e.target.value })} />}</Field>}
            </div>
          )}
          {!showSubject && <p className="text-sm text-muted">The subject and preheader live inside the JSON (<code>subject</code>, <code>preheader</code>).</p>}
          <div>
            <p className="mb-1.5 text-sm font-medium">{FORMAT_NAME[format]} source</p>
            <CodeArea value={draft.body} onChange={(body) => set({ body })} label={`${FORMAT_NAME[format]} source`} describedBy="source-help" className="h-[min(62vh,640px)] min-h-[320px]" />
            <p id="source-help" className="mt-1 text-xs text-muted">Tab indents; press Esc, then Tab, to move focus out of the box.</p>
            {problem && <p className="mt-1 text-xs font-medium text-bad">This is not valid JSON: {problem}</p>}
            {tooBig && <p className="mt-1 text-xs font-medium text-bad">The source is over 1 MB, which is more than a template can hold.</p>}
          </div>
        </section>

        <section aria-label="Preview" className={pane === "preview" ? "grid min-w-0 content-start gap-4" : "hidden min-w-0 content-start gap-4 lg:grid"}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm text-muted">{pv.preview?.subject ? <>Subject: <span className="text-fg">{pv.preview.subject}</span></> : "Rendered with sample values."}</p>
            <SegmentedControl iconOnly label="Preview device" value={device} onValueChange={setDevice} options={DEVICES.map(({ v, label, Icon }) => ({ value: v, label, icon: Icon }))} />
          </div>
          <p role="status" className="-mt-2 text-xs text-muted">{status}</p>
          {pv.error && <ErrorState error={pv.error} />}
          <div className="grid place-items-center overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 sm:p-4" aria-busy={rendering}>
            <iframe title="Live template preview" sandbox="" srcDoc={pv.preview?.html ?? ""} style={{ width: dev.w }}
              className="h-[min(52vh,520px)] min-h-[300px] max-w-full rounded-md border border-border bg-white transition-[width] duration-[var(--dur-slow)] ease-out" />
          </div>
          <LintList lint={lint} />
          {own.length > 0 && (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Sample values <span className="font-normal text-muted">({own.length})</span></summary>
              <div className="grid gap-3 border-t border-border p-3 sm:grid-cols-2">
                {own.map((v) => (
                  <Field key={v} label={<code className="text-[12.5px]">{v}</code>}>
                    {(a) => <Input {...a} value={values[v] ?? ""} onChange={(e) => onValuesChange({ ...values, [v]: e.target.value })} placeholder={`[${v}]`} />}
                  </Field>
                ))}
              </div>
            </details>
          )}
        </section>
      </div>
    </>
  );
}
