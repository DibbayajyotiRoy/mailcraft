"use server";
// Settings-page server actions. useActionState-shaped: success/error stay on the page (no redirect), so each card
// can show its own result and the write-only secrets never travel through a URL.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api, type ApiResult } from "@/lib/api";
import { mailboxFields } from "./addresses";
import { withFlash } from "@/lib/flash";

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
  return put("/v1/settings", { reply_to: f(d, "reply_to") }, "Sender defaults saved."); // the default From lives in the Senders card
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
  const config: Record<string, unknown> = { password: f(d, "password") };
  if (f(d, "username")) config.username = f(d, "username");
  if (f(d, "region")) config.region = f(d, "region");
  let name = f(d, "name") || preset;
  // `custom` is not an API preset: host/port go in config instead.
  if (preset === "custom") {
    const mailbox = d.get("mailbox_sender") === "on";
    const port = Number(f(d, "port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "Enter the SMTP port, a number from 1 to 65535 (587 for most providers)." };
    Object.assign(config, { host: f(d, "host"), port, mailbox_sender: mailbox });
    name = f(d, "name") || (mailbox ? f(d, "username") : `${f(d, "host")}:${port}`); // a mailbox is named by its login, other servers by host:port
    if (mailbox) { // the login's own display name and the "send as" aliases
      const m = mailboxFields(d, f(d, "username"));
      if (m.aliases.length) config.aliases = m.aliases;
      if (Object.keys(m.display_names).length) config.display_names = m.display_names;
    }
  }
  const r = await api("POST", "/v1/transports", { kind: "smtp-relay", preset: preset === "custom" ? undefined : preset, name, config });
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

// ------------------------------------------------------------------ contact sources

const num = (d: FormData, k: string) => (f(d, k) === "" ? undefined : Number(f(d, k)));
const counts = (c: Record<string, number> | null | undefined) => (c ? `${c.created ?? 0} new, ${c.updated ?? 0} updated, ${c.skipped ?? 0} skipped, ${c.deleted ?? 0} deleted` : "");

/** Add (no id) or edit (id) a source. A blank key on edit keeps the stored one; a typed key rotates it. */
export async function saveSource(_p: Result, d: FormData): Promise<Result> {
  const id = f(d, "id");
  const body: Record<string, unknown> = { name: f(d, "name"), url: f(d, "url"), interval_minutes: num(d, "interval_minutes"), full_sync_hours: num(d, "full_sync_hours") };
  if (f(d, "key")) body.key = f(d, "key");
  if (!id && f(d, "list_name")) body.list_name = f(d, "list_name");
  const r = id ? await api("PATCH", `/v1/contact-sources/${encodeURIComponent(id)}`, body) : await api("POST", "/v1/contact-sources", body);
  if (r.error) return fail(r);
  revalidatePath("/settings");
  return { ok: id ? `Saved ${f(d, "name")}.` : `Added ${f(d, "name")}. It syncs within a minute, or press Sync now.` };
}

export async function toggleSource(_p: Result, d: FormData): Promise<Result> {
  const r = await api("PATCH", `/v1/contact-sources/${encodeURIComponent(f(d, "id"))}`, { enabled: f(d, "enabled") === "true" });
  if (r.error) return fail(r);
  revalidatePath("/settings");
  return { ok: f(d, "enabled") === "true" ? "Syncing is on." : "Syncing is paused." };
}

/** Fetches one page with limit=1 and says what came back. Works with typed values, or with a saved source (`id`) for what is left blank. */
export async function testSource(_p: Result, d: FormData): Promise<Result> {
  const r = await api("POST", "/v1/contact-sources/test", { id: f(d, "id") || undefined, url: f(d, "url") || undefined, key: f(d, "key") || undefined });
  if (r.error) return fail(r);
  const t = r.data;
  if (!t.ok) return { error: t.error ?? "The test failed." };
  return { ok: t.sample_count ? `Connected. Fields: ${(t.fields ?? []).join(", ")}${t.property_keys?.length ? `; attributes: ${t.property_keys.join(", ")}` : ""}.` : "Connected, but the source returned no contacts yet." };
}

/** Runs the sync now and waits (up to two minutes). */
export async function syncSource(_p: Result, d: FormData): Promise<Result> {
  const r = await api("POST", `/v1/contact-sources/${encodeURIComponent(f(d, "id"))}/sync`, undefined, 120_000);
  revalidatePath("/settings");
  if (r.error) return fail(r);
  return r.data.ok ? { ok: `Synced: ${counts(r.data.counts)}.` } : { error: r.data.error ?? "The sync failed." };
}

export type SourcePreview = { rows?: unknown[]; summary?: Record<string, number>; list?: { name: string } | null; hasMore?: boolean; error?: string };

/** Dry run of the next sync: the first page only, nothing written. */
export async function previewSource(id: string): Promise<SourcePreview> {
  const r = await api("POST", `/v1/contact-sources/${encodeURIComponent(id)}/sync?dry_run=true`, undefined, 60_000);
  if (r.error) return { error: `${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ""}` };
  if (!r.data.ok) return { error: r.data.error ?? "The preview failed." };
  return { rows: r.data.rows, summary: r.data.summary, list: r.data.list, hasMore: r.data.has_more };
}

/** Contacts and suppressions stay. The list is kept (detached) unless `delete_list` is ticked. */
export async function deleteSource(d: FormData) {
  const r = await api("DELETE", `/v1/contact-sources/${encodeURIComponent(f(d, "id"))}${d.get("delete_list") === "on" ? "?delete_list=true" : ""}`);
  if (r.error) redirect(`/settings?err=${encodeURIComponent(`${r.error.code}|${r.error.message}|${r.error.hint ?? ""}`)}#sources`);
  revalidatePath("/settings");
  redirect(`${withFlash("/settings", `Deleted ${f(d, "name")}. Its contacts are kept.`)}#sources`); // the flash goes in the query, before the fragment
}
