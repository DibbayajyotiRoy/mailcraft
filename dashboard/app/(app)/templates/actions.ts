"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import { withFlash } from "@/lib/flash";

/** Publish the current draft: sends use the published version. Errors come back as ?err=, success as a toast. */
export async function publishTemplate(d: FormData) {
  const id = String(d.get("id") ?? "");
  const to = `/templates/${encodeURIComponent(id)}`;
  const r = await api("POST", `/v1/templates/${encodeURIComponent(id)}/publish`);
  if (r.error) redirect(`${to}?err=${encodeURIComponent(`${r.error.code}|${r.error.message}|${r.error.hint ?? ""}`)}`);
  revalidatePath("/", "layout");
  redirect(withFlash(to, "Template published"));
}
