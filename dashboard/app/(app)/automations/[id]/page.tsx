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
import { DetailActions } from "./DetailActions";
import { RunsTable, type Run } from "./RunsTable";
import { FlowView } from "../flow/FlowView";
import { StepFlow } from "./StepFlow";
import { flowSteps, slotsOf, type Slot } from "./steps";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automation" };

export default async function AutomationDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const e = parseErr(err);
  const [a, runs, who, acct] = await Promise.all([get(`/v1/automations/${encodeURIComponent(id)}`), get(`/v1/automations/${encodeURIComponent(id)}/runs`), get("/v1/contacts?limit=50"), get("/v1/account/status")]);
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
  const types = Object.fromEntries(steps.map((s) => [s.key, s.type]));
  const archived = d.status === "archived", version = d.current_version ?? d.version;
  const contacts: string[] = (Array.isArray(who.data) ? who.data : []).map((c: any) => c.email).filter(Boolean);
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
        description={version != null ? `Version ${version}` : undefined}
        action={
          <div className="flex max-w-full flex-wrap items-center gap-3">
            {!archived && <div className="inline-flex items-center gap-3 text-sm font-medium"><span aria-hidden>{d.status === "active" ? "Live" : d.status === "paused" ? "Paused" : "Draft"}</span><AutomationToggle id={id} name={name} status={d.status} from={`/automations/${id}`} /></div>}
            <DetailActions id={d.id ?? id} name={name} status={d.status} env={acct.data?.env === "live" ? "live" : "test"} liveEnabled={!!acct.data?.live_enabled} contacts={contacts} types={types} />
          </div>
        }
      />
      {archived && <p role="note" className="mb-4 rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted">This automation is archived: it does not run and is hidden from the list. Restore it from the menu to edit or publish it.</p>}
      {e && <div className="mb-4"><RetryError error={e} /></div>}
      <Tabs defaultValue="flow">
        <TabsList aria-label="Automation sections">
          <TabsTrigger value="flow">Flow</TabsTrigger>
          <TabsTrigger value="runs">Runs{!runs.error && <span className="ml-1.5 text-xs text-subtle">{runList.length}</span>}</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="flow"><FlowView automation={{ trigger: d.trigger, steps: d.steps }} stats={d.stats ?? null} steps={<StepFlow automation={d} slots={slots} stats={d.stats ?? null} />} /></TabsContent>
        <TabsContent value="runs">{runs.error ? <RetryError error={runs.error} /> : <RunsTable runs={runList} event={trig?.event ?? trig?.events?.[0]} id={d.id ?? id} types={types} />}</TabsContent>
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
                  <p className="text-sm text-muted">Change them in the editor: open a step, switch on Write with AI and edit its guidance (max 1,000 characters).</p>
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
