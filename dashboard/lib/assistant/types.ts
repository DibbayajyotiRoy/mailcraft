// Types shared by the assistant's server modules and the panel. No runtime imports: safe in client bundles.

export type Risk = "safe" | "sends";

/** What the panel shows for a write the model asked for. The executable part (`calls`) never leaves the server. */
export type Proposal = {
  id: string;
  kind: "template" | "automation" | "automation_state" | "broadcast" | "email" | "list" | "contacts" | "go_live";
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
  /** go_live only: what the user was trying to send, kept so it can be proposed again once a person approves going live. */
  pending?: { kind: "email" | "broadcast"; what: string };
  /** go_live only: a go-live request is already waiting in Approvals, so there is nothing to apply. */
  waiting?: boolean;
  /** Template sends: every variable with the value the assistant drafted for it. `placeholder` marks a stand-in such as "[add signup link]"
   *  that a person must replace; Apply stays disabled (and the server refuses) while any is left. */
  variables?: { name: string; value: string; placeholder?: boolean }[];
  /** Same key = a newer proposal replaces the older pending one (the assistant re-proposed after "make it friendlier"). */
  key?: string;
  expires_at: number;
};

export type ApplyResult = {
  status: "completed" | "queued" | "pending_approval" | "failed";
  label: string;
  href?: string;
  /** Link text for `href` (default "Open"). */
  hrefLabel?: string;
  detail?: string;
  error?: { code: string; message: string; hint?: string };
};

export type Phase = "thinking" | "reading" | "writing";

export type DoneStats = { model: string; prompt: number; completion: number; rounds: number; ttft_ms: number; total_ms: number; est_input: number; failed?: string[] };

/** One line of the NDJSON stream from POST /api/assistant. */
export type ChatEvent =
  | { type: "phase"; phase: Phase; label: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" | "error"; detail?: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "error"; code: string; message: string; hint?: string; resetAt?: number }
  | { type: "done"; stats: DoneStats };

export type PageCtx = { path: string };
export type ChatMsg = { role: "user" | "assistant"; content: string; note?: string };
