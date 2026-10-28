// Turns the engine's per-step log (GET /v1/automations/{id}/runs/{run}) into one plain sentence per row.
import { absoluteTime } from "@/lib/format";

export type RunStepLog = { step_key: string; result: any; at: string };
export type RunDetail = {
  id: string; state: string; current_step?: string | null; next_wake_at?: string | null; started_at: string; ended_at?: string | null;
  contact_email?: string; exit_reason?: string | null; test?: boolean; steps: RunStepLog[];
};

/** A run in one of these states will not change without an outside event or a timer. */
export const SETTLED = ["completed", "exited", "failed", "waiting"];
export const FINISHED = ["completed", "exited", "failed"];

const words = (s: unknown) => String(s ?? "").replace(/_/g, " ");

/** `status` is a badge status (see components/ui/badge); `href` links to the email / approval the row produced. */
export function logLine(r: RunStepLog): { status: string; text: string; href?: string } {
  const x = r.result ?? {};
  if (x.decision === "error") return { status: "failed", text: `Error: ${x.error}${x.failed ? "" : " (will retry)"}` };
  if (x.decision === "enqueued") {
    const held = x.status === "pending_approval";
    return { status: held ? "pending_approval" : "queued", text: `${held ? "Email held for approval" : "Email queued"}: “${x.subject}”`, href: held ? "/approvals" : `/emails/${x.email_id}` };
  }
  if (x.decision === "deferred") return { status: "deferred", text: `Held by ${words(x.gate)}${x.until ? ` until ${absoluteTime(x.until)}` : ""}` };
  if (x.decision === "dropped") return { status: "skipped", text: `Email skipped: ${words(x.gate)}` };
  if (x.decision === "already_enqueued") return { status: "completed", text: "Email was already queued" };
  if (x.decision === "exit") return { status: "exited", text: `Exited: ${words(x.reason ?? x.gate)}` };
  if (typeof x.outcome === "boolean") return { status: "completed", text: `Condition was ${x.outcome ? "yes" : "no"}` };
  if (x.outcome === "timeout") return { status: "completed", text: "Timed out waiting for the event" };
  if (x.outcome === "event") return { status: "completed", text: `“${x.event}” happened` };
  if (x.waiting_for) return { status: "waiting", text: `Waiting for “${x.waiting_for}”${x.until ? ` until ${absoluteTime(x.until)}` : ""}` };
  if (x.wake_at) return { status: "waiting", text: `Waiting until ${absoluteTime(x.wake_at)}` };
  if (Array.isArray(x.updated)) return { status: "completed", text: `Updated ${x.updated.join(", ")}` };
  if (x.segment_id) return { status: "completed", text: x.added ? "Added to the segment" : "Already in the segment" };
  return { status: "completed", text: "Done" };
}

export const stepLabel = (key: string, types: Record<string, string>) =>
  key.startsWith("_") ? words(key.slice(1)) : types[key] ? `${key} · ${words(types[key])}` : key;

/** Stop polling once the run is done, or parked on a timer / event that will not fire for a while. */
export const isSettled = (d: Pick<RunDetail, "state" | "next_wake_at">, now = Date.now()) =>
  FINISHED.includes(d.state) || (!!d.next_wake_at && new Date(d.next_wake_at).getTime() > now + 3000) || d.state === "waiting";
