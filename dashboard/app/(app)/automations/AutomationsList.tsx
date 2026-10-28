import Link from "next/link";
import { Plus, Workflow, Zap } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { AutomationToggle } from "./AutomationToggle";
import { PRESETS } from "./editor/presets";

/** The list endpoint carries `trigger_event` and `current_version`; the detail endpoint adds `trigger` and the steps. */
export type AutomationRow = { id: string; name?: string; status: string; trigger?: unknown; trigger_event?: string; version?: number; current_version?: number; steps?: unknown[] };

export const triggerName = (t: unknown): string | null =>
  typeof t === "string" ? t : t && typeof t === "object" ? ((t as any).event ?? (t as any).events?.[0] ?? ((t as any).segment ? `segment ${(t as any).segment}` : null)) : null;

export function HowToCreate() {
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-5 text-left">
      <EmptyState icon={Workflow} title="No automations yet" description="An automation sends emails when a contact does something. Build one here, or start from an example." className="border-0 pb-0"
        action={<Link href="/automations/new" className={buttonVariants()}><Plus aria-hidden />New automation</Link>} />
      <ul aria-label="Starter automations" className="grid gap-2 sm:grid-cols-3">
        {PRESETS.map((p) => (
          <li key={p.id}><Link href={`/automations/new?preset=${p.id}`} className="block h-full rounded-lg border border-border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-surface-2">
            <span className="block text-sm font-medium">{p.title}</span><span className="mt-0.5 block text-xs text-muted">{p.description}</span></Link></li>
        ))}
      </ul>
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">Prefer the CLI or API?</summary>
        <div className="grid gap-4 border-t border-border p-4">
          <div className="grid gap-1.5"><p className="text-sm font-medium">1. Import the definition</p><CopyField value="mailcraft automations import welcome-automation.json" label="import command" /></div>
          <div className="grid gap-1.5"><p className="text-sm font-medium">2. Publish it (publish the template first)</p><CopyField value="mailcraft automations publish welcome" label="publish command" /></div>
          <CodeBlock language="bash" code={`curl -X POST $MAILCRAFT_API_URL/v1/automations \\\n  -H "Authorization: Bearer $MAILCRAFT_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d @welcome-automation.json`} />
        </div>
      </details>
    </div>
  );
}

export function AutomationsList({ automations, archived }: { automations: AutomationRow[]; archived?: boolean }) {
  if (!automations.length) return archived ? <EmptyState icon={Workflow} title="Nothing archived" description="Archived automations show up here and can be restored." /> : <HowToCreate />;
  return (
    <Table caption="Automations">
      <THead><TR><TH>Name</TH><TH>Trigger</TH><TH>Status</TH><TH className="text-right">Live</TH></TR></THead>
      <TBody>
        {automations.map((a) => {
          const name = a.name ?? a.id, trig = triggerName(a.trigger ?? a.trigger_event), version = a.current_version ?? a.version;
          return (
            <TR key={a.id}>
              <TD label="Name"><Link href={`/automations/${a.id}`} className="font-medium text-accent hover:underline">{name}</Link>
                {version != null && <span className="ml-2 text-xs text-muted">v{version}</span>}</TD>
              <TD label="Trigger">{trig ? <Badge tone="neutral"><Zap aria-hidden className="size-3" /><code className="text-xs">{trig}</code></Badge> : <span className="text-subtle">-</span>}</TD>
              <TD label="Status"><StatusBadge status={a.status ?? "draft"} /></TD>
              <TD label="Live" className="md:text-right">{a.status === "archived" ? <span className="text-subtle">-</span> : <span className="inline-flex"><AutomationToggle id={a.id} name={name} status={a.status ?? "draft"} from="/automations" /></span>}</TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
