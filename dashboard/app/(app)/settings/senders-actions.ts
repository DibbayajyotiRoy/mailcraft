"use server";
// Senders card actions. The list itself is derived (GET /v1/senders); what is written is the default From
// (workspace setting) and a mailbox relay's aliases / display names (PATCH /v1/transports/{id}).
import { revalidatePath } from "next/cache";
import { api, type ApiResult } from "@/lib/api";
import { mailboxFields } from "./addresses";
import type { Result } from "./actions";

const f = (d: FormData, k: string) => String(d.get(k) ?? "").trim();
const fail = (r: ApiResult): Result => ({ error: `${r.error!.message}${r.error!.hint ? ` (${r.error!.hint})` : ""}` });

export async function setDefaultFrom(_p: Result, d: FormData): Promise<Result> {
  const r = await api("PUT", "/v1/settings", { default_from: f(d, "default_from") });
  if (r.error) return fail(r);
  revalidatePath("/", "layout");
  return { ok: f(d, "default_from") ? "Default From saved." : "Default From cleared." };
}

export async function saveAddresses(_p: Result, d: FormData): Promise<Result> {
  const r = await api("PATCH", `/v1/transports/${encodeURIComponent(f(d, "id"))}`, mailboxFields(d, f(d, "login")));
  if (r.error) return fail(r);
  revalidatePath("/", "layout");
  return { ok: "Addresses saved." };
}
