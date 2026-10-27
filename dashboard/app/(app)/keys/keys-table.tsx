import { Badge, StatusBadge } from "@/components/ui/badge";
import { EnvChip } from "@/components/ui/env-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { MonoCopy } from "@/components/setup/mono-copy";
import { RevokeKey } from "./revoke-key";

export type Key = { id: string; name: string; prefix: string; env: "live" | "test"; scopes?: string[]; paused?: boolean; revoked_at?: string | null; created_at?: string; last_used_at?: string | null };

const time = (v?: string | null, never = true) => v ? <RelativeTime value={v} /> : <span className="text-muted">{never ? "Never" : "—"}</span>;

export function KeysTable({ keys }: { keys: Key[] }) {
  const rows = [...keys].sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at));
  return (
    <Table caption="API keys">
      <THead><TR><TH>Name</TH><TH>Prefix</TH><TH>Env</TH><TH>Scopes</TH><TH>Created</TH><TH>Last used</TH><TH>Status</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
      <TBody>
        {rows.map((k) => (
          <TR key={k.id} className={k.revoked_at ? "opacity-60" : undefined}>
            <TD label="Name" className="font-medium">{k.name}</TD>
            <TD label="Prefix"><MonoCopy value={k.prefix} label={`${k.name} prefix`} className="max-md:w-full md:w-44" /></TD>
            <TD label="Env"><EnvChip env={k.env} /></TD>
            <TD label="Scopes"><span className="flex flex-wrap gap-1">{(k.scopes ?? []).map((s) => <Badge key={s} className="font-mono">{s}</Badge>)}</span></TD>
            <TD label="Created">{time(k.created_at, false)}</TD>
            <TD label="Last used">{time(k.last_used_at, k.last_used_at !== undefined)}</TD>
            <TD label="Status"><StatusBadge status={k.revoked_at ? "revoked" : k.paused ? "paused" : "active"} /></TD>
            <TD label="Actions">{!k.revoked_at && <RevokeKey id={k.id} name={k.name} />}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
