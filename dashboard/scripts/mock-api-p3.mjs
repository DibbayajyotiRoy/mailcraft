// Mock API with Templates / Automations / Contacts / Segments fixtures (P3 QA):  node scripts/mock-api-p3.mjs [port]  (default 18080)
import { createServer } from "node:http";
const ago = (m) => new Date(Date.now() - m * 6e4).toISOString();
const page = (name) => `<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif;background:#f4f4f5"><div style="max-width:560px;margin:0 auto;background:#fff;padding:32px"><h1 style="color:#111;font-size:28px">${name}</h1><p style="color:#444">Hi {{ first_name }}, thanks for joining us.</p><a href="#" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Get started</a></div></body></html>`;
const T = [
  { id: "t1", alias: "welcome", name: "Welcome", subject: "Welcome {{ first_name }}", status: "published", version: 3, published_version: 3, updated_at: ago(300), variables: ["first_name"] },
  { id: "t2", alias: "receipt", name: "Receipt", subject: "Your receipt", status: "published", version: 5, published_version: 4, updated_at: ago(60 * 30), variables: ["first_name", "amount"] },
  { id: "t3", alias: "winback", name: "Win-back", subject: "We miss you", status: "draft", version: 1, published_version: null, updated_at: ago(60 * 24 * 3), variables: ["first_name"] },
];
const llm = { version: 1, subject: "Welcome", blocks: [{ type: "heading", text: "Hi" }, { type: "slot", name: "intro", max_len: 240, instructions: "One warm sentence", fallback: "Thanks for signing up." }] };
const A = [
  { id: "a1", name: "welcome", status: "active", trigger: "signed_up", version: 2, entry_rule: "once", approval: "first_n:5", goal: { event: "upgraded" },
    steps: [
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
const runs = [
  { id: "run_01HZXY0000000000K9QF", contact: "ana@example.com", status: "running", started_at: ago(12), current_step: "wait" },
  { id: "run_01HZXY1111111111AB12", contact: "ben@example.com", status: "completed", started_at: ago(60 * 5), finished_at: ago(60 * 5 - 3) },
  { id: "run_01HZXY2222222222CD34", contact: "cy@example.com", status: "failed", started_at: ago(60 * 30), finished_at: ago(60 * 30 - 1) },
];
const contacts = [
  { id: "c1", email: "ana@example.com", first_name: "Ana", last_name: "Silva", timezone: "Europe/Berlin", created_at: ago(500), properties: { plan: "pro", seats: 4 }, topics: [{ name: "product", subscribed: true }, { name: "newsletter", subscribed: false }] },
  { id: "c2", email: "ben@example.com", first_name: "Ben", created_at: ago(60 * 24), properties: { plan: "free" } },
  { id: "c3", email: "bounce@example.com", status: "suppressed", suppressed: true, suppression_reason: "hard bounce", created_at: ago(60 * 24 * 9), properties: {} },
  { id: "c4", email: "cy@example.com", first_name: "Cy", last_name: "Okafor", created_at: ago(60 * 24 * 20), properties: { plan: "pro" } },
];
const segments = [
  { id: "s1", name: "Pro customers", member_count: 1284, filter: { and: [{ field: "contact.plan", op: "eq", value: "pro" }, { field: "contact.signed_up_days", op: "lte", value: 30 }] } },
  { id: "s2", name: "Nudged", member_count: 42 },
  { id: "s3", name: "EU or UK", filter: { or: [{ field: "contact.country", op: "in", value: ["DE", "FR"] }, { field: "contact.country", op: "eq", value: "GB" }] } },
];
const base = {
  "/v1/kill-switch": { on: false },
  "/v1/account/status": { env: "test", name: "Acme", key_prefix: "mc_test_8f3a", scopes: ["read", "send", "manage"], kill_switch: false, pending_approvals: 3 },
  "/v1/templates": T, "/v1/automations": A, "/v1/contacts": contacts, "/v1/segments": segments,
};
const send = (res, data, ok = true, status = 200) => { res.statusCode = status; res.end(JSON.stringify(ok ? { ok: true, data } : { ok: false, error: data })); };
createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname; let m;
  res.setHeader("content-type", "application/json");
  if (process.env.EMPTY && /^\/v1\/(templates|automations|contacts|segments)$/.test(p)) return send(res, []);
  if (process.env.FAIL && /^\/v1\/(templates|automations|contacts|segments)/.test(p)) return send(res, { code: "unreachable", message: "Cannot reach the database", hint: "Check the server" }, false, 503);
  if ((m = p.match(/^\/v1\/templates\/([^/]+)\/preview$/))) { const t = T.find((x) => x.id === m[1]); return send(res, { subject: t?.subject, html: page(t?.name ?? "Template"), text: "", lint: t?.id === "t1" ? [] : [{ rule: "missing-alt", severity: "warning", message: "Image has no alt text", path: "blocks[2]" }, { rule: "no-unsubscribe", severity: "error", message: "Marketing email needs an unsubscribe link", path: "footer" }] }); }
  if ((m = p.match(/^\/v1\/templates\/([^/]+)$/))) { const t = T.find((x) => x.id === m[1] || x.alias === m[1]); return t ? send(res, m[1] === "welcome" ? { ...t, content: llm } : t) : send(res, { code: "not_found", message: "No such template" }, false, 404); }
  if ((m = p.match(/^\/v1\/automations\/([^/]+)\/runs$/))) return send(res, m[1] === "a1" ? runs : []);
  if ((m = p.match(/^\/v1\/automations\/([^/]+)$/))) { const a = A.find((x) => x.id === m[1]); return a ? send(res, a) : send(res, { code: "not_found", message: "No such automation" }, false, 404); }
  send(res, base[p] ?? []);
}).listen(Number(process.argv[2] || 18080), () => console.log("mock api p3 up"));
