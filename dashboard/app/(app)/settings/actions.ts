"use server";
// Settings-page server actions. useActionState-shaped: success/error stay on the page (no redirect), so each card
// can show its own result and the write-only secrets never travel through a URL.
import { revalidatePath } from "next/cache";
import { api, type ApiResult } from "@/lib/api";

export type Result = { ok?: string; error?: string; url?: string };
const f = (d: FormData, k: string) => String(d.get(k) ?? "").trim();
const fail = (r: ApiResult): Result => ({ error: `${r.error!.message}${r.error!.hint ? ` (${r.error!.hint})` : ""}` });

async function put(path: string, body: unknown, ok: string): Promise<Result> {
  const r = await api("PUT", path, body);
  if (r.error) return fail(r);
  revalidatePath("/settings");
  return { ok };
}

export async function saveGeneral(_p: Result, d: FormData) {
  return put("/v1/settings", { default_from: f(d, "default_from"), reply_to: f(d, "reply_to") }, "Sender defaults saved.");
}

export async function saveProvider(_p: Result, d: FormData) {
  const llm: Record<string, string> = { kind: f(d, "kind") };
  for (const k of ["model", "base_url", "api_key"]) if (f(d, k)) llm[k] = f(d, k); // blank key = keep the stored one
  return put("/v1/settings", { llm_provider: llm }, "Provider saved.");
}

export async function savePolicy(_p: Result, d: FormData) {
  return put("/v1/policy", { default: { send: f(d, "send") } }, "Default policy saved.");
}

export async function addRelay(_p: Result, d: FormData): Promise<Result> {
  const preset = f(d, "preset");
  const config: Record<string, string | number | boolean> = { password: f(d, "password") };
  if (f(d, "username")) config.username = f(d, "username");
  if (f(d, "region")) config.region = f(d, "region");
  // `custom` is not an API preset: host/port go in config instead.
  if (preset === "custom") Object.assign(config, { host: f(d, "host"), port: Number(f(d, "port")), mailbox_sender: d.get("mailbox_sender") === "on" });
  const r = await api("POST", "/v1/transports", { kind: "smtp-relay", preset: preset === "custom" ? undefined : preset, name: f(d, "name") || preset, config });
  if (r.error) return fail(r);
  revalidatePath("/settings");
  return { ok: `${preset} relay added. Run the test to confirm the credentials.` };
}

export async function testTransport(_p: Result, d: FormData): Promise<Result> {
  const r = await api("POST", `/v1/transports/${encodeURIComponent(f(d, "id"))}/test`);
  if (r.error) return fail(r);
  return r.data?.ok ? { ok: r.data.detail || "Connection works." } : { error: r.data?.detail || "The test failed." };
}

/** Starts Gmail OAuth; the callback URL must be registered with the Google client (instance-level). */
export async function gmailStart(_p: Result, d: FormData): Promise<Result> {
  const r = await api("POST", "/v1/transports/gmail/oauth/start", { redirect_uri: f(d, "redirect_uri") });
  if (r.error) return r.error.code === "oauth_not_configured"
    ? { error: "Gmail is not set up on this server. The operator must set MAILCRAFT_GOOGLE_CLIENT_ID." } : fail(r);
  return { url: r.data.auth_url };
}
