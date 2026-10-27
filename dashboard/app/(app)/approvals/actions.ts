"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import { withFlash } from "@/lib/flash";

/** Approve or reject one approval. Success -> flash toast; failure -> ?err= (shown by the page). */
export async function decideApproval(d: FormData) {
  const id = String(d.get("id") ?? ""), decision = String(d.get("decision") ?? "");
  const reason = String(d.get("reason") ?? "").trim().slice(0, 500);
  const r = await api("POST", `/v1/approvals/${encodeURIComponent(id)}/decide`, reason ? { decision, reason } : { decision });
  if (r.error) redirect(`/approvals?err=${encodeURIComponent(`${r.error.code}|${r.error.message}|${r.error.hint ?? ""}`)}`);
  revalidatePath("/approvals");
  redirect(withFlash("/approvals", decision === "approve" ? "Approved. The email is queued." : "Rejected. The email will not be sent."));
}
