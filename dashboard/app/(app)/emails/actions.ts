"use server";
import { revalidatePath } from "next/cache";
import { api, type ApiError } from "@/lib/api";
import type { ContactHit, NewContact } from "@/lib/recipients";

export type SendResult = { id?: string; status?: string; approval_id?: string; error?: ApiError };

/** Single send through the existing POST /v1/emails. Returns the API error as-is (code, message, hint) so the dialog can show it. */
export async function sendEmail(body: Record<string, unknown>): Promise<SendResult> {
  const r = await api("POST", "/v1/emails", body);
  if (r.error) return { error: r.error };
  revalidatePath("/emails");
  return { id: r.data?.id ?? r.data?.recipients?.[0]?.id, status: r.data?.status, approval_id: r.data?.approval_id };
}

const hit = (c: any): ContactHit => ({
  id: c.id, email: c.email, first_name: c.first_name ?? null, last_name: c.last_name ?? null,
  suppressed: !!c.suppressed || c.status === "suppressed", suppression_reason: c.suppression_reason ?? null,
});

/** GET /v1/contacts?q=…&limit=8: suggestions for the To field. A failure just means no suggestions: a typed address still works, and the lookup at send time reports real API errors. */
export async function searchContacts(q: string): Promise<ContactHit[]> {
  const text = q.trim();
  if (!text) return [];
  const r = await api("GET", `/v1/contacts?${new URLSearchParams({ q: text, limit: "8" })}`);
  return r.error || !Array.isArray(r.data) ? [] : r.data.map(hit);
}

/** Exact lookup by email before sending. `not_found` is the answer "this is a new address", not an error. */
export async function findContact(email: string): Promise<{ contact: ContactHit | null; error?: ApiError }> {
  const r = await api("GET", `/v1/contacts/${encodeURIComponent(email.trim())}`);
  if (r.data) return { contact: hit(r.data) };
  return r.error && r.error.code !== "not_found" ? { contact: null, error: r.error } : { contact: null };
}

/** PUT /v1/contacts for an address the dialog just found to be new (the lookup above ran first, so this cannot overwrite a contact). */
export async function createContact(c: NewContact): Promise<{ error?: ApiError }> {
  const r = await api("PUT", "/v1/contacts", { email: c.email.trim(), first_name: c.first_name || undefined, last_name: c.last_name || undefined, timezone: c.timezone || undefined });
  if (r.error) return { error: r.error };
  revalidatePath("/contacts");
  return {};
}
