import Link from "next/link";
import { get } from "@/lib/api";
import { parseErr } from "@/lib/err";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button-variants";
import { ErrorState, RetryError } from "@/components/ui/error-state";
import { AddContact } from "./ContactForm";
import { ContactsView, type Contact, type Segment } from "./ContactsView";
import type { ListItem } from "./util";
import { ImportContacts } from "./ImportContacts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contacts" };

export default async function Contacts({ searchParams }: { searchParams: Promise<{ tab?: string; cursor?: string; q?: string; list?: string; err?: string }> }) {
  const { tab, cursor, q, list, err } = await searchParams;
  const qs = new URLSearchParams({ limit: "50" });
  if (cursor) qs.set("cursor", cursor);
  if (q?.trim()) qs.set("q", q.trim());
  if (list) qs.set("list", list);
  const [c, s, autos, defs, ls] = await Promise.all([get(`/v1/contacts?${qs}`), get("/v1/segments"), get("/v1/automations"), get("/v1/event-definitions"), get("/v1/lists")]);
  const lists = (Array.isArray(ls.data) ? ls.data : []) as ListItem[];
  // Event names for the segment rule builder: what automations listen for, plus declared events.
  const events = [...new Set([...((autos.data ?? []) as { trigger?: string }[]).map((a) => a.trigger), ...((defs.data ?? []) as { name: string }[]).map((d) => d.name)])]
    .filter((n): n is string => !!n && n !== "segment.entered").sort();
  const actionErr = parseErr(err);
  return (
    <>
      <PageHeader title="Contacts" description="People you email, and the segments that group them." action={<><ImportContacts lists={lists} /><AddContact /></>} />
      {actionErr && <ErrorState className="mb-4" error={actionErr} />}
      {c.error && s.error ? <RetryError error={c.error} /> : (
        <>
          <ContactsView lists={lists} activeList={list} contacts={c.error ? null : ((Array.isArray(c.data) ? c.data : []) as Contact[])} segments={s.error ? null : ((Array.isArray(s.data) ? s.data : []) as Segment[])} contactsError={c.error} segmentsError={s.error} tab={tab === "segments" ? "segments" : tab === "lists" ? "lists" : "contacts"} search={q?.trim() ?? ""} events={events} />
          {c.next_cursor && <div className="mt-4"><Link rel="next" href={`/contacts?${new URLSearchParams({ ...(q ? { q } : {}), ...(list ? { list } : {}), cursor: c.next_cursor })}`} className={buttonVariants({ variant: "secondary" })}>Next page</Link></div>}
        </>
      )}
    </>
  );
}
