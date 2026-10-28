// Write tools. None of them writes anything: each validates, does read-only previews and dry runs, and hands back a
// proposal. The user's Apply (see proposals.ts) is the only thing that executes the stored calls.
import type { Schema } from "./catalogue";
import { clip, compactLint } from "./compact";
import { apiErr, fail, read, type Ctx, type Out } from "./core";
import { putProposal, type Step } from "./proposals";
import type { Proposal } from "./types";

const enc = encodeURIComponent;
type Builder = (a: any, ctx: Ctx) => Promise<Out>;
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const lines = (s: string) => s.split("\n").length;

type Draft = Omit<Proposal, "id" | "expires_at" | "warnings"> & { warnings?: string[]; calls: Step[]; link?: string; linkKind?: string };
/** Stores the proposal and returns the short note the model gets: it must not claim anything was changed. */
function propose(ctx: Ctx, d: Draft, info: Record<string, unknown> = {}): Out {
  const proposal = putProposal(ctx.sid, { warnings: [], ...d });
  return { proposal, model: { status: "proposal_shown_to_user", note: "Nothing has changed yet; the user must press Apply. Do not say it was done.", ...info } };
}
const liveConfirm = (ctx: Ctx, text: string) => (ctx.env === "live" ? text : undefined);
const sandbox = (ctx: Ctx) => (ctx.env === "test" ? ["Test key: mail goes to the sandbox and nothing is delivered to real inboxes."] : []);

// ---- templates -------------------------------------------------------------------------------------------------------
const proposeTemplate: Builder = async (a, ctx) => {
  let before = "", beforeFmt: string | undefined, ex: any;
  if (isStr(a.id)) {
    const r = await read(ctx, "GET", `/v1/templates/${enc(a.id)}`);
    if (r.error) return apiErr(r.error);
    ex = r.data; before = typeof ex.source === "string" ? ex.source : typeof ex.content === "string" ? ex.content : ""; beforeFmt = ex.source_format;
  } else if (!isStr(a.name)) return fail("invalid_request", "name is required for a new template (or id to change one).");
  const fmt = a.format ?? beforeFmt ?? "mjml";
  if (fmt !== "html" && fmt !== "mjml") return fail("invalid_request", "format must be html or mjml.", beforeFmt === "json" ? "This template uses the block editor (json); change it in the editor." : undefined);
  let after: string;
  if (Array.isArray(a.edits) && a.edits.length) {
    if (!ex) return fail("invalid_request", "edits need an existing template id.");
    if (ex.source_format && ex.source_format !== fmt) return fail("invalid_request", `The template is ${ex.source_format}; edits patch that source.`);
    after = before;
    for (const [i, e] of a.edits.entries()) {
      if (typeof e?.find !== "string" || typeof e?.replace !== "string" || !e.find) return fail("invalid_request", `edits[${i}] needs find and replace strings.`);
      const parts = after.split(e.find);
      if (parts.length === 1) return fail("edit_not_found", `edits[${i}].find does not occur in the template source.`, "Fetch the source with get {source:true} and copy the text exactly.");
      if (parts.length > 2) return fail("edit_ambiguous", `edits[${i}].find occurs ${parts.length - 1} times.`, "Include more surrounding text so it matches once.");
      after = parts.join(e.replace);
    }
  } else if (isStr(a.content)) after = a.content;
  else return fail("invalid_request", "Give content (full source) or edits (find/replace patches).");
  if (after.length > 200_000) return fail("too_large", "The template is over 200 KB.");
  if (after === before && !a.subject && !a.preheader) return fail("no_change", "The proposed source is identical to the current one.");

  const subject = a.subject ?? ex?.subject, pre = a.preheader ?? undefined;
  let lint: { sev: string; msg: string }[] = [], preview: Proposal["preview"];
  if (ex) {
    const p = await read(ctx, "POST", `/v1/templates/${enc(ex.id ?? a.id)}/preview`, { format: fmt, content: after, subject, ...(pre && { preheader: pre }) });
    if (p.error) return fail(p.error.code, `The new source does not render: ${p.error.message}`, p.error.hint ?? "Fix it and propose again.");
    lint = (p.data.lint ?? []).map((l: any) => ({ sev: l.severity, msg: `${l.rule}: ${l.message}` }));
    preview = { subject: p.data.subject ?? subject ?? "", html: p.data.html ?? "" };
  } else {
    const l = await read(ctx, "POST", "/v1/content/lint", { format: fmt, [fmt]: after, subject });
    if (!l.error) lint = (l.data?.lint ?? []).map((x: any) => ({ sev: x.severity, msg: `${x.rule}: ${x.message}` }));
  }
  const errors = lint.filter((l) => l.sev === "error").length;
  const warnings = ex?.published_version != null ? [`Live version v${ex.published_version} keeps sending until someone publishes this draft.`] : [];
  const body = { format: fmt, content: after, ...(subject && { subject }), ...(pre && { preheader: pre }) };
  const calls: Step[] = ex
    ? [{ method: "PATCH", path: `/v1/templates/${enc(ex.id ?? a.id)}`, body, label: "Save draft" }]
    : [{ method: "POST", path: "/v1/templates", body: { name: a.name.trim(), ...(isStr(a.alias) && { alias: a.alias }), [fmt]: after, ...(subject && { subject }), ...(pre && { preheader: pre }) }, label: "Create template" }];
  return propose(ctx, {
    kind: "template", risk: "safe", warnings, calls, lint, preview, link: ex ? `/templates/${enc(ex.id ?? a.id)}` : undefined, linkKind: "templates",
    title: ex ? `Update template "${ex.name ?? ex.alias}"` : `Create template "${a.name.trim()}"`,
    summary: `Saves ${ex ? "a new draft version" : "a new draft"} (${fmt}, ${plural(lines(after), "line")}). Nothing is published; sends keep using the live version.`,
    diff: { label: `Source (${fmt})`, before, after },
  }, { lint_errors: errors, lint_warnings: lint.length - errors, lint: lint.slice(0, 6).map((l) => `${l.sev}: ${clip(l.msg, 80)}`) });
};

// ---- automations -----------------------------------------------------------------------------------------------------
const AUTO_KEYS = ["name", "trigger", "entry_rule", "entry_days", "goal", "approval", "caps", "steps"];
const proposeAutomation: Builder = async (a, ctx) => {
  const d = a?.definition;
  if (!d || typeof d !== "object" || !isStr(d.name) || !Array.isArray(d.steps) || !d.steps.length) return fail("invalid_request", "definition needs name and a non-empty steps array.", "See get_docs automations.");
  if (d.steps.length > 40) return fail("too_large", "At most 40 steps.");
  for (const [i, s] of d.steps.entries()) if (!isStr(s?.key) || !isStr(s?.type)) return fail("invalid_request", `steps[${i}] needs key and type.`);
  const def: Record<string, unknown> = Object.fromEntries(AUTO_KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
  if (def.approval === undefined) def.approval = "first_n:5";
  const warnings: string[] = [];
  if (def.approval === "never") warnings.push("Approval is off: the first sends go out without a human looking at them.");

  const names = [...new Set<string>(d.steps.filter((s: any) => s.type === "send_email" && isStr(s.config?.template)).map((s: any) => s.config.template))];
  if (names.length) {
    const t = await read(ctx, "GET", "/v1/templates?limit=100");
    if (t.error) return apiErr(t.error);
    const rows: any[] = t.data ?? [];
    for (const n of names) {
      const row = rows.find((x) => x.alias === n || x.id === n);
      if (!row) return fail("template_missing", `Template "${n}" does not exist.`, `Existing: ${rows.slice(0, 8).map((x) => x.alias).join(", ") || "none"}. Propose it with propose_template, or use one of these.`);
      if (row.published_version == null) return fail("template_unpublished", `Template "${n}" has no published version, so the automation cannot be installed.`, "The assistant cannot publish. Tell the user to publish it from the template page, then propose again.");
    }
  }
  const ex = await read(ctx, "GET", `/v1/automations/${enc(def.name as string)}`);
  const cur = ex.error ? null : ex.data;
  if (cur?.status === "active") warnings.push("This automation is active: the new version applies to new entries immediately.");
  const pick = (o: any) => Object.fromEntries(AUTO_KEYS.filter((k) => k !== "trigger" && o?.[k] !== undefined).map((k) => [k, o[k]]));
  const before = cur ? JSON.stringify(pick(cur), null, 2) : "";
  return propose(ctx, {
    kind: "automation", risk: "safe", warnings, link: cur ? `/automations/${enc(cur.id)}` : undefined, linkKind: "automations",
    calls: [{ method: "POST", path: "/v1/automations", body: def, label: "Save automation" }],
    title: cur ? `Update automation "${def.name}"` : `Create automation "${def.name}"`,
    summary: cur ? `Saves version ${(cur.current_version ?? cur.version ?? 0) + 1}; status stays ${cur.status}.` : "Saves a new draft. Nothing sends until it is activated, which is a separate step.",
    diff: { label: "Definition", before, after: JSON.stringify(pick(def), null, 2) },
    items: (d.steps as any[]).map((s) => `${s.key}: ${s.type}${s.config?.template ? ` (${s.config.template})` : s.config?.duration ? ` ${s.config.duration}` : s.config?.event ? ` ${s.config.event}` : ""}`),
  });
};

const proposeAutomationState: Builder = async (a, ctx) => {
  if (!isStr(a?.id) || !["activate", "pause", "resume"].includes(a.action)) return fail("invalid_request", "id and action (activate|pause|resume) are required.");
  const r = await read(ctx, "GET", `/v1/automations/${enc(a.id)}`);
  if (r.error) return apiErr(r.error);
  const d = r.data, st = d.status;
  let path = a.action;
  if (a.action === "activate") { if (st === "active") return fail("invalid_state", "It is already active."); path = st === "paused" ? "resume" : "publish"; }
  if (a.action === "pause" && st !== "active") return fail("invalid_state", `It is ${st}, not active.`);
  if (a.action === "resume" && st !== "paused") return fail("invalid_state", `It is ${st}, not paused.`);
  const starts = path !== "pause", ev = typeof d.trigger === "string" ? d.trigger : d.trigger?.event ?? d.trigger_event;
  return propose(ctx, {
    kind: "automation_state", risk: starts ? "sends" : "safe", link: `/automations/${enc(d.id)}`,
    confirm: starts ? liveConfirm(ctx, `This starts "${d.name}" for real: contacts who trigger ${ev ? `"${ev}"` : "it"} will be emailed.`) : undefined,
    warnings: starts ? [`Approval setting: ${d.approval ?? "default"}. Kill switch, suppressions and caps still apply.`, ...sandbox(ctx)] : [],
    calls: [{ method: "POST", path: `/v1/automations/${enc(d.id)}/${path}`, ...(path === "publish" && a.backfill_suppress ? { body: { backfill_suppress: true } } : {}), label: path }],
    title: `${starts ? (path === "resume" ? "Resume" : "Activate") : "Pause"} automation "${d.name}"`,
    summary: starts ? `Contacts matching ${ev ? `"${ev}"` : "the trigger"} will start entering${a.backfill_suppress ? " (existing matches are kept out)" : ""}.` : "Running contacts stop advancing and nobody new enters.",
  });
};

// ---- broadcasts and single emails ----------------------------------------------------------------------------------
const skippedTally = (skipped: any[] = []) => Object.entries(skipped.reduce((m: any, s) => ((m[s.reason] = (m[s.reason] ?? 0) + 1), m), {})).map(([reason, n]) => ({ reason, n: n as number }));
const proposeBroadcast: Builder = async (a, ctx) => {
  if (!isStr(a?.template)) return fail("invalid_request", "template (id or alias) is required.");
  const list = isStr(a.list) ? a.list.trim() : undefined, emails: string[] = Array.isArray(a.emails) ? a.emails.map(String) : [];
  if (!!list === !!emails.length) return fail("invalid_request", "Give exactly one audience: list (name or id) or emails.");
  if (emails.length > 200) return fail("too_large", "At most 200 explicit emails; use a list for more.");
  const t = await read(ctx, "GET", `/v1/templates/${enc(a.template)}`);
  if (t.error) return apiErr(t.error);
  if (t.data.published_version == null) return fail("template_unpublished", `Template "${t.data.alias ?? a.template}" has no published version.`, "The assistant cannot publish. Tell the user to publish it, then propose again.");
  let from = isStr(a.from) ? a.from.trim() : undefined;
  if (!from) { const s = await read(ctx, "GET", "/v1/settings"); from = s.data?.default_from || undefined; }
  if (!from) return fail("missing_sender", "No from address given and no default sender is set.", "Ask the user which sender to use.");
  const base = { template_id: t.data.id ?? a.template, from, stream: "marketing", ...(isStr(a.subject) && { subject: a.subject }), ...(a.max_per_day > 0 && { max_per_day: Math.floor(a.max_per_day) }) };
  const body = { ...base, ...(list ? { list_id: list } : { recipients: emails.map((email) => ({ email })) }) };
  const dry = await read(ctx, "POST", "/v1/broadcasts", { ...body, dry_run: true }, 0);
  if (dry.error) return apiErr(dry.error);
  const n: number = dry.data.queued ?? 0, sk = skippedTally(dry.data.skipped);
  if (!n) return fail("empty_audience", "Nobody would receive this.", sk.map((s) => `${s.n} ${s.reason}`).join(", ") || "The audience is empty.");
  let recipient: any = emails.length ? { email: emails[0] } : undefined, sample = false;
  if (!recipient) { const c = await read(ctx, "GET", `/v1/contacts?list=${enc(list!)}&limit=1`); recipient = c.data?.[0] && { email: c.data[0].email, first_name: c.data[0].first_name, last_name: c.data[0].last_name }; }
  if (!recipient) { recipient = { email: "preview@example.com", first_name: "Alex" }; sample = true; }
  const pv = await read(ctx, "POST", "/v1/broadcasts/preview", { template_id: base.template_id, ...(base.subject && { subject: base.subject }), stream: "marketing", recipient });
  const sch = dry.data.schedule, when = sch?.first_at ? `${String(sch.first_at).slice(0, 16).replace("T", " ")} to ${String(sch.last_at).slice(0, 16).replace("T", " ")}` : "";
  const warnings = [...(pv.error ? [`Preview failed: ${pv.error.message}`] : []), ...(sample ? ["Preview uses a sample recipient."] : []), ...sandbox(ctx),
    ...(sch?.daily_cap ? [`Paced at ${sch.daily_cap} per day.`] : [])];
  return propose(ctx, {
    kind: "broadcast", risk: "sends", warnings, link: undefined, linkKind: "broadcasts",
    confirm: liveConfirm(ctx, `This will email ${plural(n, "real person").replace("persons", "people")}.`),
    calls: [{ method: "POST", path: "/v1/broadcasts", body: { ...body, dry_run: false }, label: "Send broadcast" }],
    title: `Broadcast "${t.data.name ?? t.data.alias}" to ${list ? `list "${list}"` : plural(emails.length, "address")}`,
    summary: `Sends from ${from} to ${plural(n, "recipient")}${when ? `, spread over ${when}` : ""}. Approvals, go-live and the kill switch still apply.`,
    audience: { count: n, skipped: sk, schedule: when || undefined },
    preview: pv.error ? undefined : { subject: pv.data.subject, html: pv.data.html },
  }, { audience: n, skipped: sk, schedule: when || undefined });
};

const proposeEmail: Builder = async (a, ctx) => {
  const to: string[] = Array.isArray(a?.to) ? a.to.map(String) : [];
  if (!to.length || to.length > 5 || to.some((e) => !EMAIL.test(e))) return fail("invalid_request", "to must be 1-5 valid addresses (use propose_broadcast for more).");
  if (!a.template && !a.html && !a.text) return fail("invalid_request", "Give template, html or text.");
  const body: Record<string, unknown> = { to, ...(isStr(a.from) && { from: a.from }), ...(isStr(a.subject) && { subject: a.subject }), ...(a.template && { template: a.template }), ...(isStr(a.html) && { html: a.html }), ...(isStr(a.text) && { text: a.text }) };
  const dry = await read(ctx, "POST", "/v1/emails", { ...body, dry_run: true }, 0);
  if (dry.error) return apiErr(dry.error);
  const d = dry.data ?? {}, html = d.html ?? d.rendered?.html ?? d.preview?.html ?? (isStr(a.html) ? a.html : ""), subject = d.subject ?? d.rendered?.subject ?? a.subject ?? "";
  const lint = (d.lint ?? d.rendered?.lint ?? []).map((l: any) => ({ sev: l.severity, msg: `${l.rule}: ${l.message}` }));
  return propose(ctx, {
    kind: "email", risk: "sends", lint, warnings: sandbox(ctx), link: undefined,
    confirm: liveConfirm(ctx, `This will email ${to.length === 1 ? "1 real person" : `${to.length} real people`}.`),
    calls: [{ method: "POST", path: "/v1/emails", body, label: "Send email" }],
    title: `Send "${clip(subject || "(template subject)", 50)}" to ${to[0]}${to.length > 1 ? ` and ${to.length - 1} more` : ""}`,
    summary: "Sends one email now. Approvals, go-live and the kill switch still apply.",
    preview: html ? { subject, html } : undefined, items: to,
  }, { lint_issues: lint.length });
};

// ---- lists and contacts --------------------------------------------------------------------------------------------
const proposeList: Builder = async (a, ctx) => {
  const emails: string[] = Array.isArray(a?.emails) ? a.emails.map(String) : [];
  if (!isStr(a?.name) && !isStr(a?.id)) return fail("invalid_request", "name is required.");
  if (emails.length > 500 || emails.some((e) => !EMAIL.test(e))) return fail("invalid_request", "emails must be up to 500 valid addresses.");
  const all = await read(ctx, "GET", "/v1/segments");
  if (all.error) return apiErr(all.error);
  const rows: any[] = all.data ?? [], cur = isStr(a.id) ? rows.find((x) => x.id === a.id || x.name === a.id) : undefined;
  if (isStr(a.id) && !cur) return fail("not_found", `No list with id or name "${a.id}".`);
  const name = isStr(a.name) ? a.name.trim() : cur.name;
  const clash = rows.find((x) => x.name === name && x.id !== cur?.id);
  if (clash) return fail("name_taken", `"${name}" already exists (id ${clash.id}).`, "Pass id to update it, or pick another name.");
  const filter = a.filter === undefined ? cur?.filter : a.filter; // PUT replaces: keep the rule unless told otherwise
  let audience: Proposal["audience"], items: string[] | undefined;
  if (filter) {
    const p = await read(ctx, "POST", "/v1/segments/preview", { filter });
    if (p.error) return fail(p.error.code, `The rule was rejected: ${p.error.message}`, p.error.hint);
    audience = { count: p.data.count ?? 0, skipped: [] }; items = (p.data.sample ?? []).map((s: any) => s.email);
  }
  const calls: Step[] = [cur ? { method: "PUT", path: `/v1/segments/${enc(cur.id)}`, body: { name, ...(filter ? { filter } : {}) }, label: "Save list" } : { method: "POST", path: "/v1/segments", body: { name, ...(filter ? { filter } : {}) }, label: "Create list" }];
  if (emails.length) calls.push({ method: "POST", path: `/v1/segments/${cur ? enc(cur.id) : "$prev.id"}/members`, body: { emails }, label: "Add members" });
  return propose(ctx, {
    kind: "list", risk: "safe", calls, audience, items: items ?? emails.slice(0, 10), warnings: [], link: cur ? "/contacts" : undefined, linkKind: "contacts",
    title: `${cur ? "Update" : "Create"} ${filter ? "segment" : "list"} "${name}"`,
    summary: `${cur ? "Saves changes to" : "Creates"} ${filter ? "a rule-based segment" : "a manual list"}${emails.length ? ` and adds ${plural(emails.length, "address")}` : ""}. Nobody is emailed.`,
    diff: filter ? { label: "Rule", before: cur?.filter ? JSON.stringify(cur.filter, null, 2) : "", after: JSON.stringify(filter, null, 2) } : undefined,
  });
};

const proposeContacts: Builder = async (a, ctx) => {
  const cs: any[] = Array.isArray(a?.contacts) ? a.contacts : [];
  if (!cs.length || cs.length > 50) return fail("invalid_request", "contacts must hold 1-50 entries.");
  const bad = cs.find((c) => !EMAIL.test(String(c?.email ?? "")));
  if (bad) return fail("invalid_request", `"${clip(bad?.email, 40)}" is not a valid email.`);
  const calls: Step[] = cs.map((c) => ({ method: "PUT", path: "/v1/contacts", body: Object.fromEntries(["email", "first_name", "last_name", "timezone", "properties"].filter((k) => c[k] !== undefined).map((k) => [k, c[k]])), label: `Upsert ${c.email}` }));
  return propose(ctx, {
    kind: "contacts", risk: "safe", calls, warnings: [], link: "/contacts",
    title: `Add or update ${plural(cs.length, "contact")}`, summary: "Creates new contacts and updates existing ones by email. Nobody is emailed.",
    items: cs.slice(0, 10).map((c) => `${c.email}${c.first_name ? ` (${[c.first_name, c.last_name].filter(Boolean).join(" ")})` : ""}`).concat(cs.length > 10 ? [`…and ${cs.length - 10} more`] : []),
  });
};

export const PROPOSE: Record<string, Builder> = {
  propose_template: proposeTemplate, propose_automation: proposeAutomation, propose_automation_state: proposeAutomationState,
  propose_broadcast: proposeBroadcast, propose_email: proposeEmail, propose_list: proposeList, propose_contacts: proposeContacts,
};

const s = (type: string, extra: Partial<Schema> = {}): Schema => ({ type, ...extra });
const o = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length && { required }) });
const T = (name: string, description: string, parameters: Schema) => ({ type: "function" as const, function: { name, description, parameters } });
const strs = s("array", { items: s("string") });
export const PROPOSE_SCHEMAS = {
  propose_template: T("propose_template", "Propose a template draft (new, or change id). Prefer edits (exact find/replace patches) to fixes. Never publishes.",
    o({ id: s("string"), name: s("string"), format: s("string", { enum: ["html", "mjml"] }), content: s("string"), edits: s("array", { items: o({ find: s("string"), replace: s("string") }, ["find", "replace"]) }), subject: s("string"), preheader: s("string") })),
  propose_automation: T("propose_automation", "Propose creating/updating an automation (draft, not activated). Send the full definition.", o({ definition: s("object") }, ["definition"])),
  propose_automation_state: T("propose_automation_state", "Propose activating, pausing or resuming an automation.", o({ id: s("string"), action: s("string", { enum: ["activate", "pause", "resume"] }), backfill_suppress: s("boolean") }, ["id", "action"])),
  propose_broadcast: T("propose_broadcast", "Propose sending a published template to a list or emails (dry run shown first).", o({ template: s("string"), from: s("string"), subject: s("string"), list: s("string"), emails: strs, max_per_day: s("integer") }, ["template"])),
  propose_email: T("propose_email", "Propose sending one email to 1-5 addresses.", o({ to: strs, from: s("string"), subject: s("string"), template: o({ id: s("string"), variables: s("object") }), html: s("string"), text: s("string") }, ["to"])),
  propose_list: T("propose_list", "Propose creating/updating a contact list or rule segment, optionally adding emails.", o({ id: s("string"), name: s("string"), filter: s("object"), emails: strs })),
  propose_contacts: T("propose_contacts", "Propose creating/updating up to 50 contacts by email.", o({ contacts: s("array", { items: o({ email: s("string"), first_name: s("string"), last_name: s("string"), timezone: s("string"), properties: s("object") }, ["email"]) }) }, ["contacts"])),
};
