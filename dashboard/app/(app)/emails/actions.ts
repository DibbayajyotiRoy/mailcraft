"use server";
import { revalidatePath } from "next/cache";
import { api, type ApiError } from "@/lib/api";

export type SendResult = { id?: string; status?: string; approval_id?: string; error?: ApiError };

/** Single send through the existing POST /v1/emails. Returns the API error as-is (code, message, hint) so the dialog can show it. */
export async function sendEmail(body: Record<string, unknown>): Promise<SendResult> {
  const r = await api("POST", "/v1/emails", body);
  if (r.error) return { error: r.error };
  revalidatePath("/emails");
  return { id: r.data?.id ?? r.data?.recipients?.[0]?.id, status: r.data?.status, approval_id: r.data?.approval_id };
}
