import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { RetryError } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { AutoRefresh } from "@/components/broadcasts/auto-refresh";
import { COUNTS } from "@/lib/broadcast";

export const dynamic = "force-dynamic";
export const metadata = { title: "Broadcasts" };

export default async function Broadcasts({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  const r = await get(`/v1/broadcasts?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  const header = <PageHeader title="Broadcasts" description="Send one template to a list, paced to your sending limit." action={<Button asChild><Link href="/broadcasts/new"><Plus aria-hidden />New broadcast</Link></Button>} />;
  if (r.error) return <>{header}<RetryError error={r.error} /></>;
  const rows: any[] = Array.isArray(r.data) ? r.data : [];
  if (!rows.length) {
    return <>{header}<EmptyState icon={Megaphone} title="No broadcasts yet" description="Upload a CSV, pick a published template and send it to everyone on the list. Each recipient is tracked here." action={<Button asChild><Link href="/broadcasts/new">Create a broadcast</Link></Button>} /></>;
  }
  return (
    <>
      {header}
      <AutoRefresh active={rows.some((b) => b.status !== "done")} />
      <Table caption="Broadcasts">
        <THead><tr><TH>Broadcast</TH><TH>Status</TH>{COUNTS.map((c) => <TH key={c} className="text-right capitalize">{c}</TH>)}<TH>Created</TH></tr></THead>
        <TBody>
          {rows.map((b) => (
            <TR key={b.id}>
              <TD label="Broadcast" className="max-w-[20rem]">
                <Link href={`/broadcasts/${b.id}`} className="block truncate font-medium text-accent hover:underline">{b.subject || b.template_name}</Link>
                <span className="block truncate text-xs text-muted">{b.template_name} · {b.total} recipients · {b.stream}</span>
              </TD>
              <TD label="Status"><StatusBadge status={b.status} size="sm" /></TD>
              {COUNTS.map((c) => <TD key={c} label={c[0].toUpperCase() + c.slice(1)} num>{b.counts?.[c] ?? 0}</TD>)}
              <TD label="Created" className="whitespace-nowrap text-muted"><RelativeTime value={b.created_at} /></TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3 text-sm">
        <span className="text-muted">{rows.length} {rows.length === 1 ? "broadcast" : "broadcasts"}</span>
        <span className="flex gap-2">
          {cursor && <Button asChild variant="secondary"><Link href="/broadcasts">First page</Link></Button>}
          {r.next_cursor && <Button asChild variant="secondary"><Link rel="next" href={`/broadcasts?cursor=${encodeURIComponent(r.next_cursor)}`}>Next page</Link></Button>}
        </span>
      </nav>
    </>
  );
}
