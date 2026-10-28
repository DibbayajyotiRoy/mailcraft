// Mock of the mailcraft REST API for UI work and QA, covering every route the dashboard calls (lists + detail,
// contact lists, contact sources, the CSV import dry run):
//   node scripts/mock-api.mjs [port]          (default 18080)
//   EMPTY=1 node scripts/mock-api.mjs         every list is empty (empty-state screens)
//   FAIL=1  node scripts/mock-api.mjs         every route returns 503 (error-state screens)
//   NOT_LIVE=1 node scripts/mock-api.mjs      the workspace is not approved for live sending: POST /v1/emails and /v1/broadcasts
//                                             answer 403 blocked_by_policy (emails.rs rule go_live), as the real API does for a live key.
//                                             Change it at runtime with POST /__mock/go-live?live=0|1&pending=0|1 (pending = a go_live approval is waiting).
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

const MJML_SRC = `<mjml>
  <mj-head>
    <mj-title>Welcome {{ first_name }}</mj-title>
    <mj-preview>Your account is ready</mj-preview>
  </mj-head>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text font-size="22px" font-weight="bold">Hi {{ first_name }}</mj-text>
        <mj-text>Thanks for joining us.</mj-text>
        <mj-button href="https://example.com/start">Get started</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
`;
const HTML_SRC = `<!doctype html>
<html>
  <head><title>Your receipt</title></head>
  <body style="font-family: Arial, sans-serif">
    <h1>Thanks, {{ first_name }}</h1>
    <p>We received {{ amount }}.</p>
    <a href="https://example.com/receipt">View receipt</a>
  </body>
</html>
`;
const TEMPLATES = [
  { id: "t1", alias: "welcome", name: "Welcome", stream: "transactional", subject: "Welcome {{ first_name }}", preheader: "Your account is ready", status: "published", version: 3, published_version: 3, updated_at: ago(300), variables: ["first_name"], source_format: "mjml", source: MJML_SRC },
  { id: "t2", alias: "receipt", name: "Receipt", stream: "transactional", subject: "Your receipt", status: "published", version: 5, published_version: 4, updated_at: ago(60 * 30), variables: ["first_name", "amount"], source_format: "html", source: HTML_SRC },
  { id: "t3", alias: "winback", name: "Win-back", stream: "marketing", subject: "We miss you", status: "draft", version: 1, published_version: null, updated_at: ago(60 * 24 * 3), variables: ["first_name"], source_format: "json", source: JSON.stringify({ version: 1, subject: "We miss you", blocks: [{ type: "heading", text: "Come back, {{ first_name }}" }] }, null, 2) },
  { id: "t4", alias: "promo", name: "Promo", stream: "marketing", subject: "Big autumn sale, {{ first_name }}", status: "published", version: 1, published_version: 1, updated_at: ago(60 * 12), variables: ["first_name", "signup_link"], source_format: "html", source: `<!doctype html>\n<html>\n  <body>\n    <h1>Big autumn sale, {{ first_name }}</h1>\n    <img src="https://example.com/sale.png">\n    <p>Everything is 20% off this week.</p>\n    <a href="http://example.com/sale">Shop the sale</a>\n    <p><a href="{{ signup_link }}">Sign up for early access</a></p>\n  </body>\n</html>\n` },
];
const llm = { version: 1, subject: "Welcome", blocks: [{ type: "heading", text: "Hi" }, { type: "slot", name: "intro", max_len: 240, instructions: "One warm sentence", fallback: "Thanks for signing up." }] };
// Version history per template (newest first): t2 has a live v4 and an unpublished draft v5.
const VERSIONS = {
  t1: [3, 2, 1].map((v) => ({ version: v, source_format: "mjml", created_at: ago(300 + (4 - v) * 900), published_at: v === 3 ? ago(300) : v === 2 ? ago(1200) : null, published: v === 3 })),
  t2: [5, 4, 3, 2, 1].map((v) => ({ version: v, source_format: "html", created_at: ago(800 + (5 - v) * 400), published_at: v === 4 ? ago(60 * 40) : v === 3 ? ago(60 * 90) : null, published: v === 4 })),
  t3: [{ version: 1, source_format: "json", created_at: ago(60 * 24 * 3), published_at: null, published: false }],
  t4: [{ version: 1, source_format: "html", created_at: ago(60 * 12), published_at: ago(60 * 12), published: true }],
};
const findTemplate = (k) => TEMPLATES.find((x) => x.id === k || x.alias === k);

// Unsaved-content preview for the editor: substitutes sample values, lints a little, fails on the word BROKEN.
const SAMPLE = { first_name: "Ana", amount: "$12.00" };
const varsOf = (src) => [...new Set([...src.matchAll(/\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g)].map((m) => m[1]))];
function renderInline(b) {
  const src = String(b.content ?? "");
  if (src.includes("BROKEN")) return { error: { code: "template_render_failed", message: "mjml compile failed: unexpected tag near BROKEN", hint: "fix the template and preview again" }, status: 422 };
  const vars = { ...SAMPLE, ...(b.variables ?? {}) };
  const sub = (x) => x.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => String(vars[k] ?? `[${k}]`));
  const body = b.format === "json" ? "<h1>Block template</h1>" : b.format === "mjml" ? sub(src).replace(/<mj-head>[\s\S]*<\/mj-head>/, "").replace(/<mj-(text|button)[^>]*>([^<]*)<\/mj-\1>/g, "<p>$2</p>").replace(/<\/?mj-[^>]*>|<\/?mjml>/g, "") : sub(src);
  const lint = [];
  if (b.format !== "json" && !String(b.subject ?? "").trim()) lint.push({ rule: "empty_subject", severity: "error", message: "subject is empty", path: "subject" });
  if (/<img(?![^>]*alt=)/i.test(src)) lint.push({ rule: "image_missing_alt", severity: "warning", message: "1 <img> without alt", path: "blocks[0]" });
  if (/href=["']http:\/\//i.test(src)) lint.push({ rule: "insecure_link", severity: "warning", message: "link is not https", path: "blocks[0]" });
  return { data: { subject: sub(String(b.subject ?? "")), html: /<html/i.test(body) ? body : `<!doctype html><html><body style="font-family:Arial,sans-serif;padding:24px">${body}</body></html>`, text: "", lint, variables: varsOf(src + " " + String(b.subject ?? "")), warnings: [] } };
}

const stat = (entered, active, completed, exited, failed) => ({ entered, active, completed, exited, failed });
const AUTOMATIONS = [
  { id: "a1", name: "welcome", status: "active", trigger: "signed_up", trigger_event: "signed_up", current_version: 2, entry_rule: "once", approval: "first_n:5", goal: { event: "upgraded" }, caps: {}, created_at: ago(60 * 24 * 9),
    stats: { start: stat(412, 0, 412, 0, 0), mail: stat(412, 3, 396, 9, 4), wait: stat(396, 21, 375, 0, 0), check: stat(375, 0, 375, 0, 0), nudge: stat(212, 0, 205, 7, 0), tag: stat(205, 0, 205, 0, 0), seg: stat(205, 0, 205, 0, 0), end: stat(163, 0, 163, 0, 0) },
    steps: [
      { key: "start", type: "trigger", config: { event: "signed_up", filter: { field: "contact.plan", op: "eq", value: "free" } }, next: "mail" },
      { key: "mail", type: "send_email", config: { template: "welcome", mode: "llm", from: "hello@example.com", instructions: "Friendly and brief.", custom_instructions: "Never mention pricing." }, next: "wait" },
      { key: "wait", type: "delay", config: { duration: "2d" }, next: "check" },
      { key: "check", type: "condition", config: { rule: { and: [{ field: "contact.plan", op: "eq", value: "free" }, { field: "event_count:login", op: "lte", value: 3 }] } }, next: { true: "nudge", false: "end" } },
      { key: "nudge", type: "send_email", config: { template: "winback", mode: "static", subject: "Need a hand?" }, next: "tag" },
      { key: "tag", type: "update_contact", config: { set: { nudged: true } }, next: "seg" },
      { key: "seg", type: "add_to_segment", config: { segment: "nudged" }, next: "end" },
      { key: "end", type: "exit", config: { reason: "flow complete" } }] },
  { id: "a2", name: "win-back", status: "paused", trigger: "logged_in", trigger_event: "logged_in", current_version: 3, entry_rule: "always", approval: "never", created_at: ago(60 * 24 * 20), stats: {}, steps: [
      { key: "trigger", type: "trigger", config: { event: "logged_in" }, next: "quiet" },
      { key: "quiet", type: "wait_for_event", config: { event: "logged_in", timeout: "14d" }, next: { timeout: "miss" } },
      { key: "miss", type: "send_email", config: { template: "winback", mode: "static", stream: "marketing" } }] },
  // Branches, a wait with both outcomes, a merge, a long edge and a failing step: the showcase for the Flow view.
  { id: "a5", name: "trial-conversion", status: "active", trigger: { segment: "trial" }, trigger_event: "", current_version: 4, entry_rule: "once", approval: "first_n:5", created_at: ago(60 * 24 * 14),
    stats: { go: stat(240, 0, 240, 0, 0), hello: stat(240, 6, 228, 0, 6), hold: stat(228, 41, 150, 37, 0), won: stat(37, 0, 37, 0, 0), chk: stat(150, 0, 150, 0, 0), tips: stat(88, 2, 84, 0, 2), offer: stat(62, 0, 55, 0, 7), pause: stat(55, 9, 46, 0, 0), tag: stat(130, 0, 130, 0, 0), pool: stat(130, 0, 130, 0, 0), bye: stat(130, 0, 130, 0, 0) },
    steps: [
      { key: "go", type: "trigger", config: { segment: "trial", filter: { field: "contact.plan", op: "eq", value: "trial" } }, next: "hello" },
      { key: "hello", type: "send_email", config: { template: "trial-welcome", mode: "llm", from: "sales@example.com", custom_instructions: "Mention their workspace name." }, next: "hold" },
      { key: "hold", type: "wait_for_event", config: { event: "upgraded", timeout: "7d" }, next: { event: "won", timeout: "chk" } },
      { key: "won", type: "exit", config: { reason: "converted" } },
      { key: "chk", type: "condition", config: { rule: { and: [{ field: "event_count:feature_used", op: "gte", value: 3 }, { field: "contact.plan", op: "eq", value: "trial" }] } }, next: { true: "tips", false: "offer" } },
      { key: "tips", type: "send_email", config: { template: "trial-tips", mode: "static" }, next: "tag" },
      { key: "offer", type: "send_email", config: { template: "trial-offer", mode: "llm" }, next: "pause" },
      { key: "pause", type: "delay", config: { duration: "1d" }, next: "tag" },
      { key: "tag", type: "update_contact", config: { set: { trial_stage: "ending", nudged: true } }, next: "pool" },
      { key: "pool", type: "add_to_segment", config: { segment: "trial-ending" }, next: "bye" },
      { key: "bye", type: "exit", config: {} }] },
  { id: "a3", name: "onboarding-tips", status: "draft", trigger: { event: "signed_up" }, trigger_event: "signed_up", current_version: 1, entry_rule: "once", approval: "first_n:5", created_at: ago(60 * 5), stats: {}, steps: [] },
  { id: "a4", name: "old-promo", status: "archived", trigger: "promo_viewed", trigger_event: "promo_viewed", current_version: 1, entry_rule: "once", approval: "first_n:5", created_at: ago(60 * 24 * 90), stats: {}, steps: [
      { key: "trigger", type: "trigger", config: { event: "promo_viewed" } }] },
];
const listRow = ({ steps, stats, trigger, ...a }) => a;
const RUNS = [
  { id: "run_01HZXY0000000000K9QF", contact_id: "c1", contact_email: "ana@example.com", state: "waiting", started_at: ago(12), current_step: "wait", next_wake_at: ago(-60 * 36), version: 2, test: false, exit_reason: null },
  { id: "run_01HZXY1111111111AB12", contact_id: "c2", contact_email: "ben@example.com", state: "completed", started_at: ago(60 * 5), ended_at: ago(60 * 5 - 3), version: 2, test: false, exit_reason: null },
  { id: "run_01HZXY2222222222CD34", contact_id: "c4", contact_email: "cy@example.com", state: "failed", started_at: ago(60 * 30), ended_at: ago(60 * 30 - 1), version: 1, test: true, exit_reason: null },
  { id: "run_01HZXY3333333333EF56", contact_id: "c1", contact_email: "ana@example.com", state: "exited", started_at: ago(60 * 40), ended_at: ago(60 * 38), version: 1, test: false, exit_reason: "goal" },
];
const runDetail = (r) => ({ ...r, steps: [
  { step_key: "start", result: {}, at: r.started_at },
  { step_key: "mail", result: { decision: "enqueued", email_id: "em_01", status: "queued", subject: "Welcome aboard" }, at: ago(11) },
  ...(r.state === "failed" ? [{ step_key: "wait", result: { decision: "error", error: "step `wait`: `x` is not a duration (use 5m, 2d, ...)", attempt: 1, failed: true }, at: ago(10) }]
    : [{ step_key: "wait", result: { wake_at: ago(-60 * 36) }, at: ago(11) }]),
] });
const EVENT_NAMES = [{ name: "signed_up", count: 1204, last_seen_at: ago(4) }, { name: "logged_in", count: 9841, last_seen_at: ago(1) }, { name: "upgraded", count: 88, last_seen_at: ago(300) }, { name: "invoice_paid", count: 310, last_seen_at: ago(900) }];

// Contact lists are manual segments that also know where they came from (origin). Nudged shares its id with the manual segment of the same name.
const L = (id, name, origin, member_count, o = {}) => ({ id, name, description: null, origin, source_id: null, detached: false, member_count, created_at: ago(60 * 24 * 10), ...o });
const CONTACT_LISTS = [
  L("l1", "Acme app users", "source", 1284, { source_id: "src1", created_at: ago(60 * 24 * 21) }),
  L("l2", "Billing system", "source", 312, { source_id: "src2", created_at: ago(60 * 24 * 12) }),
  L("l3", "Marketing site signups", "source", 0, { source_id: "src3", created_at: ago(60 * 3) }),
  L("l4", "Webinar Oct 2026", "import", 87, { description: "Imported from webinar-oct-2026.csv", created_at: ago(60 * 24 * 2) }),
  L("l5", "Beta testers", "manual", 23, { description: "People who asked for early access.", created_at: ago(60 * 24 * 30) }),
  L("s2", "Nudged", "manual", 42, { created_at: ago(60 * 24 * 8) }),
  L("l7", "Old CRM", "source", 156, { detached: true, created_at: ago(60 * 24 * 120) }),
];
const sortLists = () => CONTACT_LISTS.sort((a, b) => a.name.localeCompare(b.name));
sortLists();
const listBy = (k) => CONTACT_LISTS.find((l) => l.id === k || l.name === k);
const ref = ({ id, name, origin }) => ({ id, name, origin });
const refs = (...ks) => ks.map((k) => ref(listBy(k)));
let nextList = 10, nextContact = 10;

const CONTACTS = [
  { id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva", timezone: "Europe/Berlin", created_at: ago(500), properties: { plan: "pro", seats: 4, beta: true, tags: ["vip", "eu"] }, suppressed: false, suppression_reason: null, lists: refs("l1", "l5", "s2", "l4") },
  { id: "c2", email: "ben@example.com", first_name: "Ben", created_at: ago(60 * 24), properties: { plan: "free" }, suppressed: false, suppression_reason: null, lists: refs("l1", "l4") },
  { id: "c3", email: "bounce@example.com", suppressed: true, suppression_reason: "hard_bounce", created_at: ago(60 * 24 * 9), properties: {}, lists: refs("l4") },
  { id: "c4", email: "cy@example.com", first_name: "Cy", last_name: "Okafor", created_at: ago(60 * 24 * 20), properties: { plan: "pro" }, suppressed: false, suppression_reason: null, lists: refs("l1", "s2") },
];
const ACTIVITY = {
  events: [
    { id: "ev1", name: "upgraded", properties: { plan: "pro", seats: 4 }, received_at: ago(480) },
    { id: "ev2", name: "login", properties: {}, received_at: ago(60 * 26) },
    { id: "ev3", name: "signed_up", properties: { source: "landing", utm_campaign: "autumn-launch-with-a-long-name" }, received_at: ago(60 * 24 * 3) },
  ],
  emails: [
    { id: "em_00", subject: "Welcome aboard", status: "delivered", stream: "transactional", source: "automation", created_at: ago(60 * 24 * 3) },
    { id: "em_01", subject: "Your receipt", status: "bounced", stream: "transactional", source: "api", created_at: ago(60 * 30) },
  ],
  runs: [{ id: "run_1", automation_id: "a1", automation: "welcome", state: "completed", current_step: "end", started_at: ago(60 * 24 * 3), ended_at: ago(60 * 24 * 3 - 5) }],
  topics: [{ key: "digest", name: "Digest", opted_in: false }],
  segments: [{ id: "s1", name: "Pro customers" }],
};
const NO_ACTIVITY = { events: [], emails: [], runs: [], topics: [], segments: [] };
const SEGMENTS = [
  { id: "s1", name: "Pro customers", member_count: 1284, filter: { and: [{ field: "properties.plan", op: "eq", value: "pro" }, { field: "days_since:login", op: "lte", value: 30 }] } },
  { id: "s2", name: "Nudged", member_count: 42 },
  { id: "s3", name: "EU or UK", member_count: 310, filter: { or: [{ field: "properties.country", op: "in", value: ["DE", "FR"] }, { field: "properties.country", op: "eq", value: "GB" }] } },
];

// Contact sources: one that works, one whose last sync failed (and is paused), one that never ran. `list_id` ties a source to its list.
const SOURCES = [
  { id: "src1", name: "Acme app", url: "http://acme-api.internal:8080/internal/contacts", enabled: true, interval_minutes: 15, full_sync_hours: 24, last_full_at: ago(60 * 5), watermark: ago(6), last_run_at: ago(6), last_status: "ok", last_error: null,
    last_counts: { created: 12, updated: 48, skipped: 2, deleted: 1, fetched: 63, reasons: { invalid_email: 2 } }, created_at: ago(60 * 24 * 21), list_id: "l1" },
  { id: "src2", name: "Billing system", url: "https://billing.example.com/api/customers", enabled: false, interval_minutes: 60, full_sync_hours: 0, last_full_at: null, watermark: null, last_run_at: ago(35), last_status: "error",
    last_error: "The source answered 401 Unauthorized: it rejected the API key. Rotate the key in Edit, then press Sync now.", last_counts: null, created_at: ago(60 * 24 * 12), list_id: "l2" },
  { id: "src3", name: "Marketing site", url: "https://www.example.com/api/subscribers", enabled: true, interval_minutes: 1440, full_sync_hours: 24, last_full_at: null, watermark: null, last_run_at: null, last_status: null, last_error: null,
    last_counts: null, created_at: ago(60 * 3), list_id: "l3" },
];
const sourceOut = ({ list_id, ...x }) => { const l = list_id && listBy(list_id); return { ...x, list: l ? { id: l.id, name: l.name } : null }; };
const findSource = (k) => SOURCES.find((x) => x.id === k);
const taken = (name, except) => [...CONTACT_LISTS, ...SEGMENTS].some((x) => x.id !== except && x.name.toLowerCase() === name.toLowerCase());
const tzOk = (t) => { try { new Intl.DateTimeFormat("en", { timeZone: t }); return true; } catch { return false; } };

// What the next sync would do, first page only (rows shaped like POST /v1/contact-sources/{id}/sync?dry_run=true).
const newRow = (index, email, external_id, first_name, last_name, timezone, properties) => ({ index, email, external_id, status: "new", changes: [], list: "add", values: { first_name, last_name, timezone, properties } });
const PREVIEW_ROWS = {
  src1: [
    newRow(0, "nia@example.com", "u_1041", "Nia", "Okoro", "Africa/Lagos", { plan: "pro", seats: 3 }),
    { index: 1, email: "ana@example.com", external_id: "u_0007", status: "update", changes: [{ field: "properties.plan", old: "pro", new: "team" }, { field: "properties.seats", old: 4, new: 12 }], list: "already", values: null },
    { index: 2, email: "ben@example.com", external_id: "u_0012", status: "update", changes: [{ field: "last_name", old: null, new: "Adeyemi" }, { field: "timezone", old: null, new: "Europe/London" }], list: "already", values: null },
    { index: 3, email: "cy@example.com", external_id: "u_0031", status: "unchanged", changes: [], list: "already", values: null },
    newRow(4, "dee@example.com", "u_1042", "Dee", null, null, { plan: "free" }),
    { index: 5, email: "gone@example.com", external_id: "u_0099", status: "update", changes: [{ field: "suppressed", old: false, new: "deleted_at_source" }], list: null, values: null },
    { index: 6, email: "ana.silva@example.com", external_id: "u_0008", status: "skipped", reason: "duplicate_email" },
    { index: 7, email: "", external_id: "u_0100", status: "skipped", reason: "malformed" },
  ],
  src3: [
    newRow(0, "kai@example.com", "s_1", "Kai", "Lindqvist", "Europe/Stockholm", {}), newRow(1, "lou@example.com", "s_2", "Lou", null, null, { source: "footer" }),
    newRow(2, "mia@example.com", "s_3", null, null, null, {}), newRow(3, "noor@example.com", "s_4", "Noor", "Haddad", "Asia/Dubai", { source: "blog" }),
  ],
};
const summarize = (rows) => rows.reduce((a, r) => ({ ...a, [r.status]: a[r.status] + 1 }), { new: 0, update: 0, unchanged: 0, skipped: 0 });
const syncCounts = { created: 3, updated: 7, skipped: 1, deleted: 0, fetched: 11, reasons: { invalid_email: 1 } };

// POST /v1/contacts/import {dry_run}: what each row would do, mirroring the server (diff of names, time zone and attributes; list membership).
const changesOf = (c, n) => {
  const out = [];
  for (const f of ["first_name", "last_name", "timezone"]) if (n[f] != null && n[f] !== "" && (c[f] ?? null) !== n[f]) out.push({ field: f, old: c[f] ?? null, new: n[f] });
  for (const [k, v] of Object.entries(n.properties ?? {})) if (JSON.stringify(c.properties?.[k]) !== JSON.stringify(v)) out.push({ field: `properties.${k}`, old: c.properties?.[k] ?? null, new: v });
  return out;
};
function importPlan(b) {
  let target = null;
  if (b.list_id) { const l = listBy(b.list_id); if (!l) return { error: { code: "not_found", message: "list not found", field: "list_id" }, status: 404 }; target = { id: l.id, name: l.name, exists: true }; }
  else if (b.list_name) { const l = CONTACT_LISTS.find((x) => x.name.toLowerCase() === String(b.list_name).trim().toLowerCase()); target = { id: l?.id ?? null, name: l?.name ?? String(b.list_name).trim(), exists: !!l }; }
  const summary = { new: 0, update: 0, unchanged: 0, skipped: 0, list_adds: 0 };
  const rows = (b.contacts ?? []).map((c, index) => {
    const email = String(c.email ?? "").trim().toLowerCase();
    const skip = (reason, message) => { summary.skipped++; return { index, email, status: "skipped", reason, message }; };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || /^bad@/.test(email)) return skip("invalid_email", `\`${email}\` is not a valid email address`);
    if (c.properties != null && (typeof c.properties !== "object" || Array.isArray(c.properties))) return skip("invalid_properties", "properties must be a JSON object");
    if (c.timezone && !tzOk(c.timezone)) return skip("invalid_timezone", `\`${c.timezone}\` is not an IANA timezone (e.g. Europe/Berlin)`);
    const have = CONTACTS.find((x) => x.email === email), changes = have ? changesOf(have, c) : [];
    const status = !have ? "new" : changes.length ? "update" : "unchanged";
    summary[status]++;
    const list = target ? (have?.lists?.some((x) => x.id === target.id) ? "already" : "add") : null;
    if (list === "add") summary.list_adds++;
    return { index, email, status, changes, list, values: status === "new" ? { first_name: c.first_name ?? null, last_name: c.last_name ?? null, timezone: c.timezone ?? null, properties: c.properties ?? null } : null };
  });
  return { target, summary, rows };
}


const status = { env: "test", live_enabled: false, name: "Acme", key_prefix: "mc_test_8f3a", scopes: ["read", "send", "manage", "admin"], kill_switch: false, pending_approvals: APPROVALS.length, verified: true };
const settings = { llm_provider: { kind: "openrouter", model: "nvidia/nemotron-3.5-super-vl:free", base_url: null, api_key_set: true }, delivery_path: { kind: "smtp-relay", detail: "postmark via smtp.postmarkapp.com:587" }, default_from: "Acme <hello@mail.example.com>", reply_to: "support@example.com", custom_instructions: "Be brief and friendly." };
const policy = { default: { send: "needs_approval" }, keys: [{ key_id: "k1", name: "Production sender", policy: { send: "auto" } }] };
const transports = [{ id: "tr1", kind: "smtp-relay", name: "postmark", label: "production", is_default: true, status: "active" }];

// Mailbox relays (login + "send as" aliases, each with a display name) are what GET /v1/senders is derived from.
const MAILBOXES = [
  { id: "tr2", login: "dev@example.com", names: { "dev@example.com": "Acme Developers", "partner@example.com": "Acme Partnerships" }, aliases: ["partner@example.com", "support@example.com"] },
  { id: "tr3", login: "hello@other.test", names: {}, aliases: [] },
];
for (const mb of MAILBOXES) transports.push({ id: mb.id, kind: "smtp-relay", name: mb.login, label: "production", is_default: false, status: "active" });
DOMAINS.push({ id: "d3", name: "example.com", status: "not_started", stream: "transactional", last_checked_at: null, records: [{ record: "SPF", type: "TXT", name: "example.com", value: "v=spf1 include:spf.mailcraft.dev ~all", status: "not_started" }] });
const relayAddrs = (name) => MAILBOXES.flatMap((mb) => [mb.login, ...mb.aliases]).filter((a) => a.endsWith("@" + name));
const withRelay = () => DOMAINS.forEach((d) => { const a = relayAddrs(d.name); if (a.length) { d.relay_sender = a[0]; d.relay_senders = a; } });
withRelay();
const sendersList = () => {
  const via = (id) => transports.find((t) => t.id === id)?.name ?? null;
  const rows = MAILBOXES.flatMap((mb) => [mb.login, ...mb.aliases].map((address, i) => ({ address, display_name: mb.names[address] ?? null, kind: i ? "alias" : "login", transport_id: mb.id, transport: via(mb.id), status: "ready" })));
  const def = /<([^>]+)>/.exec(settings.default_from ?? "")?.[1] ?? settings.default_from;
  if (def && !rows.some((r) => r.address === def)) rows.push({ address: def, display_name: null, kind: "domain", transport_id: "tr1", transport: via("tr1"), status: "ready" });
  return rows.map((r) => ({ ...r, is_default: r.address === def }));
};

const NOW = Date.now();
const BROADCASTS = [
  { id: "b1", template_id: "t1", template_name: "Welcome", from: "Dev <dev@example.com>", subject: "Spring launch, {{ first_name }}", stream: "marketing", env: "live", status: "sending", total: 120, created_at: ago(95),
    counts: { queued: 84, sent: 20, delivered: 12, bounced: 1, failed: 0, skipped: 5 }, first_at: ago(94), last_at: new Date(NOW + 84 * 1728e3).toISOString() },
  { id: "b2", template_id: "t2", template_name: "Receipt", from: "Dev <dev@example.com>", subject: "", stream: "marketing", env: "live", status: "done", total: 8, created_at: ago(60 * 30),
    counts: { queued: 0, sent: 1, delivered: 6, bounced: 1, failed: 0, skipped: 0 }, first_at: null, last_at: null },
  { id: "b3", template_id: "t1", template_name: "Welcome", from: "Dev <dev@example.com>", subject: "Pilot customers", stream: "marketing", env: "live", status: "pending_approval", total: 40, created_at: ago(5),
    counts: { queued: 40, sent: 0, delivered: 0, bounced: 0, failed: 0, skipped: 2 }, first_at: ago(-1), last_at: ago(-60) },
];
const RECIPIENT_STATUS = ["queued", "queued", "sent", "delivered", "delivered", "bounced", "queued", "delivered"];
const broadcastDetail = (b, status) => {
  const all = Array.from({ length: 40 }, (_, i) => ({ id: `em_${String(i).padStart(2, "0")}`, email: `user${i}@example.com`, status: RECIPIENT_STATUS[i % 8], last_error: RECIPIENT_STATUS[i % 8] === "bounced" ? "550 5.1.1 mailbox does not exist" : null, scheduled_at: ago(-i * 29), sent_at: ["sent", "delivered", "bounced"].includes(RECIPIENT_STATUS[i % 8]) ? ago(100 - i) : null }));
  const rows = status ? all.filter((r) => r.status === status) : all;
  return { ...b, recipients: rows.slice(0, 25), next_cursor: rows.length > 25 ? rows[24].id : null,
    skipped: [{ email: "old@example.com", reason: "suppressed", detail: null }, { email: "bob@x", reason: "invalid_email", detail: null }, { email: "cy@example.com", reason: "missing_variable", detail: "needs a value for data.company" }] };
};

const LISTS = { "/v1/broadcasts": BROADCASTS, "/v1/emails": EMAILS, "/v1/approvals": APPROVALS, "/v1/domains": DOMAINS, "/v1/keys": KEYS, "/v1/templates": TEMPLATES, "/v1/contacts": CONTACTS, "/v1/segments": SEGMENTS, "/v1/transports": transports };

const body = (res, data, extra = {}, code = 200) => { res.statusCode = code; res.end(JSON.stringify({ ok: true, data, ...extra })); };
const fail = (res, e, code) => { res.statusCode = code; res.end(JSON.stringify({ ok: false, error: e })); };
const notFound = (res, what) => fail(res, { code: "not_found", message: `No such ${what}` }, 404);

// ---- Go-live gate (emails.rs plan()) --------------------------------------------------------------------------------------
let notLive = !!process.env.NOT_LIVE;
if (notLive) APPROVALS.splice(APPROVALS.findIndex((x) => x.id === "ap_3"), 1); // start with no go-live request waiting
const goLiveApproval = (note) => ({ id: `ap_gl${Date.now().toString(36)}`, kind: "go_live", status: "pending", requested_by: "key_1c2d3e4f5a6b", created_at: ago(0), payload: { note: note ?? null } });
const goLiveBlock = (res) => fail(res, { code: "blocked_by_policy", message: "this workspace is not approved for live sending", hint: "request go-live (POST /v1/go-live-requests); a human approves it. Use a mc_test_ key meanwhile", retryable: false }, 403);

const readBody = async (req) => { let t = ""; for await (const c of req) t += c; try { return t ? JSON.parse(t) : {}; } catch { return {}; } };


// ---- Mock OpenRouter (offline QA/e2e): MAILCRAFT_ASSISTANT_BASE_URL=http://127.0.0.1:PORT/openrouter/api/v1 ----------------
const ORMODELS = ["nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-31b-it:free", "nvidia/nemotron-3.5-super-vl:free"].map((id) => ({ id, hugging_face_id: "org/" + id.split("/")[1], pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "temperature", "max_tokens"] }))
  .concat([{ id: "paid/closed-model", hugging_face_id: "", pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"] }]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`;
/** A scripted "model": decides from the conversation so far, streams text word by word or one tool call. */
function scripted(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const after = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "tool");
  const sys = messages[0]?.content ?? "";
  const call = (name, args) => ({ tool: { name, args } });
  if (/promo template|signup_link/i.test(lastUser)) { // a template send: the assistant drafts every variable itself and marks the one it must not invent
    const fixed = /change signup_link to/i.test(lastUser);
    if (!after.length) return call("propose_email", { to: ["ana@example.com"], from: "Acme <hello@mail.example.com>", template: { id: "promo", variables: { first_name: "Ana", signup_link: fixed ? "https://example.com/start" : "[add signup link]" } } });
    return { text: fixed ? "Updated: the signup link is now https://example.com/start. Review it and press Apply." : "I drafted the promo email for Ana. I can't invent a signup URL, so I left a placeholder: tell me which link to use.\nNEXT: Change signup_link to https://example.com/start" };
  }
  if (/bipul|go.?live|send it now/i.test(lastUser)) { // a single email: a normal proposal when the workspace is live, the go-live request when it is not
    if (!after.length) return call("propose_email", { to: ["bipul@example.com"], from: "partner@example.com", subject: "Hello from Acme", text: "Hi Bipul,\n\nHere is the note we talked about.\n\nAcme" });
    if (after.some((m) => /go_live_request_already_pending/.test(m.content))) return { text: "A go-live request is already waiting for approval in Approvals, so there is nothing to apply. Approve it there, then say \"send it now\" and I'll prepare the email again.\nNEXT: Send it now" };
    return after.some((m) => /go_live/.test(m.content))
      ? { text: "This workspace can't send real mail until a person approves going live. Apply asks for that approval. Approve it in Approvals, then say \"send it now\" and I'll prepare the email again.\nNEXT: Send it now" }
      : { text: "The email to bipul@example.com is ready. Press Apply to send it." };
  }
  if (/fix|lint/i.test(lastUser) && /promo|template/i.test(lastUser + sys)) {
    if (!after.length && !/Current page \(template/.test(sys)) return call("get", { kind: "template", id: "t4", source: true });
    if (after.length < 2 && !after.some((m) => /proposal_shown/.test(m.content)))
      return call("propose_template", { id: "t4", subject: "Our autumn sale, {{ first_name | default('there') }}", edits: [{ find: '<img src="https://example.com/sale.png">', replace: '<img src="https://example.com/sale.png" alt="Autumn sale banner">' }, { find: "http://example.com/sale", replace: "https://example.com/sale" }] });
    return { text: "I fixed the three issues: a subject line, alt text on the banner and an https link. Review the draft and press Apply to save it as a new version. It stays unpublished until you publish it.\nNEXT: Send this to my webinar list | Check the unsubscribe footer" };
  }
  if (/welcome|automation/i.test(lastUser)) {
    if (!after.length) return call("list", { kind: "template" });
    if (after.length === 1) return call("propose_automation", { definition: { name: "welcome-signups", trigger: "signed_up", entry_rule: "once", steps: [{ key: "wait", type: "delay", config: { duration: "5m" }, next: "mail" }, { key: "mail", type: "send_email", config: { template: "welcome", from: "hello@mail.example.com", mode: "static" } }] } });
    return { text: "I drafted a welcome automation: when someone signs up it waits five minutes, then sends the Welcome template. It is saved as a draft and won't send anything until you activate it.\nNEXT: Activate it | Add a reminder after 2 days" };
  }
  if (/broadcast|send .* to|webinar/i.test(lastUser)) {
    if (!after.length) return call("propose_broadcast", { template: "welcome", from: "Acme <hello@mail.example.com>", emails: ["ana@example.com", "ben@example.com"] });
    return { text: "The broadcast preview is ready: two recipients, rendered for the first one. Press Apply to queue it." };
  }
  return { text: "I can set up automations and broadcasts, fix templates, manage contacts and lists, and explain why an email bounced. What would you like to do?\nNEXT: Set up a welcome email | Fix a template | Why did an email bounce?" };
}
async function openrouter(req, res, p, input) {
  res.setHeader("content-type", "application/json");
  if (p.endsWith("/models")) return body(res, ORMODELS), true;
  if (p.endsWith("/key")) return body(res, { label: "sk-or-v1-mock…key", usage: 0, limit: null, limit_remaining: null, is_free_tier: true }), true;
  if (!p.endsWith("/chat/completions")) return false;
  const step = scripted(input.messages ?? []);
  res.setHeader("content-type", "text/event-stream");
  await sleep(150);
  if (step.tool) res.write(chunk({ tool_calls: [{ index: 0, id: "call_" + Date.now(), function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }));
  else for (const w of step.text.split(/(?<= )/)) { res.write(chunk({ content: w })); await sleep(25); }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 900, completion_tokens: 60 } })}\n\n`);
  res.end("data: [DONE]\n\n");
  return true;
}

createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, q = u.searchParams; let m;
  const input = req.method === "GET" ? {} : await readBody(req), b = input; // `input` and `b` are the same parsed JSON body
  if (p.startsWith("/openrouter/") && (await openrouter(req, res, p, input))) return;
  res.setHeader("content-type", "application/json");
  if (p === "/__mock/go-live") { // QA scene control, not an API route
    if (q.has("live")) notLive = q.get("live") === "0";
    if (q.has("pending")) { for (let i = APPROVALS.length; i--;) if (APPROVALS[i].kind === "go_live") APPROVALS.splice(i, 1); if (q.get("pending") === "1") APPROVALS.unshift(goLiveApproval("Ready to send to real customers")); }
    return body(res, { not_live: notLive, go_live_pending: APPROVALS.filter((x) => x.kind === "go_live").length });
  }
  if (process.env.FAIL) return fail(res, { code: "unreachable", message: "Cannot reach the database", hint: "Check the server" }, 503);
  if (req.method !== "GET") {
    if (p === "/v1/go-live-requests") { const a = goLiveApproval(input.note); APPROVALS.unshift(a); return body(res, { approval_id: a.id, status: "pending" }, {}, 202); }
    if (notLive && (p === "/v1/emails" || p === "/v1/broadcasts")) return goLiveBlock(res);
    if (p === "/v1/contacts/import" || p === "/v1/segments/preview") {
      if (p === "/v1/segments/preview") return body(res, { count: 12, sample: CONTACTS.slice(0, 3).map(({ email, first_name, last_name }) => ({ email, first_name, last_name })) });
      if (input.list_id && input.list_name) return fail(res, { code: "invalid_request", message: "give list_id or list_name, not both" }, 400);
      const plan = importPlan(input);
      if (plan.error) return fail(res, plan.error, plan.status);
      if (input.dry_run) return body(res, { dry_run: true, summary: plan.summary, list: plan.target, rows: plan.rows });
      const rows = input.contacts ?? [];
      return body(res, { imported: rows.filter((r) => !/^bad@/.test(r.email)).length, failed: rows.flatMap((r, index) => (/^bad@/.test(r.email) ? [{ index, email: r.email, error: { code: "invalid_request", message: "Rejected by the mock" } }] : [])), list_id: plan.target ? plan.target.id ?? "l_import" : null });
    }
    if (p === "/v1/lists" && req.method === "POST") {
      const name = String(b.name ?? "").trim();
      if (!name) return fail(res, { code: "invalid_request", message: "name is required", field: "name" }, 400);
      if (taken(name)) return fail(res, { code: "invalid_state", message: `a list or segment named \`${name}\` already exists`, hint: "pick another name", field: "name" }, 409);
      const l = L(`l${nextList++}`, name, "manual", 0, { description: b.description || null, created_at: ago(0) });
      CONTACT_LISTS.push(l); sortLists();
      return body(res, l, {}, 201);
    }
    if ((m = p.match(/^\/v1\/(?:lists|segments)\/([^/]+)\/members(\/remove)?$/))) {
      const l = listBy(decodeURIComponent(m[1])); if (!l) return notFound(res, "list");
      const ids = b.contact_ids ?? [], emails = (b.emails ?? []).map((e) => String(e).trim().toLowerCase());
      if (!ids.length && !emails.length) return fail(res, { code: "invalid_request", message: "give contact_ids and/or emails" }, 400);
      if (m[2]) {
        let removed = 0;
        for (const c of CONTACTS) if ((ids.includes(c.id) || emails.includes(c.email)) && c.lists?.some((x) => x.id === l.id)) { c.lists = c.lists.filter((x) => x.id !== l.id); removed++; }
        l.member_count = Math.max(0, l.member_count - removed);
        return body(res, { list_id: l.id, removed });
      }
      let added = 0, already = 0, missing = 0;
      const add = (c) => { c.lists ??= []; if (c.lists.some((x) => x.id === l.id)) already++; else { c.lists.push(ref(l)); l.member_count++; added++; } };
      for (const id of ids) { const c = CONTACTS.find((x) => x.id === id); if (c) add(c); else missing++; }
      for (const e of emails) {
        let c = CONTACTS.find((x) => x.email === e);
        if (!c) { c = { id: `c${nextContact++}`, email: e, created_at: ago(0), properties: {}, suppressed: false, suppression_reason: null, lists: [] }; CONTACTS.push(c); }
        add(c);
      }
      return body(res, { list_id: l.id, added, already_members: already, not_found: missing });
    }
    if ((m = p.match(/^\/v1\/lists\/([^/]+)$/))) {
      const l = listBy(decodeURIComponent(m[1])); if (!l) return notFound(res, "list");
      if (req.method === "DELETE") {
        if (l.origin === "source" && !l.detached) return fail(res, { code: "invalid_state", message: "this list is fed by a contact source", hint: "delete the source (optionally with its list) instead" }, 409);
        CONTACT_LISTS.splice(CONTACT_LISTS.indexOf(l), 1);
        for (const c of CONTACTS) c.lists = (c.lists ?? []).filter((x) => x.id !== l.id);
        return body(res, { id: l.id, deleted: true });
      }
      if (b.name != null) {
        const name = String(b.name).trim();
        if (!name) return fail(res, { code: "invalid_request", message: "name cannot be empty", field: "name" }, 400);
        if (taken(name, l.id)) return fail(res, { code: "invalid_state", message: `a list or segment named \`${name}\` already exists`, hint: "pick another name", field: "name" }, 409);
        l.name = name; for (const c of CONTACTS) for (const x of c.lists ?? []) if (x.id === l.id) x.name = name;
      }
      if (b.description != null) l.description = b.description || null;
      sortLists();
      return body(res, l);
    }
    if (p === "/v1/contact-sources/test") {
      const src = b.id ? findSource(b.id) : null, url = b.url || src?.url || "";
      if (b.id && !src) return notFound(res, "contact source");
      if (!url || (!b.key && !src)) return fail(res, { code: "invalid_request", message: "give a url and a key, or the id of a saved source" }, 400);
      if (src?.id === "src2") return body(res, { ok: false, error: "The source answered 401 Unauthorized: it rejected the API key." });
      if (/fail|refused/i.test(url)) return body(res, { ok: false, error: `Could not connect to ${url}: connection refused` });
      if (src?.id === "src3") return body(res, { ok: true, sample_count: 0, has_more: false, fields: [], property_keys: [] });
      return body(res, { ok: true, sample_count: 1, has_more: true, fields: ["id", "email", "first_name", "last_name", "timezone", "updated_at", "properties"], property_keys: ["plan", "seats"] });
    }
    if (p === "/v1/contact-sources" && req.method === "POST") {
      const name = String(b.name ?? "").trim(), url = String(b.url ?? "").trim(), listName = String(b.list_name || name).trim();
      if (!name || !b.key) return fail(res, { code: "invalid_request", message: !name ? "name is required" : "key is required", field: !name ? "name" : "key" }, 400);
      if (!/^https?:\/\/[^/\s@]+(\/|$)/.test(url)) return fail(res, { code: "invalid_request", message: "url must be an http(s) address without credentials", field: "url" }, 400);
      if (SOURCES.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail(res, { code: "invalid_state", message: `a contact source named \`${name}\` already exists`, field: "name" }, 409);
      if (taken(listName)) return fail(res, { code: "invalid_state", message: `a list or segment named \`${listName}\` already exists`, hint: "give the source another list_name", field: "list_name" }, 409);
      const id = `src${SOURCES.length + 1}`, l = L(`l${nextList++}`, listName, "source", 0, { source_id: id, created_at: ago(0) });
      CONTACT_LISTS.push(l); sortLists();
      const x = { id, name, url, enabled: b.enabled !== false, interval_minutes: b.interval_minutes ?? 15, full_sync_hours: b.full_sync_hours ?? 24, last_full_at: null, watermark: null, last_run_at: null, last_status: null, last_error: null, last_counts: null, created_at: ago(0), list_id: l.id };
      SOURCES.push(x);
      return body(res, sourceOut(x), {}, 201);
    }
    if ((m = p.match(/^\/v1\/contact-sources\/([^/]+)\/sync$/))) {
      const x = findSource(m[1]); if (!x) return notFound(res, "contact source");
      const l = listBy(x.list_id);
      if (q.get("dry_run") === "true") {
        if (x.last_status === "error") return body(res, { ok: false, error: x.last_error });
        const rows = PREVIEW_ROWS[x.id] ?? [];
        return body(res, { ok: true, dry_run: true, sample: true, has_more: x.id === "src1", summary: summarize(rows), list: l ? { id: l.id, name: l.name } : null, rows });
      }
      if (x.last_status === "error") return body(res, { id: x.id, ok: false, error: x.last_error, counts: { created: 0, updated: 0, skipped: 0, deleted: 0, fetched: 0, reasons: {} }, watermark: null, duration_ms: 812 });
      Object.assign(x, { last_run_at: ago(0), last_status: "ok", last_error: null, last_counts: syncCounts, watermark: ago(0) });
      return body(res, { id: x.id, ok: true, error: null, counts: syncCounts, watermark: x.watermark, duration_ms: 640 });
    }
    if ((m = p.match(/^\/v1\/contact-sources\/([^/]+)$/))) {
      const x = findSource(m[1]); if (!x) return notFound(res, "contact source");
      if (req.method === "DELETE") {
        const l = listBy(x.list_id), dropList = q.get("delete_list") === "true";
        SOURCES.splice(SOURCES.indexOf(x), 1);
        if (l && dropList) { CONTACT_LISTS.splice(CONTACT_LISTS.indexOf(l), 1); for (const c of CONTACTS) c.lists = (c.lists ?? []).filter((y) => y.id !== l.id); }
        else if (l) Object.assign(l, { detached: true, source_id: null });
        return body(res, { id: x.id, deleted: true, list_deleted: !!(l && dropList) });
      }
      if (b.url != null && b.url !== x.url) x.watermark = null;
      for (const k of ["name", "url", "enabled", "interval_minutes", "full_sync_hours"]) if (b[k] != null) x[k] = b[k];
      return body(res, sourceOut(x));
    }
    if (req.method === "PATCH" && (m = p.match(/^\/v1\/transports\/([^/]+)$/))) {
      const mb = MAILBOXES.find((x) => x.id === m[1]); if (!mb) return fail(res, { code: "invalid_request", message: "only a mailbox relay has aliases and display names" }, 400);
      mb.aliases = b.aliases ?? mb.aliases; mb.names = b.display_names ?? mb.names; withRelay();
      return body(res, { id: mb.id, aliases: mb.aliases, display_names: mb.names });
    }
    if (req.method === "POST" && p === "/v1/transports" && b.config?.mailbox_sender) {
      const id = "tr" + (transports.length + 1), login = b.config.username;
      MAILBOXES.push({ id, login, names: b.config.display_names ?? {}, aliases: b.config.aliases ?? [] });
      transports.push({ id, kind: "smtp-relay", name: b.name || login, label: "production", is_default: false, status: "active" }); withRelay();
      return body(res, { id, kind: "smtp-relay", name: b.name || login, status: "ready" }, {}, 201);
    }
    if (req.method === "PUT" && p === "/v1/settings") { if (b.default_from !== undefined) settings.default_from = b.default_from || null; if (b.reply_to !== undefined) settings.reply_to = b.reply_to; return body(res, settings); }
    if (req.method === "PATCH" && (m = p.match(/^\/v1\/domains\/([^/]+)$/))) {
      const d = DOMAINS.find((x) => x.id === m[1]); if (!d) return notFound(res, "domain");
      d.transport_id = b.transport_id ?? null; return body(res, d);
    }
    if (req.method === "PUT" && p === "/v1/contacts") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email ?? "")) return fail(res, { code: "invalid_request", message: "email is not valid", field: "email" }, 400);
      let c = CONTACTS.find((x) => x.email === b.email.toLowerCase());
      if (!c) CONTACTS.push((c = { id: "c" + (CONTACTS.length + 1), email: b.email.toLowerCase(), created_at: ago(0), properties: {}, suppressed: false, suppression_reason: null }));
      for (const k of ["first_name", "last_name", "timezone"]) if (b[k] !== undefined) c[k] = b[k];
      return body(res, c);
    }
    if (p === "/v1/events") return body(res, { event_id: "ev9", duplicate: false, triggered_automations: [{ id: "a1", run_id: "run_9" }] }, {}, 202);
    if (p === "/v1/automations") {
      const def = input, bad = (def.steps ?? []).find((s) => s.config?.template === "missing");
      if (bad) return fail(res, { code: "invalid_request", message: `automation \`${def.name}\`: step \`${bad.key}\`: template \`missing\` does not exist or has no published version`, hint: "Publish the template first, or pick another." }, 422);
      const id = "a_" + (AUTOMATIONS.length + 1), old = AUTOMATIONS.find((a) => a.name === def.name);
      if (old) { old.steps = def.steps; old.current_version += 1; return body(res, { id: old.id, name: old.name, version: old.current_version, status: old.status, trigger: old.trigger_event, steps: def.steps }, {}, 201); }
      AUTOMATIONS.push({ id, name: def.name, status: "draft", trigger: def.steps?.[0]?.config?.event, trigger_event: def.steps?.[0]?.config?.event ?? "", current_version: 1, entry_rule: def.entry_rule, approval: def.approval, stats: {}, steps: def.steps, created_at: ago(0) });
      return body(res, { id, name: def.name, version: 1, status: "draft", trigger: def.steps?.[0]?.config?.event, steps: def.steps }, {}, 201);
    }
    if ((m = p.match(/^\/v1\/automations\/([^/]+)\/(publish|pause|resume|archive|unarchive)$/))) {
      const a = AUTOMATIONS.find((x) => x.id === m[1] || x.name === m[1]); if (!a) return notFound(res, "automation");
      a.status = { publish: "active", pause: "paused", resume: "active", archive: "archived", unarchive: "draft" }[m[2]];
      return body(res, { id: a.id, name: a.name, status: a.status });
    }
    if ((m = p.match(/^\/v1\/automations\/([^/]+)\/test$/))) {
      if (input.email === "nobody") return fail(res, { code: "invalid_request", message: "`nobody` is not a valid email address", hint: "Use name@domain.com" }, 422);
      return body(res, { run_id: "run_test_" + Date.now(), automation_id: m[1], env: "test", status: "started" }, {}, 202);
    }
    if (p === "/v1/content/lint") { const r = renderInline({ ...b, content: b.content ?? b.html ?? b.mjml ?? "", format: b.format ?? (b.mjml != null ? "mjml" : "html") }); return r.error ? fail(res, r.error, r.status) : body(res, { lint: r.data.lint, warnings: [] }); }
    if ((m = p.match(/^\/v1\/templates\/([^/]+)\/preview$/))) {
      const t = findTemplate(m[1]);
      if (!t) return notFound(res, "template");
      if (t.id === "t4" && b.content == null && b.html == null && b.mjml == null) return body(res, renderInline({ content: t.source, format: "html", subject: t.subject, variables: b.variables }).data);
      if (b.content != null || b.html != null || b.mjml != null) {
        const r = renderInline({ ...b, content: b.content ?? b.html ?? b.mjml, format: b.format ?? (b.mjml != null ? "mjml" : "html") });
        return r.error ? fail(res, r.error, r.status) : body(res, r.data);
      }
      return body(res, { subject: t.subject, html: html(t.name ?? "Template"), text: "", variables: t.variables, lint: t.id === "t1" ? [] : [{ rule: "missing-alt", severity: "warning", message: "Image has no alt text", path: "blocks[2]" }, { rule: "no-unsubscribe", severity: "error", message: "Marketing email needs an unsubscribe link", path: "footer" }] });
    }
    if (p === "/v1/templates/import") {
      if (!b.name || !b.content) return fail(res, { code: "invalid_request", message: "name and content are required", field: "content" }, 400);
      const alias = String(b.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (findTemplate(alias)) return fail(res, { code: "template_exists", message: `a template with alias \`${alias}\` already exists`, field: "alias" }, 409);
      const id = `t${TEMPLATES.length + 1}`, title = String(b.content).match(/<(?:mj-)?title>([^<]*)</i)?.[1] ?? "";
      TEMPLATES.unshift({ id, alias, name: b.name, stream: "transactional", subject: title, status: "draft", version: 1, published_version: null, updated_at: ago(0), variables: varsOf(b.content), source_format: b.format, source: String(b.content) });
      VERSIONS[id] = [{ version: 1, source_format: b.format, created_at: ago(0), published_at: null, published: false }];
      return body(res, { id, alias, name: b.name, subject: title, status: "draft", version: 1, published: false, warnings: [] }, {}, 201);
    }
    if ((m = p.match(/^\/v1\/templates\/([^/]+)\/versions\/(\d+)\/restore$/))) {
      const t = findTemplate(m[1]); if (!t || !VERSIONS[t.id].some((v) => v.version === Number(m[2]))) return notFound(res, "template version");
      t.version += 1; VERSIONS[t.id].unshift({ version: t.version, source_format: t.source_format, created_at: ago(0), published_at: null, published: false });
      return body(res, { id: t.id, alias: t.alias, version: t.version, restored_from: Number(m[2]), published_version: t.published_version }, {}, 201);
    }
    if ((m = p.match(/^\/v1\/templates\/([^/]+)\/draft$/))) {
      const t = findTemplate(m[1]); if (!t) return notFound(res, "template");
      if (t.published_version == null) return fail(res, { code: "no_published_version", message: "nothing is published to fall back to", hint: "publish a version first" }, 409);
      const gone = VERSIONS[t.id].filter((v) => v.version > t.published_version && !v.published_at);
      if (!gone.length) return fail(res, { code: "no_draft", message: "there are no unpublished changes to discard" }, 409);
      VERSIONS[t.id] = VERSIONS[t.id].filter((v) => !gone.includes(v)); t.version = VERSIONS[t.id][0].version;
      return body(res, { id: t.id, alias: t.alias, discarded: gone.length, version: t.version, published_version: t.published_version });
    }
    if ((m = p.match(/^\/v1\/templates\/([^/]+)\/publish$/))) {
      const t = findTemplate(m[1]); if (!t) return notFound(res, "template");
      t.published_version = t.version; t.status = "published";
      VERSIONS[t.id] = VERSIONS[t.id].map((v) => ({ ...v, published: v.version === t.version, published_at: v.version === t.version ? ago(0) : v.published_at }));
      return body(res, { id: t.id, alias: t.alias, published_version: t.version });
    }
    if (req.method === "PATCH" && (m = p.match(/^\/v1\/templates\/([^/]+)$/))) {
      const t = findTemplate(m[1]); if (!t) return notFound(res, "template");
      if (b.alias && b.alias !== t.alias && findTemplate(b.alias)) return fail(res, { code: "template_exists", message: `a template with alias \`${b.alias}\` already exists`, field: "alias" }, 409);
      for (const k of ["name", "alias", "stream"]) if (b[k]) t[k] = b[k];
      if (b.content != null) {
        t.version += 1; t.source_format = b.format; t.source = String(b.content);
        if (b.subject != null) t.subject = b.subject;
        if (b.preheader != null) t.preheader = b.preheader;
        t.variables = varsOf(t.source + " " + t.subject);
        VERSIONS[t.id].unshift({ version: t.version, source_format: b.format, created_at: ago(0), published_at: null, published: false });
      }
      return body(res, { id: t.id, alias: t.alias, name: t.name, stream: t.stream, version: t.version, published_version: t.published_version, warnings: [] });
    }
    if (p === "/v1/broadcasts/preview") {
      const r = input.recipient ?? {}, name = r.first_name || "there";
      if (r.email === "bad@example.com") return fail(res, { code: "template_render_failed", message: "variable render failed: undefined value", hint: "give the value a fallback: {{ first_name | default(\"there\") }}" }, 422);
      return body(res, { subject: (input.subject || "Welcome aboard").replace(/\{\{\s*first_name[^}]*\}\}/g, name), html: html(`Hello ${name}`).replace("{{ first_name }}", name), text: `Hi ${name},\n\nthanks for joining us.` });
    }
    if (p === "/v1/broadcasts") {
      const n = (input.recipients ?? []).length, cap = input.max_per_day ? Math.min(50, input.max_per_day) : 50;
      if (!input.dry_run) return body(res, { id: "b1", status: "queued", queued: n, skipped: [] }, {}, 202);
      return body(res, { dry_run: true, queued: n, skipped: [], schedule: { daily_cap: cap, transport_daily_cap: 50, spacing_seconds: 86400 / cap, first_at: new Date().toISOString(), last_at: new Date(Date.now() + Math.max(0, n - 1) * 864e5 / cap).toISOString() } });
    }
    if (p === "/v1/emails") return body(res, { id: "em_00", status: "queued", recipients: [{ email: "ana@example.com", id: "em_00" }] }, {}, 202);
    return body(res, p.endsWith("/test") ? { ok: false, detail: "535 authentication failed" } : {});
  }
  if (p === "/v1/kill-switch") return body(res, { on: false });
  if (p === "/v1/account/status") return body(res, process.env.EMPTY ? { ...status, pending_approvals: 0 } : status);
  if (p === "/v1/settings") return body(res, settings);
  if (p === "/v1/senders") return body(res, process.env.EMPTY ? [] : sendersList());
  if (p === "/v1/policy") return body(res, policy);
  if (p === "/v1/stats/overview") {
    const n = Number(q.get("days") || 14);
    const series = process.env.EMPTY ? [] : Array.from({ length: n }, (_, i) => { const sent = 700 + ((i * 137) % 9) * 60 + i * 20; return { date: day(n - 1 - i), sent, delivered: Math.round(sent * 0.985), bounced: Math.round(sent * 0.011), complained: i % 4 === 0 ? 1 : 0 }; });
    return body(res, { totals: { sent: 12408, delivered: 12301, bounced: 31, complained: 2 }, series });
  }
  if (p === "/v1/automations") { if (process.env.EMPTY) return body(res, []); const st = q.get("status"); return body(res, AUTOMATIONS.filter((a) => (st ? a.status === st : a.status !== "archived")).map(listRow)); }
  if (p === "/v1/events/names") return body(res, process.env.EMPTY ? [] : EVENT_NAMES);
  if (process.env.EMPTY && LISTS[p]) return body(res, []);
  if ((m = p.match(/^\/v1\/broadcasts\/([^/]+)$/))) { const b = BROADCASTS.find((x) => x.id === m[1]); return b ? body(res, broadcastDetail(b, q.get("status"))) : notFound(res, "broadcast"); }
  if (p === "/v1/emails") {
    let rows = EMAILS; const s = q.get("status"); if (s) rows = rows.filter((e) => e.status === s);
    const lim = Number(q.get("limit") || 25), start = Number(q.get("cursor") || 0), out = rows.slice(start, start + lim);
    return body(res, out, { next_cursor: start + lim < rows.length ? String(start + lim) : null });
  }
  if (p === "/v1/approvals") return body(res, q.get("status") ? APPROVALS.filter((x) => x.status === q.get("status")) : APPROVALS);
  if (p === "/v1/event-definitions") return body(res, process.env.EMPTY ? [] : [{ name: "signed_up" }, { name: "upgraded" }, { name: "login" }]);
  if ((m = p.match(/^\/v1\/contacts\/([^/]+)\/activity$/))) { const c = CONTACTS.find((x) => x.id === m[1] || x.email === decodeURIComponent(m[1])); return c ? body(res, c.id === "c1" ? ACTIVITY : NO_ACTIVITY) : notFound(res, "contact"); }
  if ((m = p.match(/^\/v1\/contacts\/([^/]+)$/))) { const c = CONTACTS.find((x) => x.id === m[1] || x.email === decodeURIComponent(m[1])); return c ? body(res, c) : notFound(res, "contact"); }
  if (p === "/v1/contacts") {
    let rows = CONTACTS; const l = q.get("list"), term = (q.get("q") ?? "").toLowerCase();
    if (l) { const list = listBy(l); if (!list) return notFound(res, "list"); rows = rows.filter((c) => c.lists?.some((x) => x.id === list.id)); }
    if (term) rows = rows.filter((c) => [c.email, c.first_name, c.last_name].some((v) => v?.toLowerCase().includes(term)));
    const lim = Number(q.get("limit")) || 0; if (lim > 0) rows = rows.slice(0, lim);
    return body(res, rows, { next_cursor: null });
  }
  if (p === "/v1/lists") return body(res, process.env.EMPTY ? [] : CONTACT_LISTS);
  if ((m = p.match(/^\/v1\/lists\/([^/]+)$/))) { const l = listBy(decodeURIComponent(m[1])); return l ? body(res, l) : notFound(res, "list"); }
  if (p === "/v1/contact-sources") return body(res, process.env.EMPTY ? [] : SOURCES.map(sourceOut));
  if ((m = p.match(/^\/v1\/contact-sources\/([^/]+)$/))) { const x = findSource(m[1]); return x ? body(res, sourceOut(x)) : notFound(res, "contact source"); }
  if (LISTS[p]) return body(res, LISTS[p]);
  if ((m = p.match(/^\/v1\/emails\/([^/]+)\/events$/))) { const e = EMAILS.find((x) => x.id === m[1]); return e ? body(res, eventsFor(e)) : notFound(res, "email"); }
  if ((m = p.match(/^\/v1\/emails\/([^/]+)$/))) { const e = EMAILS.find((x) => x.id === m[1]); return e ? body(res, e) : notFound(res, "email"); }
  if ((m = p.match(/^\/v1\/templates\/([^/]+)\/export$/))) return body(res, { content: q.get("format") === "json" ? JSON.stringify(llm, null, 2) : html("Export") });
  if ((m = p.match(/^\/v1\/templates\/([^/]+)\/versions$/))) { const t = findTemplate(m[1]); return t ? body(res, VERSIONS[t.id]) : notFound(res, "template"); }
  if ((m = p.match(/^\/v1\/templates\/([^/]+)$/))) { const t = findTemplate(m[1]); return t ? body(res, t.alias === "welcome" ? { ...t, content: llm } : t) : notFound(res, "template"); }
  if ((m = p.match(/^\/v1\/automations\/([^/]+)\/runs\/([^/]+)$/))) { const r = RUNS.find((x) => x.id === m[2]) ?? (m[2].startsWith("run_test") ? { ...RUNS[0], id: m[2], contact_email: "you@example.com", test: true, current_step: "wait", started_at: ago(0.1) } : null); return r ? body(res, runDetail(r)) : notFound(res, "run"); }
  if ((m = p.match(/^\/v1\/automations\/([^/]+)\/runs$/))) return body(res, m[1] === "a1" ? RUNS : []);
  if ((m = p.match(/^\/v1\/automations\/([^/]+)$/))) { const a = AUTOMATIONS.find((x) => x.id === m[1]); return a ? body(res, a) : notFound(res, "automation"); }
  body(res, []);
}).listen(Number(process.argv[2] || 18080), () => console.log("mock api up"));
