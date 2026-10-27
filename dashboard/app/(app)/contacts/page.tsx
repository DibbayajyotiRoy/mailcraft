import Link from "next/link";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ApiErrorState } from "../_p3/ApiErrorState";
import { ContactsView, type Contact, type Segment } from "./ContactsView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contacts" };

export default async function Contacts({ searchParams }: { searchParams: Promise<{ tab?: string; cursor?: string }> }) {
  const { tab, cursor } = await searchParams;
  const [c, s] = await Promise.all([get(`/v1/contacts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), get("/v1/segments")]);
  return (
    <>
      <PageHeader title="Contacts" description="People you email, and the segments that group them." />
      {c.error && s.error ? <ApiErrorState error={c.error} /> : (
        <>
          <ContactsView contacts={c.error ? null : ((Array.isArray(c.data) ? c.data : []) as Contact[])} segments={s.error ? null : ((Array.isArray(s.data) ? s.data : []) as Segment[])} contactsError={c.error} segmentsError={s.error} tab={tab === "segments" ? "segments" : "contacts"} />
          {c.next_cursor && <div className="mt-4"><Link rel="next" href={`/contacts?cursor=${encodeURIComponent(c.next_cursor)}`} className={buttonVariants({ variant: "secondary" })}>Next page</Link></div>}
        </>
      )}
    </>
  );
}
