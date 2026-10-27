import Link from "next/link";
import { Workflow, Zap } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { AutomationToggle } from "./AutomationToggle";

export type AutomationRow = { id: string; name?: string; status: string; trigger?: unknown; version?: number; steps?: unknown[] };

export const triggerName = (t: unknown): string | null =>
  typeof t === "string" ? t : t && typeof t === "object" ? ((t as any).event ?? (t as any).events?.[0] ?? ((t as any).segment ? `segment ${(t as any).segment}` : null)) : null;

export function HowToCreate() {
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4 text-left">
      <EmptyState icon={Workflow} title="No automations yet" description="Automations are defined as JSON (a trigger plus steps) and imported with the CLI or the API. Import creates a draft; publish it to go live." className="border-0 pb-2" />
      <div className="grid gap-1.5"><p className="text-sm font-medium">1. Import the definition</p><CopyField value="mailcraft automations import welcome-automation.json" label="import command" /></div>
      <div className="grid gap-1.5"><p className="text-sm font-medium">2. Publish it (publish the template first)</p><CopyField value="mailcraft automations publish welcome" label="publish command" /></div>
      <div className="grid gap-1.5"><p className="text-sm font-medium">Or use the API</p>
        <CodeBlock language="bash" code={`curl -X POST $MAILCRAFT_API_URL/v1/automations \\\n  -H "Authorization: Bearer $MAILCRAFT_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d @welcome-automation.json`} />
      </div>
    </div>
  );
}

export function AutomationsList({ automations }: { automations: AutomationRow[] }) {
  if (!automations.length) return <HowToCreate />;
  return (
    <Table caption="Automations">
      <THead><TR><TH>Name</TH><TH>Trigger</TH><TH>Status</TH><TH className="text-right">Live</TH></TR></THead>
      <TBody>
        {automations.map((a) => {
          const name = a.name ?? a.id, trig = triggerName(a.trigger);
          return (
            <TR key={a.id}>
              <TD label="Name"><Link href={`/automations/${a.id}`} data-ui="link" className="font-medium text-accent hover:underline">{name}</Link>
                {a.version != null && <span className="ml-2 text-xs text-muted">v{a.version}</span>}</TD>
              <TD label="Trigger">{trig ? <Badge tone="neutral"><Zap aria-hidden className="size-3" /><code className="text-xs">{trig}</code></Badge> : <span className="text-subtle">-</span>}</TD>
              <TD label="Status"><StatusBadge status={a.status ?? "draft"} /></TD>
              <TD label="Live" className="md:text-right"><span className="inline-flex"><AutomationToggle id={a.id} name={name} status={a.status ?? "draft"} from="/automations" /></span></TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
