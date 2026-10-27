import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { KeyValue } from "@/components/ui/stat-card";
import { CodeBlock } from "@/components/ui/copy";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RetryError } from "@/components/ui/error-state";
import { parseErr } from "@/lib/err";
import { ruleWords } from "@/lib/rules";
import { AutomationToggle } from "../AutomationToggle";
import { RunsTable, type Run } from "./RunsTable";
import { StepFlow } from "./StepFlow";
import { flowSteps, slotsOf, type Slot } from "./steps";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automation" };

export default async function AutomationDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const e = parseErr(err);
  const [a, runs] = await Promise.all([get(`/v1/automations/${encodeURIComponent(id)}`), get(`/v1/automations/${encodeURIComponent(id)}/runs`)]);
  const shaped = !a.error && a.data && !Array.isArray(a.data) && typeof a.data === "object";
  if (a.error || !shaped) return (
    <>
      <PageHeader title="Automation" breadcrumb={[{ label: "Automations", href: "/automations" }, { label: id }]} />
      <RetryError error={a.error ?? { code: "bad_response", message: "The API returned an unexpected response for this page.", hint: "Check the API base URL and that the server is up to date." }} />
    </>
  );
  const d = { status: "draft", ...a.data };
  const name: string = d.name ?? id;
  const runList: Run[] = Array.isArray(runs.data) ? runs.data : [];
  const steps = flowSteps(d);
  const llm = steps.filter((s) => s.type === "send_email" && s.config?.mode === "llm");
  const aliases = [...new Set(llm.map((s) => s.config?.template).filter(Boolean))] as string[];
  const slots: Record<string, Slot[]> = {};
  await Promise.all(aliases.map(async (al) => { const t = await get(`/v1/templates/${encodeURIComponent(al)}`); if (!t.error) slots[al] = slotsOf(t.data); }));
  const trig = steps.find((s) => s.type === "trigger")?.config;
  const goal = ruleWords(d.goal?.filter) ?? (d.goal ? [d.goal.event, ...(d.goal.events ?? [])].filter(Boolean).join(", ") : "");

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Automations", href: "/automations" }, { label: name }]}
        title={<span className="inline-flex flex-wrap items-center gap-3">{name}<StatusBadge status={d.status} /></span>}
        description={d.version != null ? `Version ${d.version}` : undefined}
        action={<div className="inline-flex items-center gap-3 text-sm font-medium"><span aria-hidden>{d.status === "active" ? "Live" : d.status === "paused" ? "Paused" : "Draft"}</span><AutomationToggle id={id} name={name} status={d.status} from={`/automations/${id}`} /></div>}
      />
      {e && <div className="mb-4"><RetryError error={e} /></div>}
      <Tabs defaultValue="flow">
        <TabsList aria-label="Automation sections">
          <TabsTrigger value="flow">Flow</TabsTrigger>
          <TabsTrigger value="runs">Runs{!runs.error && <span className="ml-1.5 text-xs text-subtle">{runList.length}</span>}</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="flow"><StepFlow automation={d} slots={slots} /></TabsContent>
        <TabsContent value="runs">{runs.error ? <RetryError error={runs.error} /> : <RunsTable runs={runList} event={trig?.event ?? trig?.events?.[0]} />}</TabsContent>
        <TabsContent value="settings">
          <div className="grid max-w-3xl gap-4">
            <Card>
              <CardHeader title="Behaviour" description="How contacts enter and when they stop." />
              <CardBody>
                <KeyValue items={[
                  ["Entry rule", d.entry_rule ? <code>{d.entry_rule}{d.entry_days ? ` (${d.entry_days} days)` : ""}</code> : "Once per contact"],
                  ["Goal", goal || "None"],
                  ["Approval", d.approval ? <code>{d.approval}</code> : "Default"],
                  ["Caps", d.caps && Object.keys(d.caps).length ? <code>{Object.entries(d.caps).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}</code> : "None"],
                ]} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Extra instructions" description="Per-step writing guidance for AI-written emails, added on top of the workspace instructions." />
              {llm.length === 0 ? <CardBody><p className="text-sm text-muted">No step in this automation is AI-written.</p></CardBody> : (
                <CardBody className="grid gap-3">
                  <ul className="grid gap-3">
                    {llm.map((s) => (
                      <li key={s.key} className="rounded-md border border-border p-3">
                        <p className="text-xs text-muted">Step <code>{s.key}</code></p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{s.config.custom_instructions || <span className="text-muted">None (workspace instructions apply)</span>}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="text-sm text-muted">Edit by setting <code>config.custom_instructions</code> (max 1,000 characters) on the step and re-importing the automation.</p>
                </CardBody>
              )}
            </Card>
            <details className="group rounded-lg border border-border">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">View source</summary>
              <div className="border-t border-border p-3"><CodeBlock language="json" code={JSON.stringify(d, null, 2)} /></div>
            </details>
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
