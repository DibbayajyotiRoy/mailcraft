"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, type ApiError } from "@/lib/api";
import { withFlash } from "@/lib/flash";
import { BLANK_MJML, contentBody, type Draft } from "./[id]/util";

/** Publish the current draft: sends use the published version. Errors come back as ?err=, success as a toast. */
export async function publishTemplate(d: FormData) {
  const id = String(d.get("id") ?? "");
  const to = `/templates/${encodeURIComponent(id)}`;
  const r = await api("POST", `/v1/templates/${encodeURIComponent(id)}/publish`);
  if (r.error) redirect(`${to}?err=${encodeURIComponent(`${r.error.code}|${r.error.message}|${r.error.hint ?? ""}`)}`);
  revalidatePath("/", "layout");
  redirect(withFlash(to, "Template published"));
}

type Failure = { error?: ApiError };
const tpl = (id: string) => `/v1/templates/${encodeURIComponent(id)}`;
const FORMATS = ["html", "mjml", "json"];

/** Saves the editor as a new draft version (PATCH adds a version; sends keep using the published one). */
export async function saveTemplate(i: { id: string; draft: Draft }): Promise<Failure & { version?: number; warnings?: string[] }> {
  if (!FORMATS.includes(i?.draft?.format) || typeof i.draft.body !== "string" || typeof i.id !== "string") return { error: { code: "invalid_request", message: "Nothing to save." } };
  const r = await api("PATCH", tpl(i.id), contentBody(i.draft));
  if (r.error) return { error: r.error };
  revalidatePath("/", "layout");
  return { version: r.data?.version, warnings: r.data?.warnings ?? [] };
}

/** Name, alias and stream change in place (no new version). Alias is what sends and automations reference. */
export async function updateTemplateDetails(i: { id: string; name: string; alias: string; stream: string }): Promise<Failure> {
  const r = await api("PATCH", tpl(i.id), { name: String(i.name ?? "").trim(), alias: String(i.alias ?? "").trim(), stream: String(i.stream ?? "") });
  if (r.error) return { error: r.error };
  revalidatePath("/", "layout");
  return {};
}

function back(id: string, r: { error: ApiError | null }, ok: string): never {
  const to = `/templates/${encodeURIComponent(id)}`;
  if (r.error) redirect(`${to}?err=${encodeURIComponent(`${r.error.code}|${r.error.message}|${r.error.hint ?? ""}`)}`);
  revalidatePath("/", "layout");
  redirect(withFlash(to, ok));
}

/** Copies an older version into a new draft; nothing is published. */
export async function restoreVersion(d: FormData) {
  const id = String(d.get("id") ?? ""), v = Number(d.get("version"));
  const r = await api("POST", `${tpl(id)}/versions/${v}/restore`);
  back(id, r, `Restored v${v} as draft v${r.data?.version}`);
}

/** Drops the unpublished versions so the published one is the newest again. */
export async function discardDraft(d: FormData) {
  const id = String(d.get("id") ?? "");
  back(id, await api("DELETE", `${tpl(id)}/draft`), "Draft discarded");
}

/** Create a draft from pasted HTML / MJML or the blank starter, then open it in the editor. */
export async function createTemplate(_p: unknown, d: FormData): Promise<{ error?: ApiError }> {
  const name = String(d.get("name") ?? "").trim(), start = String(d.get("start") ?? "blank");
  const format = start === "html" ? "html" : "mjml";
  const content = start === "blank" ? BLANK_MJML : String(d.get("content") ?? "");
  const r = await api("POST", "/v1/templates/import", { format, name, content });
  if (r.error) return { error: r.error };
  revalidatePath("/templates");
  redirect(`/templates/${encodeURIComponent(r.data.id)}?edit=1`);
}
