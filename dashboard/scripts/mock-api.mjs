// Mock of the mailcraft REST API for UI work and QA, covering every route the dashboard calls (lists + detail):
//   node scripts/mock-api.mjs [port]          (default 18080)
//   EMPTY=1 node scripts/mock-api.mjs         every list is empty (empty-state screens)
//   FAIL=1  node scripts/mock-api.mjs         every route returns 503 (error-state screens)
import { createServer } from "node:http";

const ago = (m) => new Date(Date.now() - m * 6e4).toISOString();
const day = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const html = (name) => `<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif;background:#f4f4f5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:32px"><h1 style="color:#111;font-size:28px">${name}</h1><p style="color:#444">Hi {{ first_name }}, thanks for joining us.</p><a href="#" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Get started</a></div></body></html>`;

const subjects = ["Welcome aboard", "Your receipt", "Reset your password", "Trial ends soon", "New login", "Invoice 1042", "Your weekly digest", "Confirm your email"];
const statuses = ["delivered", "sent", "bounced", "queued", "deferred", "delivered", "complained", "pending_approval"];
const EMAILS = Array.from({ length: 30 }, (_, i) => ({
  id: `em_${String(i).padStart(2, "0")}`, subject: subjects[i % 8], to_addr: `user${i}@example.com`, from_addr: "Acme <hello@mail.example.com>",
  status: statuses[i % 8], stream: i % 3 ? "transactional" : "broadcast", env: "test", attempts: 1 + (i % 3), created_at: ago(i * 47 + 3),
  html: html(subjects[i % 8]), text: `Hi there,\n\n${subjects[i % 8]}.\n\nThe mailcraft team`,
  last_error: statuses[i % 8] === "bounced" ? "550 5.1.1 The email account that you tried to reach does not exist." : null,
  policy_decisions: i % 2 ? [{ rule: "send_policy", decision: "pass" }] : [{ rule: "send_policy", decision: "needs_approval", reason: "default policy for this key" }, { rule: "suppression", decision: "pass" }],
}));
const eventsFor = (e) => {
  const t0 = Date.parse(e.created_at);
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const ev = [{ type: "queued", occurred_at: at(0) }];
  if (e.status === "pending_approval") return ev;
  if (e.status === "queued") return ev;
  ev.push({ type: "sent", occurred_at: at(2) });
  if (e.status === "bounced") ev.push({ type: "bounced", occurred_at: at(5), enhanced_code: "5.1.1", diagnostic: "550 5.1.1 The email account that you tried to reach does not exist." });
  else if (e.status === "deferred") ev.push({ type: "deferred", occurred_at: at(9), enhanced_code: "4.2.2", diagnostic: "452 4.2.2 Mailbox full, try again later" });
  else if (e.status === "complained") ev.push({ type: "delivered", occurred_at: at(6) }, { type: "complained", occurred_at: at(900) });
  else if (e.status === "delivered") ev.push({ type: "delivered", occurred_at: at(6) });
  return ev;
};

const APPROVALS = [
  { id: "ap_1", kind: "email", status: "pending", requested_by: "key_9f3a77b1c2d4", created_at: ago(8), payload: { from: "hello@mail.example.com", to: "ana@example.com", preview: { subject: "Your annual plan renews tomorrow", text: "Hi Ana,\n\nYour annual plan renews tomorrow for $240.\n\nThe Acme team" } } },
  { id: "ap_2", kind: "automation_first_send", status: "pending", requested_by: null, created_at: ago(95), payload: { email_ids: ["em_1", "em_2", "em_3"], preview: { subject: "Welcome to Acme", text: "Welcome aboard, {{ first_name }}!" } } },
  { id: "ap_3", kind: "go_live", status: "pending", requested_by: "key_1c2d3e4f5a6b", created_at: ago(60 * 26), payload: { reason: "Ready to send to real customers" } },
];

const DOMAINS = [
  { id: "d1", name: "mail.example.com", status: "pending", stream: "transactional", last_checked_at: ago(4), records: [
    { record: "SPF", type: "TXT", name: "mail.example.com", value: "v=spf1 include:spf.mailcraft.dev ~all", status: "verified" },
    { record: "DKIM", type: "TXT", name: "mc._domainkey.mail.example.com", value: "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234567890abcdefMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA", status: "pending" },
    { record: "Return-path", type: "MX", name: "bounce.mail.example.com", priority: 10, value: "feedback-smtp.mailcraft.dev", status: "failed", found: "10 mail.other-host.com" },
    { record: "DMARC", type: "TXT", name: "_dmarc.mail.example.com", value: "v=DMARC1; p=none; rua=mailto:dmarc@example.com", status: "verified" }] },
  { id: "d2", name: "news.example.org", status: "verified", stream: "broadcast", last_checked_at: ago(600), records: [
    { record: "SPF", type: "TXT", name: "news.example.org", value: "v=spf1 include:spf.mailcraft.dev ~all", status: "verified" },
    { record: "DKIM", type: "TXT", name: "mc._domainkey.news.example.org", value: "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAabcdef", status: "verified" }] },
];

const KEYS = [
  { id: "k1", name: "Production sender", prefix: "mc_live_3f9a", env: "live", scopes: ["send"], created_at: ago(9000), last_used_at: ago(3) },
  { id: "k2", name: "CI", prefix: "mc_test_77ab", env: "test", scopes: ["read", "send"], created_at: ago(200), last_used_at: null },
];

const TEMPLATES = [
  { id: "t1", alias: "welcome", name: "Welcome", subject: "Welcome {{ first_name }}", status: "published", version: 3, published_version: 3, updated_at: ago(300), variables: ["first_name"] },
  { id: "t2", alias: "receipt", name: "Receipt", subject: "Your receipt", status: "published", version: 5, published_version: 4, updated_at: ago(60 * 30), variables: ["first_name", "amount"] },
  { id: "t3", alias: "winback", name: "Win-back", subject: "We miss you", status: "draft", version: 1, published_version: null, updated_at: ago(60 * 24 * 3), variables: ["first_name"] },
];
const llm = { version: 1, subject: "Welcome", blocks: [{ type: "heading", text: "Hi" }, { type: "slot", name: "intro", max_len: 240, instructions: "One warm sentence", fallback: "Thanks for signing up." }] };

const AUTOMATIONS = [
  { id: "a1", name: "welcome", status: "active", trigger: "signed_up", version: 2, entry_rule: "once", approval: "first_n:5", goal: { event: "upgraded" }, steps: [
    { key: "start", type: "trigger", config: { event: "signed_up", filter: { field: "contact.plan", op: "eq", value: "free" } }, next: "mail" },
    { key: "mail", type: "send_email", config: { template: "welcome", mode: "llm", from: "hello@example.com", instructions: "Friendly and brief.", custom_instructions: "Never mention pricing." }, next: "wait" },
    { key: "wait", type: "delay", config: { duration: "2d" }, next: "check" },
    { key: "check", type: "condition", config: { rule: { and: [{ field: "contact.plan", op: "eq", value: "free" }, { not: { field: "event_count:login", op: "gt", value: 3 } }] } }, next: { yes: "nudge", no: "end" } },
    { key: "nudge", type: "send_email", config: { template: "winback", mode: "static", subject: "Need a hand?" }, next: "tag" },
    { key: "tag", type: "update_contact", config: { set: { nudged: true } }, next: "seg" },
    { key: "seg", type: "add_to_segment", config: { segment: "nudged" }, next: "end" },
    { key: "end", type: "exit", config: { reason: "flow complete" } }] },
  { id: "a2", name: "win-back", status: "paused", trigger: "inactive_30d", version: 1, steps: [] },
  { id: "a3", name: "onboarding-tips", status: "draft", trigger: { event: "signed_up" }, version: 1, steps: [] },
];
const RUNS = [
  { id: "run_01HZXY0000000000K9QF", contact: "ana@example.com", status: "running", started_at: ago(12), current_step: "wait" },
  { id: "run_01HZXY1111111111AB12", contact: "ben@example.com", status: "completed", started_at: ago(60 * 5), finished_at: ago(60 * 5 - 3) },
  { id: "run_01HZXY2222222222CD34", contact: "cy@example.com", status: "failed", started_at: ago(60 * 30), finished_at: ago(60 * 30 - 1) },
];

const CONTACTS = [
  { id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva", timezone: "Europe/Berlin", created_at: ago(500), properties: { plan: "pro", seats: 4 }, topics: [{ name: "product", subscribed: true }, { name: "newsletter", subscribed: false }] },
  { id: "c2", email: "ben@example.com", first_name: "Ben", created_at: ago(60 * 24), properties: { plan: "free" } },
  { id: "c3", email: "bounce@example.com", status: "suppressed", suppressed: true, suppression_reason: "hard bounce", created_at: ago(60 * 24 * 9), properties: {} },
  { id: "c4", email: "cy@example.com", first_name: "Cy", last_name: "Okafor", created_at: ago(60 * 24 * 20), properties: { plan: "pro" } },
];
const SEGMENTS = [
  { id: "s1", name: "Pro customers", member_count: 1284, filter: { and: [{ field: "contact.plan", op: "eq", value: "pro" }, { field: "contact.signed_up_days", op: "lte", value: 30 }] } },
  { id: "s2", name: "Nudged", member_count: 42 },
  { id: "s3", name: "EU or UK", filter: { or: [{ field: "contact.country", op: "in", value: ["DE", "FR"] }, { field: "contact.country", op: "eq", value: "GB" }] } },
];

const status = { env: "test", name: "Acme", key_prefix: "mc_test_8f3a", scopes: ["read", "send", "manage", "admin"], kill_switch: false, pending_approvals: APPROVALS.length, verified: true };
const settings = { llm_provider: { kind: "openrouter", model: "anthropic/claude-sonnet-4", base_url: null, api_key_set: true }, delivery_path: { kind: "smtp-relay", detail: "postmark via smtp.postmarkapp.com:587" }, default_from: "Acme <hello@mail.example.com>", reply_to: "support@example.com", custom_instructions: "Be brief and friendly." };
const policy = { default: { send: "needs_approval" }, keys: [{ key_id: "k1", name: "Production sender", policy: { send: "auto" } }] };
const transports = [{ id: "tr1", kind: "smtp-relay", name: "postmark", label: "production", is_default: true, status: "active" }];

const LISTS = { "/v1/emails": EMAILS, "/v1/approvals": APPROVALS, "/v1/domains": DOMAINS, "/v1/keys": KEYS, "/v1/templates": TEMPLATES, "/v1/automations": AUTOMATIONS, "/v1/contacts": CONTACTS, "/v1/segments": SEGMENTS, "/v1/transports": transports };

const body = (res, data, extra = {}, code = 200) => { res.statusCode = code; res.end(JSON.stringify({ ok: true, data, ...extra })); };
const fail = (res, e, code) => { res.statusCode = code; res.end(JSON.stringify({ ok: false, error: e })); };
const notFound = (res, what) => fail(res, { code: "not_found", message: `No such ${what}` }, 404);

createServer((req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, q = u.searchParams; let m;
  res.setHeader("content-type", "application/json");
  if (process.env.FAIL) return fail(res, { code: "unreachable", message: "Cannot reach the database", hint: "Check the server" }, 503);
  if (req.method !== "GET") {
    if ((m = p.match(/^\/v1\/templates\/([^/]+)\/preview$/))) {
      const t = TEMPLATES.find((x) => x.id === m[1] || x.alias === m[1]);
      return body(res, { subject: t?.subject, html: html(t?.name ?? "Template"), text: "", lint: t?.id === "t1" ? [] : [{ rule: "missing-alt", severity: "warning", message: "Image has no alt text", path: "blocks[2]" }, { rule: "no-unsubscribe", severity: "error", message: "Marketing email needs an unsubscribe link", path: "footer" }] });
    }
    return body(res, p.endsWith("/test") ? { ok: false, detail: "535 authentication failed" } : {});
  }
  if (p === "/v1/kill-switch") return body(res, { on: false });
  if (p === "/v1/account/status") return body(res, process.env.EMPTY ? { ...status, pending_approvals: 0 } : status);
  if (p === "/v1/settings") return body(res, settings);
  if (p === "/v1/policy") return body(res, policy);
  if (p === "/v1/stats/overview") {
    const n = Number(q.get("days") || 14);
    const series = process.env.EMPTY ? [] : Array.from({ length: n }, (_, i) => { const sent = 700 + ((i * 137) % 9) * 60 + i * 20; return { date: day(n - 1 - i), sent, delivered: Math.round(sent * 0.985), bounced: Math.round(sent * 0.011), complained: i % 4 === 0 ? 1 : 0 }; });
    return body(res, { totals: { sent: 12408, delivered: 12301, bounced: 31, complained: 2 }, series });
  }
  if (process.env.EMPTY && LISTS[p]) return body(res, []);
  if (p === "/v1/emails") {
    let rows = EMAILS; const s = q.get("status"); if (s) rows = rows.filter((e) => e.status === s);
    const lim = Number(q.get("limit") || 25), start = Number(q.get("cursor") || 0), out = rows.slice(start, start + lim);
    return body(res, out, { next_cursor: start + lim < rows.length ? String(start + lim) : null });
  }
  if (p === "/v1/approvals") return body(res, APPROVALS);
  if (LISTS[p]) return body(res, LISTS[p]);
  if ((m = p.match(/^\/v1\/emails\/([^/]+)\/events$/))) { const e = EMAILS.find((x) => x.id === m[1]); return e ? body(res, eventsFor(e)) : notFound(res, "email"); }
  if ((m = p.match(/^\/v1\/emails\/([^/]+)$/))) { const e = EMAILS.find((x) => x.id === m[1]); return e ? body(res, e) : notFound(res, "email"); }
  if ((m = p.match(/^\/v1\/templates\/([^/]+)\/export$/))) return body(res, { content: q.get("format") === "json" ? JSON.stringify(llm, null, 2) : html("Export") });
  if ((m = p.match(/^\/v1\/templates\/([^/]+)$/))) { const t = TEMPLATES.find((x) => x.id === m[1] || x.alias === m[1]); return t ? body(res, t.alias === "welcome" ? { ...t, content: llm } : t) : notFound(res, "template"); }
  if ((m = p.match(/^\/v1\/automations\/([^/]+)\/runs$/))) return body(res, m[1] === "a1" ? RUNS : []);
  if ((m = p.match(/^\/v1\/automations\/([^/]+)$/))) { const a = AUTOMATIONS.find((x) => x.id === m[1]); return a ? body(res, a) : notFound(res, "automation"); }
  body(res, []);
}).listen(Number(process.argv[2] || 18080), () => console.log("mock api up"));
