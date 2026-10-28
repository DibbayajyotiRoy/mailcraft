import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { RetryError } from "@/components/ui/error-state";
import { NewBroadcast } from "@/components/broadcasts/new-broadcast";
import { initialFrom, sendersOf } from "@/lib/senders";
import { sendEmail } from "../../emails/actions";
import { createBroadcast, previewBroadcast } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "New broadcast" };

export default async function NewBroadcastPage() {
  const [t, s, snd] = await Promise.all([get("/v1/templates"), get("/v1/settings"), get("/v1/senders")]);
  const senders = sendersOf(snd);
  const head = <PageHeader title="New broadcast" breadcrumb={[{ label: "Broadcasts", href: "/broadcasts" }, { label: "New" }]} description="Choose recipients, preview the email for each, then send." />;
  if (t.error) return <>{head}<RetryError error={t.error} /></>;
  const templates = (Array.isArray(t.data) ? t.data : []).filter((x: any) => x.status === "published");
  return (
    <>
      {head}
      <NewBroadcast templates={templates} defaultFrom={initialFrom(s.data?.default_from, senders)} senders={senders} actions={{ preview: previewBroadcast, create: createBroadcast, sendTest: sendEmail }} />
    </>
  );
}
