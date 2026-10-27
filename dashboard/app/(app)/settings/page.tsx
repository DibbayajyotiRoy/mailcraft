import { get } from "@/lib/api";
import { saveLlm, setKill } from "@/lib/actions";
import { ActionError, ErrorBanner, Json, StatusBadge } from "@/components/ui";
import { ConfirmButton } from "@/components/Confirm";

export const dynamic = "force-dynamic";

export default async function Settings({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const [s, ks, pol] = await Promise.all([get("/v1/settings"), get("/v1/kill-switch"), get("/v1/policy")]);
  const llm = s.data?.llm_provider ?? {};
  const dp = s.data?.delivery_path;
  return (
    <>
      <h1>Settings</h1>
      <ActionError err={err} />
      <h2>Delivery path</h2>
      {s.error ? <ErrorBanner error={s.error} /> : <p>{dp ? <><strong>{dp.kind}</strong> {dp.detail ?? ""}</> : "Not configured."}</p>}
      <h2>LLM provider</h2>
      <form action={saveLlm} className="stack">
        <label>Kind<input name="kind" required defaultValue={llm.kind ?? ""} placeholder="anthropic, openai-compatible, ..." /></label>
        <label>Model<input name="model" defaultValue={llm.model ?? ""} /></label>
        <label>Base URL<input name="base_url" type="url" defaultValue={llm.base_url ?? ""} /></label>
        <label>API key {llm.api_key_set && "(set; leave blank to keep)"}<input name="api_key" type="password" autoComplete="off" /></label>
        <button type="submit">Save provider</button>
      </form>
      <h2>Kill switch</h2>
      {ks.error ? <ErrorBanner error={ks.error} /> : (
        <form action={setKill} className="inline">
          <input type="hidden" name="from" value="/settings" />
          <input type="hidden" name="on" value={String(!ks.data.on)} />
          <StatusBadge status={ks.data.on ? "failed" : "active"} /> {ks.data.on ? "Engaged" : "Off"}
          {ks.data.on ? <button type="submit">Release</button>
            : <ConfirmButton className="danger" message="Engage the kill switch? All sending stops immediately.">Engage</ConfirmButton>}
        </form>
      )}
      <h2>Policy</h2>
      {pol.error ? <ErrorBanner error={pol.error} /> : <Json value={pol.data} />}
    </>
  );
}
