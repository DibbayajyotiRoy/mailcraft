// Types shared by the assistant's server modules and the panel. No runtime imports: safe in client bundles.

export type Risk = "safe" | "sends";

/** What the panel shows for a write the model asked for. The executable part (`calls`) never leaves the server. */
export type Proposal = {
  id: string;
  kind: "template" | "automation" | "automation_state" | "broadcast" | "email" | "list" | "contacts";
  title: string;
  summary: string;
  /** "sends" = Apply can email people (still subject to approvals, go-live and the kill switch). */
  risk: Risk;
  /** Present when applying needs an extra confirmation click (live key + risk "sends"). */
  confirm?: string;
  warnings: string[];
  diff?: { label: string; before: string; after: string };
  preview?: { subject: string; html: string };
  lint?: { sev: string; msg: string }[];
  audience?: { count: number; skipped: { reason: string; n: number }[]; schedule?: string };
  items?: string[];
  expires_at: number;
};

export type ApplyResult = {
  status: "completed" | "queued" | "pending_approval" | "failed";
  label: string;
  href?: string;
  detail?: string;
  error?: { code: string; message: string; hint?: string };
};

export type Phase = "thinking" | "reading" | "writing";

export type DoneStats = { model: string; prompt: number; completion: number; rounds: number; ttft_ms: number; total_ms: number; est_input: number };

/** One line of the NDJSON stream from POST /api/assistant. */
export type ChatEvent =
  | { type: "phase"; phase: Phase; label: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" | "error"; detail?: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "error"; code: string; message: string; hint?: string }
  | { type: "done"; stats: DoneStats };

export type PageCtx = { path: string };
export type ChatMsg = { role: "user" | "assistant"; content: string; note?: string };
