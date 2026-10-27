// Tiny mock of the mailcraft REST API for UI work/QA:  node scripts/mock-api.mjs [port]  (default 18080)
import { createServer } from "node:http";
const ago = (m) => new Date(Date.now() - m * 6e4).toISOString();
const R = {
  "/v1/kill-switch": { on: false },
  "/v1/account/status": { env: "test", name: "Acme", key_prefix: "mc_test_8f3a", scopes: ["read", "send", "manage"], kill_switch: false, pending_approvals: 3, verified: true },
  "/v1/stats/overview": { totals: { sent: 12408, delivered: 12301, bounced: 31, complained: 2 }, series: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${String(21 + i)}`, sent: 900 + i * 210 })) },
  "/v1/emails": Array.from({ length: 6 }, (_, i) => ({ id: `em_0${i}`, subject: ["Welcome aboard", "Your receipt", "Reset your password", "Trial ends soon", "New login", "Invoice 1042"][i], to_addr: `user${i}@example.com`, status: ["delivered", "sent", "bounced", "queued", "deferred", "delivered"][i], created_at: ago(i * 90) })),
  "/v1/domains": [{ id: "d1", name: "mail.example.com", status: "pending", records: [
    { record: "SPF", type: "TXT", name: "mail.example.com", value: "v=spf1 include:spf.mailcraft.dev ~all", status: "verified" },
    { record: "DKIM", type: "TXT", name: "mc._domainkey.mail.example.com", value: "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234567890abcdef", status: "pending" },
    { record: "Return-path", type: "MX", name: "bounce.mail.example.com", priority: 10, value: "feedback-smtp.mailcraft.dev", status: "failed" }] }],
  "/v1/keys": [{ id: "k1", name: "Production sender", prefix: "mc_live_3f9a", env: "live", scopes: ["send"], created_at: ago(9000) }, { id: "k2", name: "CI", prefix: "mc_test_77ab", env: "test", scopes: ["read", "send"], created_at: ago(200) }],
};
createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, data: R[p] ?? [] }));
}).listen(Number(process.argv[2] || 18080), () => console.log("mock api up"));
