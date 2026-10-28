// POST /api/assistant/apply {id, action: "apply" | "cancel", confirmed?}: executes (or drops) the exact stored proposal.
// The body carries only the id: what runs is what the user reviewed, held server-side and bound to their session.
import { revalidatePath } from "next/cache";
import { invalidateReads } from "@/lib/assistant/core";
import { applyProposal, cancelProposal } from "@/lib/assistant/proposals";
import { auth, json } from "@/lib/assistant/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const a = await auth();
  if (!a) return json(401, { code: "unauthenticated", message: "Sign in first." });
  let b: { id?: string; action?: string; confirmed?: boolean };
  try { b = await req.json(); } catch { return json(400, { code: "invalid_request", message: "Expected JSON." }); }
  if (typeof b.id !== "string") return json(400, { code: "invalid_request", message: "id is required." });
  if (b.action === "cancel") return json(200, { cancelled: cancelProposal(a.sid, b.id) });
  if (b.action !== "apply") return json(400, { code: "invalid_request", message: "action must be apply or cancel." });
  const result = await applyProposal(a.sid, b.id, a, b.confirmed === true);
  invalidateReads(a.sid);
  if (result.status !== "failed") revalidatePath("/", "layout");
  return json(200, { result });
}
