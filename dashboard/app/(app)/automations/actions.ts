"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, type ApiError, type ApiResult } from "@/lib/api";
import { withFlash } from "@/lib/flash";

const enc = encodeURIComponent;
const back = (to: string, e: ApiError) => `${to}${to.includes("?") ? "&" : "?"}err=${enc(`${e.code}|${e.message}|${e.hint ?? ""}`)}`;

export type SaveState = { error?: ApiError };

/** useActionState-shaped: an API refusal comes back as state so the editor (and everything typed into it) stays put; success redirects. */
export async function saveAutomation(_p: SaveState, d: FormData): Promise<SaveState> {
  let def: unknown;
  try { def = JSON.parse(String(d.get("definition") ?? "")); } catch { return { error: { code: "invalid_request", message: "The editor sent an unreadable definition.", hint: "Reload the page and try again." } }; }
  const r = await api("POST", "/v1/automations", def);
  if (r.error) return { error: r.error };
  const to = `/automations/${enc(r.data.id)}`;
  revalidatePath("/", "layout");
  if (d.get("intent") !== "publish") redirect(withFlash(to, `Saved as version ${r.data.version}`));
  const p = await api("POST", `/v1/automations/${enc(r.data.id)}/publish`, { backfill_suppress: d.get("backfill") === "on" });
  redirect(p.error ? back(to, p.error) : withFlash(to, "Published. Contacts matching the trigger now enter."));
}

/** archive | unarchive (the other state changes live in lib/actions `automationState`). */
export async function archiveAutomation(d: FormData) {
  const id = String(d.get("id") ?? ""), action = d.get("action") === "unarchive" ? "unarchive" : "archive";
  const to = `/automations/${enc(id)}`;
  const r = await api("POST", `/v1/automations/${enc(id)}/${action}`);
  if (r.error) redirect(back(to, r.error));
  revalidatePath("/", "layout");
  redirect(action === "archive" ? withFlash("/automations", "Archived. It no longer runs.") : withFlash(to, "Restored as a draft."));
}

export type TestRunState = { run?: { run_id: string; env: string; email: string }; error?: ApiError };

export async function startTestRun(_p: TestRunState, d: FormData): Promise<TestRunState> {
  const email = String(d.get("email") ?? "").trim(), raw = String(d.get("properties") ?? "").trim();
  let properties: unknown;
  if (raw) {
    try { properties = JSON.parse(raw); } catch { properties = null; }
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return { error: { code: "invalid_request", message: "Event properties must be a JSON object.", hint: 'Example: {"plan": "pro"}' } };
  }
  const r = await api("POST", `/v1/automations/${enc(String(d.get("id")))}/test`, { email, ...(properties ? { properties } : {}) });
  if (r.error) return { error: r.error };
  revalidatePath("/automations", "layout");
  return { run: { run_id: r.data.run_id, env: r.data.env, email } };
}

/** Polled by the run-progress panel. */
export async function runDetail(automation: string, run: string): Promise<ApiResult> {
  return api("GET", `/v1/automations/${enc(automation)}/runs/${enc(run)}`);
}
