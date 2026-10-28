import Link from "next/link";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button-variants";
import { RetryError } from "@/components/ui/error-state";
import { ContactsView, type Contact, type Segment } from "./ContactsView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contacts" };

export default async function Contacts({ searchParams }: { searchParams: Promise<{ tab?: string; cursor?: string; q?: string }> }) {
  const { tab, cursor, q } = await searchParams;
  const qs = new URLSearchParams({ limit: "50" });
  if (cursor) qs.set("cursor", cursor);
  if (q?.trim()) qs.set("q", q.trim());
  const [c, s] = await Promise.all([get(`/v1/contacts?${qs}`), get("/v1/segments")]);
  return (
    <>
      <PageHeader title="Contacts" description="People you email, and the segments that group them." />
      {c.error && s.error ? <RetryError error={c.error} /> : (
        <>
          <ContactsView contacts={c.error ? null : ((Array.isArray(c.data) ? c.data : []) as Contact[])} segments={s.error ? null : ((Array.isArray(s.data) ? s.data : []) as Segment[])} contactsError={c.error} segmentsError={s.error} tab={tab === "segments" ? "segments" : "contacts"} search={q?.trim() ?? ""} />
          {c.next_cursor && <div className="mt-4"><Link rel="next" href={`/contacts?${new URLSearchParams({ ...(q ? { q } : {}), cursor: c.next_cursor })}`} className={buttonVariants({ variant: "secondary" })}>Next page</Link></div>}
        </>
      )}
    </>
  );
}
