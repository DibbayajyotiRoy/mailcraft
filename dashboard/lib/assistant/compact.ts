// Compacts API results before they go back to the model: only the fields needed, short lists, no HTML, no envelopes,
// and the whole thing labelled as untrusted data (template text, contact data and bounce diagnostics are attacker-controlled).
export const LIST_CAP = 20;
export const RESULT_CAP = 6000;

export const clip = (s: unknown, n = 200) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + `…[+${t.length - n}]` : t; };
const strip = (html: string) => clip(html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " "), 600);
const day = (t?: string) => (t ? String(t).slice(0, 16).replace("T", " ") : undefined);
const prune = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
const n = (x: any) => (x && typeof x === "object" ? x : {});

const ROW: Record<string, (r: any) => Record<string, unknown>> = {
  template: (r) => prune({ id: r.id, alias: r.alias, name: r.name, status: r.status, v: r.version, live_v: r.published_version, stream: r.stream }),
  automation: (r) => prune({ id: r.id, name: r.name, status: r.status, trigger: typeof r.trigger === "string" ? r.trigger : r.trigger?.event ?? r.trigger_event, v: r.current_version ?? r.version }),
  broadcast: (r) => prune({ id: r.id, template: r.template_name, status: r.status, total: r.total, counts: r.counts, at: day(r.created_at) }),
  email: (r) => prune({ id: r.id, to: r.to_addr ?? r.to, subject: clip(r.subject, 80), status: r.status, at: day(r.created_at) }),
  contact: (r) => prune({ id: r.id, email: r.email, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || undefined, suppressed: r.suppressed || undefined }),
  list: (r) => prune({ id: r.id, name: r.name, members: r.member_count, rule: r.filter ? true : undefined }),
  domain: (r) => prune({ id: r.id, name: r.name, status: r.status, stream: r.stream, records: tally(r.records) }),
  sender: (r) => prune({ id: r.id, kind: r.kind, name: r.name, status: r.status, default: r.is_default || undefined }),
  approval: (r) => prune({ id: r.id, kind: r.kind, status: r.status, subject: clip(r.payload?.preview?.subject, 80) }),
  event: (r) => prune({ name: r.name, count: r.count }),
};
const tally = (recs: any) => (Array.isArray(recs) ? Object.fromEntries(Object.entries(recs.reduce((a: any, x: any) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {}))) : undefined);

/** Top LIST_CAP rows by the kind's key fields, plus how many were left out. */
export function compactList(kind: string, rows: unknown, extra = 0) {
  const arr = Array.isArray(rows) ? rows : [];
  const f = ROW[kind] ?? ((r: any) => r);
  const out: Record<string, unknown> = { rows: arr.slice(0, LIST_CAP).map(f) };
  const more = Math.max(0, arr.length - LIST_CAP) + extra;
  if (more) out.more = `${more} more; narrow with q or status`;
  return out;
}

const steps = (ss: any) => (Array.isArray(ss) ? ss.map((s) => prune({ key: s.key, type: s.type, cfg: compactCfg(s.config), next: s.next })) : undefined);
const compactCfg = (c: any) => (c && typeof c === "object" ? JSON.parse(JSON.stringify(c, (_k, v) => (typeof v === "string" ? clip(v, 240) : v))) : c);

/** One entity in detail. `extra` holds the sibling calls (events, lint, activity) already fetched. */
export function compactGet(kind: string, d: any, extra: Record<string, any> = {}, withSource = false) {
  d = n(d);
  switch (kind) {
    case "template": {
      const src = typeof d.source === "string" ? d.source : typeof d.content === "string" ? d.content : "";
      return prune({ id: d.id, alias: d.alias, name: d.name, status: d.status, stream: d.stream, subject: d.subject, preheader: d.preheader, variables: d.variables,
        v: d.version, live_v: d.published_version, format: d.source_format, lint: compactLint(extra.lint), source: withSource ? clip2(src, 12000) : undefined, source_chars: withSource ? undefined : src.length || undefined });
    }
    case "automation": {
      const stats = n(d.stats);
      return prune({ id: d.id, name: d.name, status: d.status, v: d.current_version ?? d.version, entry_rule: d.entry_rule, approval: d.approval, goal: d.goal, caps: d.caps, steps: steps(d.steps),
        funnel: Object.keys(stats).length ? Object.fromEntries(Object.entries(stats).map(([k, s]: [string, any]) => [k, [s.entered, s.completed, s.failed]])) : undefined, funnel_cols: Object.keys(stats).length ? "entered,completed,failed" : undefined });
    }
    case "email": {
      const ev = Array.isArray(extra.events) ? extra.events : [];
      return prune({ id: d.id, to: d.to_addr, from: d.from_addr, subject: clip(d.subject, 120), status: d.status, attempts: d.attempts, error: clip(d.last_error, 240) || undefined,
        policy: Array.isArray(d.policy_decisions) ? d.policy_decisions.map((p: any) => `${p.rule}:${p.decision}${p.reason ? ` (${clip(p.reason, 60)})` : ""}`) : undefined,
        events: ev.slice(-8).map((e: any) => prune({ t: e.type, code: e.enhanced_code, why: clip(e.diagnostic, 200), at: day(e.occurred_at) })), text: d.text ? strip(d.text) : undefined });
    }
    case "broadcast":
      return prune({ id: d.id, template: d.template_name, from: d.from, subject: clip(d.subject, 100), status: d.status, total: d.total, counts: d.counts,
        skipped: (d.skipped ?? []).slice(0, 8).map((s: any) => `${s.email}: ${s.reason}${s.detail ? ` (${clip(s.detail, 60)})` : ""}`),
        problems: (d.recipients ?? []).filter((r: any) => r.last_error).slice(0, 8).map((r: any) => `${r.email}: ${clip(r.last_error, 100)}`) });
    case "contact": {
      const a = n(extra.activity);
      return prune({ id: d.id, email: d.email, first_name: d.first_name, last_name: d.last_name, timezone: d.timezone, props: compactCfg(d.properties), suppressed: d.suppressed || undefined, why: d.suppression_reason ?? undefined,
        events: (a.events ?? []).slice(0, 5).map((e: any) => `${e.name} ${day(e.received_at)}`), emails: (a.emails ?? []).slice(0, 5).map((e: any) => `${e.id}: ${clip(e.subject, 50)} [${e.status}]`),
        runs: (a.runs ?? []).slice(0, 5).map((r: any) => `${r.automation}: ${r.state}`), lists: (a.segments ?? []).map((s: any) => s.name) });
    }
    case "domain":
      return prune({ id: d.id, name: d.name, status: d.status, records: (d.records ?? []).map((r: any) => prune({ rec: r.record, type: r.type, status: r.status, found: r.found })) });
    case "approval":
      return prune({ id: d.id, kind: d.kind, status: d.status, preview: d.payload?.preview ? { subject: clip(d.payload.preview.subject, 100), text: clip(d.payload.preview.text, 300) } : undefined });
    case "account":
      return prune({ workspace: d.name ?? d.workspace?.name, env: d.env, live_enabled: d.live_enabled, kill_switch: d.kill_switch, pending_approvals: d.pending_approvals, scopes: d.scopes, verified: d.verified });
    case "settings":
      return prune({ default_from: d.default_from, reply_to: d.reply_to, delivery: d.delivery_path?.kind, writing_instructions: clip(d.custom_instructions, 400) });
    case "health":
      return compactCfg(d);
    default:
      return compactCfg(d);
  }
}
const clip2 = (s: string, cap: number) => (s.length > cap ? s.slice(0, cap) + `\n…[truncated ${s.length - cap} chars]` : s);
export const compactLint = (l: any) => (Array.isArray(l) ? l.slice(0, 10).map((x: any) => `${x.severity ?? x.sev}:${x.rule} ${clip(x.message ?? x.msg, 90)}${x.path ? ` @${x.path}` : ""}`) : undefined);

/** `<untrusted>` wrapper: `<` is escaped inside the JSON, so data can neither close the tag nor fake another. Hard-capped. */
export function untrusted(v: unknown, cap = RESULT_CAP): string {
  let s = JSON.stringify(v).replace(/</g, "\\u003c");
  if (s.length > cap) s = s.slice(0, cap) + `…[truncated ${s.length - cap} chars]`;
  return `<untrusted>${s}</untrusted>`;
}
