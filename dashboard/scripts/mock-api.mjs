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

const CONTACTS = [
  { id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva", timezone: "Europe/Berlin", created_at: ago(500), properties: { plan: "pro", seats: 4, beta: true, tags: ["vip", "eu"] }, suppressed: false, suppression_reason: null },
  { id: "c2", email: "ben@example.com", first_name: "Ben", created_at: ago(60 * 24), properties: { plan: "free" }, suppressed: false, suppression_reason: null },
  { id: "c3", email: "bounce@example.com", suppressed: true, suppression_reason: "hard_bounce", created_at: ago(60 * 24 * 9), properties: {} },
  { id: "c4", email: "cy@example.com", first_name: "Cy", last_name: "Okafor", created_at: ago(60 * 24 * 20), properties: { plan: "pro" }, suppressed: false, suppression_reason: null },
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

const status = { env: "test", live_enabled: false, name: "Acme", key_prefix: "mc_test_8f3a", scopes: ["read", "send", "manage", "admin"], kill_switch: false, pending_approvals: APPROVALS.length, verified: true };
const settings = { llm_provider: { kind: "openrouter", model: "anthropic/claude-sonnet-4", base_url: null, api_key_set: true }, delivery_path: { kind: "smtp-relay", detail: "postmark via smtp.postmarkapp.com:587" }, default_from: "Acme <hello@mail.example.com>", reply_to: "support@example.com", custom_instructions: "Be brief and friendly." };
const policy = { default: { send: "needs_approval" }, keys: [{ key_id: "k1", name: "Production sender", policy: { send: "auto" } }] };
const transports = [{ id: "tr1", kind: "smtp-relay", name: "postmark", label: "production", is_default: true, status: "active" }];

const LISTS = { "/v1/emails": EMAILS, "/v1/approvals": APPROVALS, "/v1/domains": DOMAINS, "/v1/keys": KEYS, "/v1/templates": TEMPLATES, "/v1/contacts": CONTACTS, "/v1/segments": SEGMENTS, "/v1/transports": transports };

const body = (res, data, extra = {}, code = 200) => { res.statusCode = code; res.end(JSON.stringify({ ok: true, data, ...extra })); };
const fail = (res, e, code) => { res.statusCode = code; res.end(JSON.stringify({ ok: false, error: e })); };
const notFound = (res, what) => fail(res, { code: "not_found", message: `No such ${what}` }, 404);

createServer((req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, q = u.searchParams; let m;
  res.setHeader("content-type", "application/json");
  if (process.env.FAIL) return fail(res, { code: "unreachable", message: "Cannot reach the database", hint: "Check the server" }, 503);
  if (req.method !== "GET") {
    if (p === "/v1/contacts/import" || p === "/v1/segments/preview") {
      let raw = ""; req.on("data", (c) => (raw += c));
      return req.on("end", () => {
        if (p === "/v1/segments/preview") return body(res, { count: 12, sample: CONTACTS.slice(0, 3).map(({ email, first_name, last_name }) => ({ email, first_name, last_name })) });
        const rows = JSON.parse(raw || "{}").contacts ?? [];
        body(res, { imported: rows.filter((r) => !/^bad@/.test(r.email)).length, failed: rows.flatMap((r, index) => (/^bad@/.test(r.email) ? [{ index, email: r.email, error: { code: "invalid_request", message: "Rejected by the mock" } }] : [])) });
      });
    }
    if (p === "/v1/events") return body(res, { event_id: "ev9", duplicate: false, triggered_automations: [{ id: "a1", run_id: "run_9" }] }, {}, 202);
    if (p === "/v1/automations") {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const def = JSON.parse(raw || "{}"), bad = (def.steps ?? []).find((s) => s.config?.template === "missing");
        if (bad) return fail(res, { code: "invalid_request", message: `automation \`${def.name}\`: step \`${bad.key}\`: template \`missing\` does not exist or has no published version`, hint: "Publish the template first, or pick another." }, 422);
        const id = "a_" + (AUTOMATIONS.length + 1), old = AUTOMATIONS.find((a) => a.name === def.name);
        if (old) { old.steps = def.steps; old.current_version += 1; return body(res, { id: old.id, name: old.name, version: old.current_version, status: old.status, trigger: old.trigger_event, steps: def.steps }, {}, 201); }
        AUTOMATIONS.push({ id, name: def.name, status: "draft", trigger: def.steps?.[0]?.config?.event, trigger_event: def.steps?.[0]?.config?.event ?? "", current_version: 1, entry_rule: def.entry_rule, approval: def.approval, stats: {}, steps: def.steps, created_at: ago(0) });
        body(res, { id, name: def.name, version: 1, status: "draft", trigger: def.steps?.[0]?.config?.event, steps: def.steps }, {}, 201);
      });
      return;
    }
    if ((m = p.match(/^\/v1\/automations\/([^/]+)\/(publish|pause|resume|archive|unarchive)$/))) {
      const a = AUTOMATIONS.find((x) => x.id === m[1] || x.name === m[1]); if (!a) return notFound(res, "automation");
      a.status = { publish: "active", pause: "paused", resume: "active", archive: "archived", unarchive: "draft" }[m[2]];
      return body(res, { id: a.id, name: a.name, status: a.status });
    }
    if ((m = p.match(/^\/v1\/automations\/([^/]+)\/test$/))) {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => { const b = JSON.parse(raw || "{}"); if (b.email === "nobody") return fail(res, { code: "invalid_request", message: "`nobody` is not a valid email address", hint: "Use name@domain.com" }, 422); body(res, { run_id: "run_test_" + Date.now(), automation_id: m[1], env: "test", status: "started" }, {}, 202); });
      return;
    }
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
  if (p === "/v1/automations") { if (process.env.EMPTY) return body(res, []); const st = q.get("status"); return body(res, AUTOMATIONS.filter((a) => (st ? a.status === st : a.status !== "archived")).map(listRow)); }
  if (p === "/v1/events/names") return body(res, process.env.EMPTY ? [] : EVENT_NAMES);
  if (process.env.EMPTY && LISTS[p]) return body(res, []);
  if (p === "/v1/emails") {
    let rows = EMAILS; const s = q.get("status"); if (s) rows = rows.filter((e) => e.status === s);
    const lim = Number(q.get("limit") || 25), start = Number(q.get("cursor") || 0), out = rows.slice(start, start + lim);
    return body(res, out, { next_cursor: start + lim < rows.length ? String(start + lim) : null });
  }
  if (p === "/v1/approvals") return body(res, APPROVALS);
  if (p === "/v1/event-definitions") return body(res, process.env.EMPTY ? [] : [{ name: "signed_up" }, { name: "upgraded" }, { name: "login" }]);
  if ((m = p.match(/^\/v1\/contacts\/([^/]+)\/activity$/))) { const c = CONTACTS.find((x) => x.id === m[1] || x.email === decodeURIComponent(m[1])); return c ? body(res, c.id === "c1" ? ACTIVITY : NO_ACTIVITY) : notFound(res, "contact"); }
  if ((m = p.match(/^\/v1\/contacts\/([^/]+)$/))) { const c = CONTACTS.find((x) => x.id === m[1] || x.email === decodeURIComponent(m[1])); return c ? body(res, c) : notFound(res, "contact"); }
  if (LISTS[p]) return body(res, LISTS[p]);
  if ((m = p.match(/^\/v1\/emails\/([^/]+)\/events$/))) { const e = EMAILS.find((x) => x.id === m[1]); return e ? body(res, eventsFor(e)) : notFound(res, "email"); }
  if ((m = p.match(/^\/v1\/emails\/([^/]+)$/))) { const e = EMAILS.find((x) => x.id === m[1]); return e ? body(res, e) : notFound(res, "email"); }
  if ((m = p.match(/^\/v1\/templates\/([^/]+)\/export$/))) return body(res, { content: q.get("format") === "json" ? JSON.stringify(llm, null, 2) : html("Export") });
  if ((m = p.match(/^\/v1\/templates\/([^/]+)$/))) { const t = TEMPLATES.find((x) => x.id === m[1] || x.alias === m[1]); return t ? body(res, t.alias === "welcome" ? { ...t, content: llm } : t) : notFound(res, "template"); }
  if ((m = p.match(/^\/v1\/automations\/([^/]+)\/runs\/([^/]+)$/))) { const r = RUNS.find((x) => x.id === m[2]) ?? (m[2].startsWith("run_test") ? { ...RUNS[0], id: m[2], contact_email: "you@example.com", test: true, current_step: "wait", started_at: ago(0.1) } : null); return r ? body(res, runDetail(r)) : notFound(res, "run"); }
  if ((m = p.match(/^\/v1\/automations\/([^/]+)\/runs$/))) return body(res, m[1] === "a1" ? RUNS : []);
  if ((m = p.match(/^\/v1\/automations\/([^/]+)$/))) { const a = AUTOMATIONS.find((x) => x.id === m[1]); return a ? body(res, a) : notFound(res, "automation"); }
  body(res, []);
}).listen(Number(process.argv[2] || 18080), () => console.log("mock api up"));
