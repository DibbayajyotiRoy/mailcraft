import { z } from "zod";

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** REST path; {param} segments are filled from args (URL-encoded). */
  path: string;
  /** true = changes state; dropped by --read-only and gets idempotency_key. */
  mutating: boolean;
  destructive?: boolean;
  /** body merged over args (e.g. kill switch always {on:true}). */
  fixedBody?: Record<string, unknown>;
}

const id = (what: string) => z.string().describe(what);
const lim = { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() };
const obj = z.record(z.string(), z.unknown());
const stream = z.enum(["transactional", "marketing"]);
const fmt = z.enum(["html", "mjml", "json"]);
/** per-recipient extra columns: usable as {{ data.<column> }} */
const rowData = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const recipient = z.object({ email: z.string(), first_name: z.string().optional(), last_name: z.string().optional(), data: rowData.optional() });
const contactFields = { first_name: z.string().optional(), last_name: z.string().optional(), timezone: z.string().optional().describe("IANA name, e.g. Europe/Berlin"), properties: obj.optional() };
// a template's source: give html, mjml, or content (+format json|mjml|html)
const source = { html: z.string().optional(), mjml: z.string().optional(), content: z.unknown().optional().describe("string, or an object for format json"), format: fmt.optional() };

export const TOOLS: ToolDef[] = [
  { name: "account_status", description: "Workspace, calling key (id, name, env test/live, scopes), live_enabled, kill_switch, pending_approvals count. Call first.", input: {}, method: "GET", path: "/v1/account/status", mutating: false },
  {
    name: "email_send",
    description: "Send (queue) one email. Result status is queued or pending_approval (poll approval_get with approval_id, never decide); a blocked policy is an error with code blocked_by_policy. Test keys sandbox mail; use delivered@test.mailcraft.local. Use dry_run to render and lint without sending. Pass idempotency_key to make retries safe.",
    input: {
      from: z.string().optional(), to: z.array(z.string()).min(1).max(50), subject: z.string().optional(),
      html: z.string().optional(), text: z.string().optional(),
      template: z.object({ id: z.string(), variables: obj.optional() }).optional(),
      stream: z.enum(["transactional", "marketing"]).optional(),
      tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      reply_to: z.string().optional(), headers: z.record(z.string(), z.string()).optional(),
      scheduled_at: z.string().optional(), dry_run: z.boolean().optional(),
    },
    method: "POST", path: "/v1/emails", mutating: true,
  },
  { name: "email_get", description: "Get one email: status, from_addr, to_addr, subject, attempts, last_error, policy_decisions. Timeline is in email_events.", input: { id: id("email id (UUID)") }, method: "GET", path: "/v1/emails/{id}", mutating: false },
  { name: "email_events", description: "Event timeline of one email (type, enhanced_code, diagnostic, occurred_at).", input: { id: id("email id (UUID)") }, method: "GET", path: "/v1/emails/{id}/events", mutating: false },
  { name: "email_cancel", description: "Cancel a queued, deferred or pending_approval email.", input: { id: id("email id (UUID)") }, method: "POST", path: "/v1/emails/{id}/cancel", mutating: true },
  { name: "email_list", description: "List emails, newest first. Filters: status, stream, env, q (case-insensitive substring of to/from/subject, or an exact email id), from/to (created_at bounds: YYYY-MM-DD or RFC 3339).", input: { status: z.string().optional(), stream: stream.optional(), env: z.enum(["test", "live"]).optional(), q: z.string().optional(), from: z.string().optional(), to: z.string().optional(), ...lim }, method: "GET", path: "/v1/emails", mutating: false },
  {
    name: "broadcast_send",
    description: "Send ONE template to a list of recipients (up to 5000): each row becomes a queued email and contacts are upserted. A live key mails real people; test keys sandbox it. ALWAYS run it first with dry_run:true and read data.skipped[] (reason per dropped row: invalid_email, duplicate, invalid_data, suppressed, unsubscribed, not_allowed, missing_variable) and data.schedule (pacing under the daily cap), and check the rendering with broadcast_preview. Result status is queued or pending_approval (one approval_id for the whole broadcast: poll approval_get, never decide). Pass idempotency_key so a retry cannot send twice. Per-recipient template variables: first_name, last_name, email, data.<column>.",
    input: {
      template_id: z.string().describe("template id or alias"), from: z.string(),
      recipients: z.array(recipient).min(1).max(5000),
      subject: z.string().optional().describe("replaces the template subject; may use the same variables"),
      stream: stream.optional().describe("default marketing"),
      max_per_day: z.number().int().min(1).optional().describe("upper bound on sends per day; the lowest of this and the transport/key caps applies"),
      dry_run: z.boolean().optional(),
    },
    method: "POST", path: "/v1/broadcasts", mutating: true,
  },
  { name: "broadcast_preview", description: "Render the template for ONE recipient exactly as broadcast_send would send it (subject, html, text). Nothing is stored or sent.", input: { template_id: z.string().describe("template id or alias"), recipient, subject: z.string().optional(), stream: stream.optional() }, method: "POST", path: "/v1/broadcasts/preview", mutating: false },
  { name: "broadcast_list", description: "List broadcasts, newest first, with status (pending_approval|sending|done) and per-status counts.", input: lim, method: "GET", path: "/v1/broadcasts", mutating: false },
  { name: "broadcast_get", description: "One broadcast with counts, skipped rows and its recipients' email status, paginated by email id (next_cursor). Filter recipients with status.", input: { id: id("broadcast id (UUID)"), status: z.string().optional().describe("only recipients with this email status"), ...lim }, method: "GET", path: "/v1/broadcasts/{id}", mutating: false },
  { name: "domain_add", description: "Add a sending domain; returns the DNS records the human must publish. A domain with relay_sender set sends that mailbox address through the default relay and needs no records.", input: { domain: z.string(), stream: z.enum(["transactional", "marketing"]).optional() }, method: "POST", path: "/v1/domains", mutating: true },
  { name: "domain_check", description: "Re-check DNS for a domain (verify). Returns the domain with status not_started|pending|verified|failed, last_checked_at and per-record status; a record that is not verified has detail (why) and, when DNS returned something else, found (what it returned).", input: { domain_id: id("domain id (UUID)") }, method: "POST", path: "/v1/domains/{domain_id}/verify", mutating: false },
  { name: "template_create", description: "Create a template with a draft v1 (give html, mjml, or content + format). alias defaults to a slug of name. Publish it before sending.", input: { name: z.string(), alias: z.string().optional(), stream: stream.optional(), subject: z.string().optional(), ...source, text: z.string().optional(), variables: z.array(z.string()).optional() }, method: "POST", path: "/v1/templates", mutating: true },
  { name: "template_get", description: "Get a template by id or alias: newest version with source_format + source (the html/mjml as authored, else the block tree as JSON), subject, preheader and the canonical tree in template.", input: { id: id("template id or alias") }, method: "GET", path: "/v1/templates/{id}", mutating: false },
  { name: "template_list", description: "List templates.", input: lim, method: "GET", path: "/v1/templates", mutating: false },
  { name: "template_update", description: "Rename, change alias or stream, and/or add a new draft version (give html, mjml, or content + format; subject/preheader for html and mjml, empty preheader clears). Nothing goes live until template_publish. Changing alias breaks sends and automations that name the old one (409 template_exists when taken).", input: { id: id("template id or alias"), name: z.string().optional(), alias: z.string().optional(), stream: stream.optional(), subject: z.string().optional(), preheader: z.string().optional(), ...source, text: z.string().optional(), variables: z.array(z.string()).optional() }, method: "PATCH", path: "/v1/templates/{id}", mutating: true },
  { name: "template_publish", description: "Publish the newest template draft, or the given version, so sends use it.", input: { id: id("template id or alias"), version: z.number().int().min(1).optional() }, method: "POST", path: "/v1/templates/{id}/publish", mutating: true },
  { name: "template_preview", description: "Render a template with variables; returns subject, html, text, lint[], the variables the content reads and warnings. Renders the saved version (default newest), or unsaved html/mjml/content (+format, subject, preheader) without storing it. Undefined variable is 422 template_render_failed. Sends nothing.", input: { id: id("template id or alias"), variables: obj.optional(), version: z.number().int().min(1).optional(), ...source, subject: z.string().optional(), preheader: z.string().optional() }, method: "POST", path: "/v1/templates/{id}/preview", mutating: false },
  { name: "template_import", description: "Import a template from html, mjml or json.", input: { format: z.enum(["html", "mjml", "json"]), name: z.string(), content: z.string() }, method: "POST", path: "/v1/templates/import", mutating: true },
  { name: "template_export", description: "Export a template as html, mjml or json.", input: { id: id("template id"), format: z.enum(["html", "mjml", "json"]).optional() }, method: "GET", path: "/v1/templates/{id}/export", mutating: false },
  { name: "template_versions", description: "Version history of a template, newest first: version, source_format, created_at, published_at, published (true for the live one).", input: { id: id("template id or alias") }, method: "GET", path: "/v1/templates/{id}/versions", mutating: false },
  { name: "template_version_get", description: "One template version with its source and block tree.", input: { id: id("template id or alias"), version: z.number().int().min(1) }, method: "GET", path: "/v1/templates/{id}/versions/{version}", mutating: false },
  { name: "template_restore", description: "Copy an older version into a NEW draft; history is kept. Publish the new draft with template_publish to make it live.", input: { id: id("template id or alias"), version: z.number().int().min(1) }, method: "POST", path: "/v1/templates/{id}/versions/{version}/restore", mutating: true },
  { name: "template_discard_draft", description: "Discard unpublished changes: deletes the never-published versions newer than the published one. Cannot be undone. 409 no_draft or no_published_version when there is nothing to discard. Destructive.", input: { id: id("template id or alias") }, method: "DELETE", path: "/v1/templates/{id}/draft", mutating: true, destructive: true },
  { name: "content_lint", description: "Lint subject/html for deliverability and compliance issues. Sends nothing.", input: { subject: z.string().optional(), html: z.string().optional(), text: z.string().optional() }, method: "POST", path: "/v1/content/lint", mutating: false },
  { name: "contact_upsert", description: "Create or update a contact by email.", input: { email: z.string(), ...contactFields }, method: "PUT", path: "/v1/contacts", mutating: true },
  { name: "contact_get", description: "Get a contact by id or email.", input: { id_or_email: z.string() }, method: "GET", path: "/v1/contacts/{id_or_email}", mutating: false },
  { name: "contact_list", description: "List contacts. q is a case-insensitive substring of email, first or last name. Each item carries suppressed and suppression_reason.", input: { q: z.string().optional(), ...lim }, method: "GET", path: "/v1/contacts", mutating: false },
  { name: "contact_update", description: "Edit a contact by id or email. Omitted fields stay; an empty string clears first_name, last_name or timezone; properties merge shallowly and a null value deletes that key.", input: { id_or_email: z.string(), ...contactFields }, method: "PATCH", path: "/v1/contacts/{id_or_email}", mutating: true },
  { name: "contact_activity", description: "Recent activity of one contact (newest first, at most 25 each): events, emails, automation runs, topic opt-in state and segments.", input: { id_or_email: z.string() }, method: "GET", path: "/v1/contacts/{id_or_email}/activity", mutating: false },
  { name: "contact_import", description: "Upsert up to 5000 contacts in one call (same as contact_upsert per row). A bad row (invalid email or timezone) is skipped and listed in data.failed with its zero-based index; the rest are imported. Pass idempotency_key so a retry does not repeat it.", input: { contacts: z.array(z.object({ email: z.string(), ...contactFields })).min(1).max(5000) }, method: "POST", path: "/v1/contacts/import", mutating: true },
  { name: "contact_delete", description: "Permanently delete a contact. Destructive.", input: { id_or_email: z.string() }, method: "DELETE", path: "/v1/contacts/{id_or_email}", mutating: true, destructive: true },
  { name: "segment_create", description: "Create a segment: a rule-tree filter ({and:[..]}, {or:[..]}, {not:..} or {field, op, value}) or, with no filter, a manual list. Check a filter with segment_preview first.", input: { name: z.string(), filter: obj.optional() }, method: "POST", path: "/v1/segments", mutating: true },
  { name: "segment_list", description: "List segments with member_count (who matches right now for a filter segment).", input: {}, method: "GET", path: "/v1/segments", mutating: false },
  { name: "segment_preview", description: "Who a filter matches right now: {count, sample} (5 newest). Ops: eq neq lt lte gt gte in contains exists. Fields: email, first_name, last_name, timezone, created_at, properties.<key>, topic:<key>, event_count:<event>, days_since:<event>. Stores nothing.", input: { filter: obj }, method: "POST", path: "/v1/segments/preview", mutating: false },
  { name: "segment_update", description: "Replace a segment's name and filter (full replace; omit filter to make it a manual list). Overwrites the previous rule. 409 when another segment has the name.", input: { id: id("segment id (UUID)"), name: z.string(), filter: obj.nullable().optional() }, method: "PUT", path: "/v1/segments/{id}", mutating: true, destructive: true },
  { name: "segment_delete", description: "Delete a segment. 409 invalid_state while an automation still names it in a trigger or add_to_segment step. Destructive.", input: { id: id("segment id (UUID)") }, method: "DELETE", path: "/v1/segments/{id}", mutating: true, destructive: true },
  { name: "segment_add_members", description: "Add contacts (by email, up to 1000) to a segment.", input: { id: id("segment id (UUID)"), emails: z.array(z.string()).min(1).max(1000) }, method: "POST", path: "/v1/segments/{id}/members", mutating: true },
  { name: "event_names", description: "Event names tracked in the last 90 days with counts and last_seen_at, newest first (use them as automation triggers).", input: {}, method: "GET", path: "/v1/events/names", mutating: false },
  {
    name: "event_send",
    description: "Track an event for a contact (upserts the contact). May trigger automations. dry_run lists would_send[] without persisting.",
    input: { name: z.string(), contact: z.object({ email: z.string() }), properties: obj.optional(), contact_properties: obj.optional(), dry_run: z.boolean().optional() },
    method: "POST", path: "/v1/events", mutating: true,
  },
  { name: "automation_create", description: "Create an automation (trigger, steps, approval policy, caps). First sends need human approval per its approval setting.", input: { name: z.string(), trigger: obj, entry_rule: z.string().optional(), goal: obj.optional(), approval: z.string().optional(), caps: obj.optional(), steps: z.array(obj) }, method: "POST", path: "/v1/automations", mutating: true },
  { name: "automation_get", description: "Get an automation.", input: { id: id("automation id") }, method: "GET", path: "/v1/automations/{id}", mutating: false },
  { name: "automation_list", description: "List automations. Archived ones are hidden unless status is archived.", input: { status: z.enum(["draft", "active", "paused", "archived"]).optional(), ...lim }, method: "GET", path: "/v1/automations", mutating: false },
  { name: "automation_pause", description: "Pause an automation.", input: { id: id("automation id") }, method: "POST", path: "/v1/automations/{id}/pause", mutating: true },
  { name: "automation_resume", description: "Resume a paused automation.", input: { id: id("automation id") }, method: "POST", path: "/v1/automations/{id}/resume", mutating: true },
  { name: "automation_archive", description: "Archive a draft or paused automation (409 invalid_state otherwise). It leaves the default list and never runs; automation_unarchive brings it back.", input: { id: id("automation id") }, method: "POST", path: "/v1/automations/{id}/archive", mutating: true },
  { name: "automation_unarchive", description: "Bring an archived automation back as a draft (publish it to go live).", input: { id: id("automation id") }, method: "POST", path: "/v1/automations/{id}/unarchive", mutating: true },
  {
    name: "automation_test",
    description: "Start a REAL run of an automation for ONE contact now, whatever its status, skipping the entry rule (contact is created if new). A test key keeps every email in the sandbox; a live key sends for real once the workspace is live (kill switch, suppressions, topic opt-outs and the approval policy still apply). Poll automation_run_get with data.run_id. There is no dry run: use a test key unless a human said otherwise.",
    input: { id: id("automation id or name"), email: z.string(), first_name: z.string().optional(), properties: obj.optional().describe("properties of the simulated trigger event"), contact_properties: obj.optional() },
    method: "POST", path: "/v1/automations/{id}/test", mutating: true,
  },
  { name: "automation_run_get", description: "One automation run with its step log: state, current_step, next_wake_at, exit_reason, test and steps[{step_key, result, at}] (why an email was held, a wait timed out, the run exited).", input: { id: id("automation id or name"), run: id("run id (UUID)") }, method: "GET", path: "/v1/automations/{id}/runs/{run}", mutating: false },
  { name: "automation_simulate", description: "Simulate an automation against a sample event; nothing is sent or persisted.", input: { id: id("automation id"), event: obj.optional() }, method: "POST", path: "/v1/automations/{id}/simulate", mutating: false },
  { name: "automation_runs", description: "List runs of an automation, newest first (each has contact_email, exit_reason and test).", input: { id: id("automation id"), status: z.enum(["active", "waiting", "completed", "exited", "failed"]).optional(), ...lim }, method: "GET", path: "/v1/automations/{id}/runs", mutating: false },
  { name: "approval_list", description: "List approval items (humans decide them, you cannot).", input: { status: z.enum(["pending", "approved", "rejected", "expired"]).optional(), limit: lim.limit }, method: "GET", path: "/v1/approvals", mutating: false },
  { name: "approval_get", description: "Get an approval item (payload.preview has the subject/text/html; reason is the decider's note); poll this after a pending_approval result.", input: { id: id("approval id (UUID)") }, method: "GET", path: "/v1/approvals/{id}", mutating: false },
  { name: "settings_get_instructions", description: "Read workspace settings; `custom_instructions` is the workspace's writing guidance for LLM emails (null when unset).", input: {}, method: "GET", path: "/v1/settings", mutating: false },
  { name: "settings_set_instructions", description: "ADMIN KEY ONLY (agent keys get 403 forbidden_scope). Replace the workspace's writing instructions for LLM emails (max 2,000 chars, trimmed; empty string clears). Overwrites the previous text. Style and tone only: cannot override safety rules (no invented features, template-owned links, unsubscribe always included). Too long is 422 custom_instructions_too_long.", input: { custom_instructions: z.string().max(2000).describe("empty string clears") }, method: "PUT", path: "/v1/settings", mutating: true, destructive: true },
  { name: "kill_switch_status", description: "Whether the workspace kill switch is on (`on`) and which keys are individually paused (`paused_keys`).", input: {}, method: "GET", path: "/v1/kill-switch", mutating: false },
  { name: "kill_switch_engage", description: "Emergency stop: halt all sending, or only one key when key_id is given. Only a human (admin) can turn it off again.", input: { key_id: z.string().optional().describe("pause just this key (UUID); omit for the whole workspace") }, method: "POST", path: "/v1/kill-switch", mutating: true, fixedBody: { on: true } },
  { name: "doctor", description: "Server-side health and deliverability checks with hints.", input: {}, method: "GET", path: "/v1/doctor", mutating: false },
  { name: "audit_list", description: "Audit log of actions taken with API keys.", input: { limit: lim.limit, before: z.number().int().optional().describe("return rows with id below this (the next_cursor)") }, method: "GET", path: "/v1/audit", mutating: false },
  { name: "go_live_request", description: "Ask a human to enable live sending. Creates a go_live approval; poll approval_get. You cannot approve it.", input: { note: z.string().optional() }, method: "POST", path: "/v1/go-live-requests", mutating: true },
  { name: "policy_propose", description: "Propose a send-policy change for a key ({send: auto|needs_approval|blocked}); a human approves it.", input: { key_id: z.string().describe("key id (UUID)"), policy: z.object({ send: z.enum(["auto", "needs_approval", "blocked"]).optional() }) }, method: "POST", path: "/v1/policy/proposals", mutating: true },
  { name: "policy_get", description: "Current send policy (what is auto, needs_approval, blocked).", input: {}, method: "GET", path: "/v1/policy", mutating: false },
];

const MUTATING_EXTRA = { idempotency_key: z.string().max(256).optional().describe("Same key + same request returns the original result") };
export const inputShape = (t: ToolDef): z.ZodRawShape => (t.mutating ? { ...t.input, ...MUTATING_EXTRA } : t.input);

export function annotations(t: ToolDef) {
  return {
    readOnlyHint: !t.mutating,
    destructiveHint: !!t.destructive,
    idempotentHint: !t.mutating || t.method === "PUT" || t.method === "DELETE" || t.method === "PATCH" || !!t.fixedBody,
    openWorldHint: true,
  };
}
