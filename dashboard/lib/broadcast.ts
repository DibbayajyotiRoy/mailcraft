// Plain helpers shared by the broadcast pages (server and client components).

/** Why a row was left out (the API's `skipped[].reason`). */
export const REASON: Record<string, string> = {
  invalid_email: "not a valid address", duplicate: "duplicate", invalid_data: "bad extra column", suppressed: "on the suppression list",
  unsubscribed: "unsubscribed", not_allowed: "not allowed for this key", missing_variable: "missing a value the template needs",
};

/** "about every 14 min" / "about every 90 s" */
export function every(s: number) {
  return s >= 90 ? `about every ${Math.round(s / 60)} min` : `about every ${Math.max(1, Math.round(s))} s`;
}

/** Per-status counts every broadcast carries, in display order. */
export const COUNTS = ["queued", "sent", "delivered", "bounced", "failed", "skipped"] as const;
