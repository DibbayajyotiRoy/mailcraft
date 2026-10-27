"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { truncateId } from "@/lib/format";
import { emailsHref, type EmailQuery } from "@/components/monitor/helpers";

/** Rows open a peek panel (`?open=id`). The subject is a real link (keyboard/middle-click); the row click is a mouse shortcut. */
export function EmailsTable({ rows, query }: { rows: any[]; query: EmailQuery }) {
  const router = useRouter();
  const open = (id: string) => router.push(emailsHref(query, { open: id }), { scroll: false });
  return (
    <Table caption="Emails">
      <THead><tr><TH>Status</TH><TH>Recipient</TH><TH>Subject</TH><TH>Stream</TH><TH>Created</TH><TH>ID</TH></tr></THead>
      <TBody>
        {rows.map((e) => (
          <TR key={e.id} data-selected={query.open === e.id || undefined} className="cursor-pointer data-[selected]:bg-accent-soft" onClick={(ev) => { if (!(ev.target as HTMLElement).closest("a,button")) open(e.id); }}>
            <TD label="Status"><StatusBadge status={e.status} size="sm" /></TD>
            <TD label="To" className="max-w-[16rem]"><span className="block truncate font-mono text-xs">{e.to_addr}</span></TD>
            <TD label="Subject" className="max-w-[22rem] max-md:text-left">
              <Link data-ui="link" href={emailsHref(query, { open: e.id })} scroll={false} className="block truncate font-medium hover:underline">{e.subject || "(no subject)"}</Link>
            </TD>
            <TD label="Stream" className="text-muted">{e.stream ?? ""}</TD>
            <TD label="Created" className="whitespace-nowrap text-muted"><RelativeTime value={e.created_at} /></TD>
            <TD label="ID"><span className="inline-flex items-center gap-0.5 font-mono text-xs text-muted" title={e.id}>{truncateId(e.id)}<CopyButton value={e.id} label={`Copy ID ${e.id}`} /></span></TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
