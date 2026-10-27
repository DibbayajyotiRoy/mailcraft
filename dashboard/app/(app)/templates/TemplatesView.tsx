"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, LayoutGrid, Mail, MoreHorizontal, Rows3, Search, FileText } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/field";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { cn } from "@/lib/cn";

export type TemplateRow = {
  id: string; alias?: string; name?: string; subject?: string; status?: string; version?: number; published_version?: number | null;
  updated_at?: string; thumb?: string | null;
};
const FORMATS = ["json", "html", "mjml"] as const;
const label = (t: TemplateRow) => t.name ?? t.alias ?? t.id;
export const hasUnpublished = (t: TemplateRow) => t.version != null && t.published_version != null && t.version > t.published_version;

export function ExportMenu({ id, name }: { id: string; name: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Export ${name}`} className="relative z-10"><MoreHorizontal aria-hidden /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Export as</DropdownMenuLabel>
        {FORMATS.map((f) => (
          <DropdownMenuItem key={f} asChild>
            <a href={`/templates/${id}/export?format=${f}`} download><Download aria-hidden />{f.toUpperCase()}</a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VersionChips({ t }: { t: TemplateRow }) {
  return (
    <>
      {t.version != null && <span className="text-xs text-muted">v{t.version}</span>}
      {hasUnpublished(t) && <Badge tone="info" size="sm">unpublished changes</Badge>}
    </>
  );
}

function Thumb({ t }: { t: TemplateRow }) {
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-t-lg border-b border-border bg-white">
      {t.thumb ? (
        // Rendered at 4x width and scaled to 25%: a real email layout at card size. Decorative, so unfocusable and hidden from AT.
        <iframe title={`${label(t)} preview`} aria-hidden tabIndex={-1} sandbox="" loading="lazy" srcDoc={t.thumb}
          className="pointer-events-none absolute left-0 top-0 h-[400%] w-[400%] origin-top-left scale-[.25] border-0" />
      ) : (
        <span aria-hidden className="grid h-full place-items-center bg-surface-2 text-subtle"><Mail className="size-8" /></span>
      )}
      <span aria-hidden className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgb(0_0_0/.06)]" />
    </div>
  );
}

export function TemplatesView({ templates }: { templates: TemplateRow[] }) {
  const [view, setView] = useState<"grid" | "table">("grid");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? templates.filter((t) => [t.name, t.alias, t.subject].some((s) => s?.toLowerCase().includes(n))) : templates;
  }, [templates, q]);

  if (!templates.length) {
    return (
      <EmptyState icon={FileText} title="No templates yet" description="Import an HTML, MJML or JSON template, or create one from the CLI. A template must be published before sends can use it." />
    );
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input type="search" aria-label="Search templates" placeholder="Search by name, alias or subject" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div role="group" aria-label="Layout" className="flex gap-1">
          <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid aria-hidden /></Button>
          <Button variant={view === "table" ? "secondary" : "ghost"} size="icon" aria-label="Table view" aria-pressed={view === "table"} onClick={() => setView("table")}><Rows3 aria-hidden /></Button>
        </div>
      </div>
      <p className="sr-only" role="status">{shown.length} of {templates.length} templates</p>
      {!shown.length ? (
        <EmptyState variant="no-results" title="No templates match" description={`Nothing matches “${q}”. Try a different name or alias.`} action={<Button variant="secondary" onClick={() => setQ("")}>Clear search</Button>} />
      ) : view === "grid" ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((t) => (
            <li key={t.id} className="group relative rounded-lg border border-border bg-surface transition-[border-color,box-shadow] duration-[var(--dur-fast)] hover:border-border-strong hover:shadow-pop focus-within:border-border-strong">
              <Thumb t={t} />
              <div className="flex items-start justify-between gap-2 p-3">
                <div className="min-w-0">
                  <Link href={`/templates/${t.id}`} data-ui="link" className="block truncate font-medium after:absolute after:inset-0 after:content-['']">{label(t)}</Link>
                  <p className="truncate text-xs text-muted">{t.subject || <span className="text-subtle">No subject</span>}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {t.status && <StatusBadge status={t.status} size="sm" />}
                    <VersionChips t={t} />
                  </div>
                </div>
                <ExportMenu id={t.id} name={label(t)} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Table caption="Templates">
          <THead><TR><TH>Name</TH><TH>Status</TH><TH>Subject</TH><TH>Updated</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
          <TBody>
            {shown.map((t) => (
              <TR key={t.id}>
                <TD label="Name"><Link href={`/templates/${t.id}`} data-ui="link" className={cn("font-medium text-accent hover:underline")}>{label(t)}</Link>{t.alias && t.name && <span className="ml-2 font-mono text-xs text-muted">{t.alias}</span>}</TD>
                <TD label="Status"><span className="inline-flex items-center gap-2">{t.status && <StatusBadge status={t.status} size="sm" />}<VersionChips t={t} /></span></TD>
                <TD label="Subject" className="max-w-xs truncate">{t.subject ?? ""}</TD>
                <TD label="Updated">{t.updated_at ? <RelativeTime value={t.updated_at} className="text-muted" /> : <span className="text-subtle">-</span>}</TD>
                <TD label="Export"><ExportMenu id={t.id} name={label(t)} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
