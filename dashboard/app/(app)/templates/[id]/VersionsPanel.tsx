"use client";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { restoreVersion } from "../actions";
import { DraftState } from "./DraftState";

export type VersionRow = { version: number; source_format?: string; created_at?: string; published_at?: string | null; published?: boolean };

/** Version history, newest first. Restore copies an old version into a new draft (nothing goes live until you publish it). */
export function VersionsPanel({ template: t, versions }: { template: any; versions?: VersionRow[] }) {
  const newest = versions?.[0]?.version ?? t.version;
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Versions" description="Sends use the published version. Every save creates a new draft; publishing makes the newest one live." />
      <CardBody className="grid gap-4">
        <DraftState template={t} />
        {!versions?.length ? (
          <EmptyState title="No history available" description="The API did not return a version list." className="border-0 py-6" />
        ) : (
          <Table caption="Template versions">
            <THead><TR><TH>Version</TH><TH>State</TH><TH>Source</TH><TH>Saved</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>
              {versions.map((v) => (
                <TR key={v.version}>
                  <TD label="Version"><span className="font-medium">v{v.version}</span></TD>
                  <TD label="State">
                    {v.published ? <StatusBadge status="published" size="sm" label="Live" />
                      : v.published_at ? <Badge size="sm">Previously live</Badge>
                      : t.published_version == null || v.version > t.published_version ? <Badge tone="info" size="sm">Draft</Badge> : <Badge size="sm">Older</Badge>}
                  </TD>
                  <TD label="Source"><code className="text-xs">{v.source_format ?? "-"}</code></TD>
                  <TD label="Saved">{v.created_at ? <RelativeTime value={v.created_at} className="text-muted" /> : "-"}</TD>
                  <TD label="Actions" className="md:text-right">
                    {v.version !== newest && (
                      <form action={restoreVersion}>
                        <input type="hidden" name="id" value={t.id} />
                        <input type="hidden" name="version" value={v.version} />
                        <SubmitButton variant="secondary" size="sm" aria-label={`Restore v${v.version}`}>Restore</SubmitButton>
                      </form>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className="text-sm text-muted">{t.alias && <>Alias <code>{t.alias}</code>. </>}Restore copies a version into a new draft. It does not change what is live.</p>
      </CardBody>
    </Card>
  );
}
