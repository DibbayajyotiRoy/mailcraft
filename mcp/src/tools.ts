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
  { name: "email_list", description: "List emails, newest first.", input: { status: z.string().optional(), ...lim }, method: "GET", path: "/v1/emails", mutating: false },
  { name: "domain_add", description: "Add a sending domain; returns the DNS records the human must publish.", input: { domain: z.string(), stream: z.enum(["transactional", "marketing"]).optional() }, method: "POST", path: "/v1/domains", mutating: true },
  { name: "domain_check", description: "Re-check DNS for a domain (verify). Returns the domain with status not_started|pending|verified|failed and per-record status.", input: { domain_id: id("domain id (UUID)") }, method: "POST", path: "/v1/domains/{domain_id}/verify", mutating: false },
  { name: "template_create", description: "Create a template.", input: { name: z.string(), subject: z.string().optional(), html: z.string().optional(), mjml: z.string().optional(), text: z.string().optional(), variables: z.array(z.string()).optional() }, method: "POST", path: "/v1/templates", mutating: true },
  { name: "template_get", description: "Get a template.", input: { id: id("template id") }, method: "GET", path: "/v1/templates/{id}", mutating: false },
  { name: "template_list", description: "List templates.", input: lim, method: "GET", path: "/v1/templates", mutating: false },
  { name: "template_update", description: "Update a template draft.", input: { id: id("template id"), name: z.string().optional(), subject: z.string().optional(), html: z.string().optional(), mjml: z.string().optional(), text: z.string().optional(), variables: z.array(z.string()).optional() }, method: "PATCH", path: "/v1/templates/{id}", mutating: true },
  { name: "template_publish", description: "Publish the current template draft.", input: { id: id("template id") }, method: "POST", path: "/v1/templates/{id}/publish", mutating: true },
  { name: "template_preview", description: "Render a template with variables; returns subject, html, text and lint[]. Sends nothing.", input: { id: id("template id"), variables: obj.optional() }, method: "POST", path: "/v1/templates/{id}/preview", mutating: false },
  { name: "template_import", description: "Import a template from html, mjml or json.", input: { format: z.enum(["html", "mjml", "json"]), name: z.string(), content: z.string() }, method: "POST", path: "/v1/templates/import", mutating: true },
  { name: "template_export", description: "Export a template as html, mjml or json.", input: { id: id("template id"), format: z.enum(["html", "mjml", "json"]).optional() }, method: "GET", path: "/v1/templates/{id}/export", mutating: false },
  { name: "content_lint", description: "Lint subject/html for deliverability and compliance issues. Sends nothing.", input: { subject: z.string().optional(), html: z.string().optional(), text: z.string().optional() }, method: "POST", path: "/v1/content/lint", mutating: false },
  { name: "contact_upsert", description: "Create or update a contact by email.", input: { email: z.string(), properties: obj.optional() }, method: "PUT", path: "/v1/contacts", mutating: true },
  { name: "contact_get", description: "Get a contact by id or email.", input: { id_or_email: z.string() }, method: "GET", path: "/v1/contacts/{id_or_email}", mutating: false },
  { name: "contact_list", description: "List contacts.", input: lim, method: "GET", path: "/v1/contacts", mutating: false },
  { name: "contact_delete", description: "Permanently delete a contact. Destructive.", input: { id_or_email: z.string() }, method: "DELETE", path: "/v1/contacts/{id_or_email}", mutating: true, destructive: true },
  {
    name: "event_send",
    description: "Track an event for a contact (upserts the contact). May trigger automations. dry_run lists would_send[] without persisting.",
    input: { name: z.string(), contact: z.object({ email: z.string() }), properties: obj.optional(), contact_properties: obj.optional(), dry_run: z.boolean().optional() },
    method: "POST", path: "/v1/events", mutating: true,
  },
  { name: "automation_create", description: "Create an automation (trigger, steps, approval policy, caps). First sends need human approval per its approval setting.", input: { name: z.string(), trigger: obj, entry_rule: z.string().optional(), goal: obj.optional(), approval: z.string().optional(), caps: obj.optional(), steps: z.array(obj) }, method: "POST", path: "/v1/automations", mutating: true },
  { name: "automation_get", description: "Get an automation.", input: { id: id("automation id") }, method: "GET", path: "/v1/automations/{id}", mutating: false },
  { name: "automation_list", description: "List automations.", input: lim, method: "GET", path: "/v1/automations", mutating: false },
  { name: "automation_pause", description: "Pause an automation.", input: { id: id("automation id") }, method: "POST", path: "/v1/automations/{id}/pause", mutating: true },
  { name: "automation_resume", description: "Resume a paused automation.", input: { id: id("automation id") }, method: "POST", path: "/v1/automations/{id}/resume", mutating: true },
  { name: "automation_simulate", description: "Simulate an automation against a sample event; nothing is sent or persisted.", input: { id: id("automation id"), event: obj.optional() }, method: "POST", path: "/v1/automations/{id}/simulate", mutating: false },
  { name: "automation_runs", description: "List runs of an automation.", input: { id: id("automation id"), status: z.string().optional(), ...lim }, method: "GET", path: "/v1/automations/{id}/runs", mutating: false },
  { name: "approval_list", description: "List approval items (humans decide them, you cannot).", input: { status: z.enum(["pending", "approved", "rejected", "expired"]).optional(), limit: lim.limit }, method: "GET", path: "/v1/approvals", mutating: false },
  { name: "approval_get", description: "Get an approval item (payload.preview has the subject/text); poll this after a pending_approval result.", input: { id: id("approval id (UUID)") }, method: "GET", path: "/v1/approvals/{id}", mutating: false },
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
