import { get } from "@/lib/api";
import { parseErr } from "@/lib/err";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { InstructionsForm } from "@/components/Instructions";
import { DeliveryCard } from "./delivery";
import { GeneralCard, PolicyCard, ProviderCard } from "./forms";
import { SettingsNav } from "./nav";
import { KillSwitchCard } from "./safety";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · mailcraft" };

export default async function Settings({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const actionErr = parseErr(err);
  const [s, ks, pol, tr, st] = await Promise.all([get("/v1/settings"), get("/v1/kill-switch"), get("/v1/policy"), get("/v1/transports"), get("/v1/account/status")]);
  const d = s.data ?? {};
  const llm = d.llm_provider ?? {};
  // Admin-only actions: if the API does not report scopes, do not guess a lock; the server still enforces it.
  const scopes: string[] | undefined = st.data?.scopes ?? st.data?.key?.scopes;
  const admin = scopes ? scopes.includes("admin") : true;
  const e = (r: { error: any }, what: string) => r.error && <ErrorState error={{ ...r.error, message: `Could not load ${what}: ${r.error.message}` }} />;
  return (
    <>
      <PageHeader title="Settings" description="Sender defaults, delivery, AI and safety for this workspace." />
      {actionErr && <ErrorState error={actionErr} />}
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,720px)] lg:gap-10">
        <SettingsNav />
        <div className="grid gap-6">
          {s.error ? e(s, "settings") : (
            <>
              <GeneralCard from={d.default_from ?? ""} replyTo={d.reply_to ?? ""} canEdit={admin} />
              <DeliveryCard path={d.delivery_path} transports={Array.isArray(tr.data) ? tr.data : []} canEdit />
              <ProviderCard kind={llm.kind ?? ""} model={llm.model ?? ""} baseUrl={llm.base_url ?? ""} keySet={!!llm.api_key_set} canEdit />
              <InstructionsForm initial={d.custom_instructions ?? ""} />
            </>
          )}
          {pol.error ? e(pol, "the policy") : <PolicyCard send={pol.data?.default?.send ?? ""} keys={pol.data?.keys ?? []} canEdit={admin} />}
          {ks.error ? e(ks, "the kill switch") : <KillSwitchCard on={!!ks.data.on} admin={admin} />}
        </div>
      </div>
    </>
  );
}
