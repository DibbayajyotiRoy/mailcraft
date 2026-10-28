// What the assistant does with API errors it knows: the go-live gate (turned into a proposal, not a failure) and the short
// human label a failed step shows. Pure, no server imports: the card and the tests use it too.

type ApiErr = { code?: string; message?: string; hint?: string; rule?: string };

/** emails.rs plan(): a live key on a workspace nobody approved for live sending gets 403 blocked_by_policy (rule go_live).
 *  The JSON has no `rule` field (the rule is only in the audit log), so the message and hint are matched too. Other
 *  blocked_by_policy cases (key_domain, send policy) say neither "live sending" nor "go-live". */
// TODO: the API only says this in English (message + hint). Once it returns a machine-readable `rule` ("go_live"), match that alone; `e.rule` is already accepted.
export const isGoLive = (e?: ApiErr | null) => !!e && e.code === "blocked_by_policy" && (e.rule === "go_live" || /live sending|go-live/i.test(`${e.message} ${e.hint}`));

export const GO_LIVE_TITLE = "Request go-live approval";
export const GO_LIVE_SUMMARY = "This workspace can't send real mail until a person approves going live. Apply asks for that approval; it then appears in Approvals.";
/** The follow-up the user is offered once the request exists (task row, and the model's closing line). */
export const goLiveNext = (what: "email" | "broadcast" | undefined) => `Approve it in Approvals, then say "send it now" and I'll prepare the ${what ?? "send"} again.`;

/** Short, human, never cut mid-word: the label of a failed step. Unknown codes get none (the caller says "<step> failed"); the full message goes in the step's detail. */
const LABEL: Record<string, string> = {
  domain_not_verified: "Domain not verified", transport_missing: "Sender not ready", sender_not_ready: "Sender not ready", transport_not_found: "Sender not ready",
  kill_switch_active: "Kill switch is on", blocked_by_policy: "Blocked by a send policy", forbidden_scope: "This key lacks permission", unauthenticated: "Not signed in",
  template_render_failed: "Template does not render", template_unpublished: "Template not published", empty_audience: "Nobody would receive it", test_key_live_recipient: "Test key can't reach real people",
  rate_limited: "Rate limited", unreachable: "Can't reach the mailcraft API", not_found: "Not found",
};
export const errorLabel = (e: ApiErr) => (isGoLive(e) ? "Needs go-live approval" : e.code ? LABEL[e.code] : undefined);
