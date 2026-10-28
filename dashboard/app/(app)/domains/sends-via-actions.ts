"use server";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";

export type Result = { ok?: string; error?: string };

/** PATCH /v1/domains/{id}: sends from this domain use that transport ("" = the workspace default). */
export async function bindTransport(_p: Result, d: FormData): Promise<Result> {
  const id = String(d.get("id") ?? ""), t = String(d.get("transport_id") ?? "");
  const r = await api("PATCH", `/v1/domains/${encodeURIComponent(id)}`, { transport_id: t || null });
  if (r.error) return { error: `${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ""}` };
  revalidatePath("/domains");
  return { ok: t ? "Saved. Sends from this domain use that transport." : "Saved. This domain uses the workspace default." };
}
