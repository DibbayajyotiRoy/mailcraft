"use client";
import { useMemo, useState } from "react";
import { CircleCheck, CircleX, Download, Monitor, Smartphone, TriangleAlert, Wand2 } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { ApiError } from "@/lib/api";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/copy";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyValue } from "@/components/ui/stat-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { PublishButton } from "./PublishButton";
import { lintSummary, templateVariables, type Lint } from "./util";

type Preview = { subject?: string; html?: string; text?: string; lint?: Lint[] };
type State = { preview?: Preview; error?: ApiError };

const DEVICES = [{ v: "desktop", label: "Desktop", Icon: Monitor, w: "100%" }, { v: "mobile", label: "Mobile", Icon: Smartphone, w: "375px" }] as const;

export function TemplateDetail({ template: t, initial }: { template: any; initial: State }) {
  const id: string = t.id;
  const name: string = t.name ?? t.alias ?? id;
  const vars = useMemo(() => templateVariables(t), [t]);
  const [tab, setTab] = useState("preview");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<State>(initial);
  const [busy, setBusy] = useState(false);

  async function refresh(next = values) {
    setBusy(true);
    try {
      const res = await fetch(`/templates/${encodeURIComponent(id)}/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variables: next }) });
      const j = await res.json();
      setState(j.error ? { error: j.error } : { preview: j.data });
      if (!j.error) toast.success("Preview updated");
      setTab("preview");
    } catch {
      setState({ error: { code: "unreachable", message: "Could not reach the dashboard server.", hint: "Check your connection and try again." } });
    } finally { setBusy(false); }
  }
  function sample() {
    const next = Object.fromEntries(vars.map((v) => [v, values[v] || `Sample ${v.replace(/[._]/g, " ")}`]));
    setValues(next);
    refresh(next);
  }

  const lint = state.preview?.lint ?? [];
  const sum = lintSummary(lint);
  const unpublished = t.version != null && (t.published_version == null || t.version > t.published_version);
  const dev = DEVICES.find((d) => d.v === device)!;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Templates", href: "/templates" }, { label: name }]}
        title={<span className="inline-flex flex-wrap items-center gap-3">{name}{t.status && <StatusBadge status={t.status} />}</span>}
        description={t.subject ? <>Subject: <span className="text-fg">{t.subject}</span></> : "No subject set"}
        action={<>
          {["json", "html", "mjml"].map((f) => (
            <a key={f} href={`/templates/${id}/export?format=${f}`} download className={cn(buttonVariants({ variant: "secondary" }), "max-sm:hidden")}><Download aria-hidden />{f.toUpperCase()}</a>
          ))}
          <PublishButton id={id} name={name} disabled={t.status === "published" && !unpublished} />
        </>}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Template sections">
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="variables">Variables{vars.length > 0 && <span className="ml-1.5 text-xs text-subtle">{vars.length}</span>}</TabsTrigger>
          <TabsTrigger value="lint">Lint
            {sum.errors + sum.warnings > 0 && <Badge tone={sum.errors ? "bad" : "warn"} size="sm" className="ml-1.5">{sum.errors + sum.warnings}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
        </TabsList>

        <TabsContent value="preview">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm text-muted">{state.preview?.subject ? <>Rendered subject: <span className="text-fg">{state.preview.subject}</span></> : "Preview renders with the values from the Variables tab."}</p>
            <SegmentedControl iconOnly label="Preview device" value={device} onValueChange={setDevice} options={DEVICES.map(({ v, label, Icon }) => ({ value: v, label, icon: Icon }))} />
          </div>
          {busy ? <Skeleton className="h-[560px] w-full rounded-lg" /> : state.error ? (
            <div className="grid gap-3">
              <ErrorState error={state.error} />
              {vars.length > 0 && <div><Button variant="secondary" onClick={() => setTab("variables")}>Fill in variables</Button></div>}
            </div>
          ) : (
            <div className="grid place-items-center overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 sm:p-6">
              <iframe title="Template preview" sandbox="" srcDoc={state.preview?.html ?? ""} style={{ width: dev.w }}
                className="h-[560px] max-w-full rounded-md border border-border bg-white transition-[width] duration-[var(--dur-slow)] ease-out" />
            </div>
          )}
        </TabsContent>

        <TabsContent value="variables">
          <Card className="max-w-2xl">
            <CardHeader title="Sample values" description="Merge fields used by this template. Values are only used to render the preview." action={vars.length > 0 && <Button variant="secondary" onClick={sample} loading={busy}><Wand2 aria-hidden />Fill samples</Button>} />
            <CardBody>
              {!vars.length ? <EmptyState title="No variables" description="This template has no {{ variable }} merge fields, so it renders the same for everyone." className="border-0 py-6" /> : (
                <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); refresh(); }}>
                  {vars.map((v) => (
                    <Field key={v} label={<code className="text-[12.5px]">{v}</code>}>
                      {(a) => <Input {...a} value={values[v] ?? ""} onChange={(e) => setValues({ ...values, [v]: e.target.value })} placeholder={`Sample ${v.replace(/[._]/g, " ")}`} />}
                    </Field>
                  ))}
                  <div><Button type="submit" loading={busy}>Update preview</Button></div>
                </form>
              )}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="lint">
          <Card className="max-w-3xl">
            <CardHeader title="Lint checklist" description="Checks that run on every preview. Errors block deliverability; warnings are advice." />
            {state.error ? <CardBody><p className="text-sm text-muted">Lint results appear once the template renders. Fix the preview error first.</p></CardBody>
              : !lint.length ? (
                <CardBody><p className="flex items-center gap-2 text-sm text-ok"><CircleCheck aria-hidden className="size-4" />All checks passed. Nothing to fix.</p></CardBody>
              ) : (
                <ul className="divide-y divide-border">
                  {[...lint].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error")).map((l, i) => {
                    const err = l.severity === "error";
                    return (
                      <li key={i} className="flex gap-3 px-4 py-3">
                        {err ? <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" /> : <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />}
                        <div className="min-w-0">
                          <p className="text-sm"><span className="sr-only">{err ? "Error: " : "Warning: "}</span>{l.message}</p>
                          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">{l.rule && <code>{l.rule}</code>}{l.path && <code>{l.path}</code>}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
          </Card>
        </TabsContent>

        <TabsContent value="versions">
          <Card className="max-w-2xl">
            <CardHeader title="Versions" description="Sends use the published version. Edits create a new draft version." />
            <CardBody>
              <KeyValue items={[
                ["Draft version", t.version != null ? `v${t.version}` : "-"],
                ["Published version", t.published_version != null ? `v${t.published_version}` : "Never published"],
                ["State", unpublished ? <Badge tone="info">unpublished changes</Badge> : <StatusBadge status="published" />],
                ["Alias", t.alias ? <code>{t.alias}</code> : "-"],
              ]} />
              <p className="mt-4 text-sm text-muted">The API exposes the current draft and published version numbers only; a full version history is not available yet.</p>
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="source">
          <p className="mb-3 text-sm text-muted">The stored template definition, for reference. Use Export to download it as JSON, HTML or MJML.</p>
          <CodeBlock language="json" code={JSON.stringify(t, null, 2)} />
        </TabsContent>
      </Tabs>
    </>
  );
}
