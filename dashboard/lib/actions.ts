"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, keyBody, request, type ApiResult } from "./api";

const f = (d: FormData, k: string) => String(d.get(k) ?? "").trim();
const cookie = (base: string) => ({ httpOnly: true, sameSite: "strict" as const, secure: base.startsWith("https:"), path: "/", maxAge: 60 * 60 * 12 });

/** Success -> refresh + go to `to`; failure -> back to `from` with the error in the query string. */
function done(r: ApiResult, from: string, to = from): never {
  if (r.error) redirect(`${from}${from.includes("?") ? "&" : "?"}err=${encodeURIComponent(`${r.error.code}|${r.error.message}|${r.error.hint ?? ""}`)}`);
  revalidatePath("/", "layout");
  redirect(to);
}

export async function login(d: FormData) {
  const base = f(d, "base").replace(/\/+$/, ""), key = f(d, "key");
  if (!/^https?:\/\//.test(base)) redirect(`/login?err=${encodeURIComponent("invalid_url|Base URL must start with http:// or https://|")}`);
  const r = await request(base, key, "GET", "/v1/account/status");
  if (r.error) redirect(`/login?err=${encodeURIComponent(`${r.error.code}|${r.error.message}|${r.error.hint ?? ""}`)}`);
  const c = await cookies();
  c.set("mc_key", key, cookie(base));
  c.set("mc_base", base, cookie(base));
  redirect("/");
}

export async function logout() {
  const c = await cookies();
  c.delete("mc_key"); c.delete("mc_base");
  redirect("/login");
}

export async function setKill(d: FormData) {
  done(await api("POST", "/v1/kill-switch", { on: f(d, "on") === "true" }), f(d, "from") || "/");
}

export async function addDomain(d: FormData) {
  done(await api("POST", "/v1/domains", { domain: f(d, "domain"), stream: f(d, "stream") || undefined }), "/domains");
}
export async function verifyDomain(d: FormData) { done(await api("POST", `/v1/domains/${f(d, "id")}/verify`), "/domains"); }

export async function importTemplate(d: FormData) {
  done(await api("POST", "/v1/templates/import", { format: f(d, "format"), name: f(d, "name"), content: String(d.get("content") ?? "") }), "/templates");
}

export async function automationState(d: FormData) {
  done(await api("POST", `/v1/automations/${f(d, "id")}/${f(d, "action")}`), f(d, "from") || "/automations");
}

export async function decide(d: FormData) {
  done(await api("POST", `/v1/approvals/${f(d, "id")}/decide`, { decision: f(d, "decision") }), "/approvals");
}

export async function revokeKey(d: FormData) { done(await api("DELETE", `/v1/keys/${f(d, "id")}`), "/keys"); }

/** useActionState-shaped so the one-time secret never travels through a URL. */
export async function createKey(_p: unknown, d: FormData): Promise<{ secret?: string; error?: string }> {
  const r = await api("POST", "/v1/keys", keyBody(f(d, "name"), f(d, "scopes"), f(d, "env")));
  if (r.error) return { error: `${r.error.code}: ${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ""}` };
  revalidatePath("/keys");
  return { secret: r.data?.token ?? JSON.stringify(r.data) };
}

export async function saveLlm(d: FormData) {
  const llm: Record<string, string> = { kind: f(d, "kind") };
  for (const k of ["model", "base_url", "api_key"]) if (f(d, k)) llm[k] = f(d, k); // blank key = keep existing
  done(await api("PUT", "/v1/settings", { llm_provider: llm }), "/settings");
}
