// Server-side proposal store. The model only ever *describes* a write; this holds the exact, frozen set of API calls
// until the signed-in user presses Apply. Bound to the session (hash of key+base), one-shot, short-lived.
import { createHash, randomBytes } from "node:crypto";
import { request } from "@/lib/api";
import { goLiveNext } from "./errors";
import type { ApplyResult, Proposal } from "./types";

export const TTL_MS = 15 * 60_000;
export type Step = { method: string; path: string; body?: unknown; label: string };
type Spec = Omit<Proposal, "id" | "expires_at"> & { calls: Step[]; link?: string; linkKind?: string };
type Stored = { sid: string; card: Proposal; calls: readonly Step[]; link?: string; linkKind?: string };

const store = ((globalThis as any).__mcProposals ??= new Map<string, Stored>()) as Map<string, Stored>;
export const sessionId = (key: string, base: string) => createHash("sha256").update(`${key}|${base}`).digest("hex").slice(0, 32);

const freeze = <T>(v: T): T => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const prune = () => { const now = Date.now(); for (const [id, s] of store) if (s.card.expires_at < now) store.delete(id); while (store.size > 300) store.delete(store.keys().next().value!); };

export function putProposal(sid: string, { calls, link, linkKind, ...card }: Spec): Proposal {
  prune();
  if (card.key) for (const [id, s] of store) if (s.sid === sid && s.card.key === card.key) store.delete(id); // a re-proposal replaces the older pending one
  const p = freeze({ ...card, id: randomBytes(16).toString("hex"), expires_at: Date.now() + TTL_MS }) as Proposal;
  store.set(p.id, { sid, card: p, calls: freeze(structuredClone(calls)), link, linkKind });
  return p;
}
const find = (sid: string, id: string) => { prune(); const s = store.get(String(id)); return s && s.sid === sid ? s : undefined; };
export const peekProposal = (sid: string, id: string) => find(sid, id);
export function cancelProposal(sid: string, id: string) { const s = find(sid, id); if (s) store.delete(s.card.id); return !!s; }

const err = (code: string, message: string, hint?: string): ApplyResult => ({ status: "failed", label: message, error: { code, message, hint } });
const sub = (v: unknown, prev: any): unknown => (typeof v === "string" ? v.replace(/\$prev\.(\w+)/g, (_, k) => String(prev?.[k] ?? "")) : Array.isArray(v) ? v.map((x) => sub(x, prev)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x, prev)])) : v);

/** Is a go-live request already waiting in Approvals? undefined when that cannot be read. The API neither de-duplicates requests nor filters approvals by kind. */
export async function goLivePending(a: { base: string; key: string }): Promise<boolean | undefined> {
  const r = await request(a.base, a.key, "GET", "/v1/approvals?status=pending&limit=200");
  return r.error || !Array.isArray(r.data) ? undefined : r.data.some((x: any) => x.kind === "go_live" && (x.status ?? "pending") === "pending");
}

/** Runs the stored calls with the user's own key, so scopes, approvals, go-live gates and the kill switch all apply. */
export async function applyProposal(sid: string, id: string, a: { base: string; key: string }, confirmed: boolean): Promise<ApplyResult> {
  const s = find(sid, id);
  if (!s) return err("proposal_expired", "This proposal expired or was already used.", "Ask the assistant to prepare it again.");
  const stuck = s.card.variables?.filter((v) => v.placeholder).map((v) => v.name) ?? [];
  if (stuck.length) return err("placeholder_values", `Replace the placeholder value${stuck.length > 1 ? "s" : ""} first: ${stuck.join(", ")}.`, "Tell the assistant what to use; it prepares the send again."); // not consumed: the card stays
  if (s.card.confirm && !confirmed) return err("confirmation_required", "This needs an explicit confirmation.", s.card.confirm);
  store.delete(s.card.id); // one-shot, even when a call fails: a retry is a new proposal
  let prev: any, status: ApplyResult["status"] = "completed";
  const run = s.card.kind === "go_live" && (await goLivePending(a)) ? [] : s.calls; // a second card for the same workspace-wide request must not file it twice
  for (const c of run) {
    const r = await request(a.base, a.key, c.method, sub(c.path, prev) as string, c.body === undefined ? undefined : sub(c.body, prev), 120_000);
    if (r.error) return { status: "failed", label: `${c.label} failed`, error: { code: r.error.code, message: r.error.message, hint: r.error.hint } };
    prev = r.data;
    if (prev?.status === "pending_approval") status = "pending_approval"; else if (prev?.status === "queued" && status === "completed") status = "queued";
  }
  const lid = prev?.id ?? prev?.template_id;
  const href = s.link ?? (s.linkKind && lid ? `/${s.linkKind}/${encodeURIComponent(lid)}` : undefined);
  if (s.card.kind === "go_live") return { status: "pending_approval", label: "Go-live approval requested", href, hrefLabel: "Open Approvals", detail: goLiveNext(s.card.pending?.kind) }; // the API answers {status: "pending"}: a person still has to decide
  const detail = status === "pending_approval" ? "Waiting for a human to approve it in Approvals." : status === "queued" ? "Queued for sending." : undefined;
  return { status, label: s.card.title, href, detail };
}
