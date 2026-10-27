"use client";
import { Loader2, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Input, Select } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { emailsHref, type EmailQuery } from "@/components/monitor/helpers";

export const STATUSES = ["queued", "pending_approval", "sending", "deferred", "sent", "delivered", "bounced", "failed", "suppressed", "cancelled"];
const lbl = "grid gap-1 text-xs font-medium text-muted";

/** Filters live in the URL; changes soft-navigate (router.replace) so there is no full reload. Search is debounced. */
export function EmailFilters({ query, debounceMs = 250 }: { query: EmailQuery; debounceMs?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(query.q ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { setQ(query.q ?? ""); }, [query.q]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const go = (patch: EmailQuery) => start(() => router.replace(emailsHref(query, patch, true), { scroll: false }));
  const active = !!(query.q || query.status || query.from || query.to);
  return (
    <form role="search" aria-label="Filter emails" onSubmit={(e) => { e.preventDefault(); clearTimeout(timer.current); go({ q }); }} className="mb-4 flex flex-wrap items-end gap-3">
      <label className={`${lbl} min-w-[220px] flex-1 sm:max-w-sm`}>Search
        <span className="relative block">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input type="search" name="q" value={q} placeholder="Recipient, subject or ID" className="pl-8"
            onChange={(e) => { const v = e.target.value; setQ(v); clearTimeout(timer.current); timer.current = setTimeout(() => go({ q: v }), debounceMs); }} />
        </span>
      </label>
      <label className={lbl}>Status
        <Select name="status" value={query.status ?? ""} onChange={(e) => go({ status: e.target.value })}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </Select>
      </label>
      <label className={lbl}>From
        <Input type="date" name="from" value={query.from ?? ""} max={query.to || undefined} onChange={(e) => go({ from: e.target.value })} />
      </label>
      <label className={lbl}>To
        <Input type="date" name="to" value={query.to ?? ""} min={query.from || undefined} onChange={(e) => go({ to: e.target.value })} />
      </label>
      {active && <Button variant="ghost" onClick={() => { setQ(""); start(() => router.replace("/emails", { scroll: false })); }}><X aria-hidden />Clear</Button>}
      <span role="status" aria-live="polite" className="inline-flex h-8 items-center text-xs text-muted">{pending && <><Loader2 aria-hidden className="mr-1 size-3 animate-spin" />Updating…</>}</span>
    </form>
  );
}
