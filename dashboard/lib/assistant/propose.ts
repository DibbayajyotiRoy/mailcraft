// Write tools. None of them writes anything: each validates, does read-only previews and dry runs, and hands back a
// proposal. The user's Apply (see proposals.ts) is the only thing that executes the stored calls.
import type { Schema } from "./catalogue";
import { clip, compactLint } from "./compact";
import { apiErr, fail, read, type Ctx, type Out } from "./core";
import { createHash } from "node:crypto";
import { GO_LIVE_SUMMARY, GO_LIVE_TITLE, goLiveNext, isGoLive } from "./errors";
import { goLivePending, putProposal, type Step } from "./proposals";
import type { Proposal } from "./types";
import { findPlaceholders, plainValues, varNames, type Val } from "./variables";

const enc = encodeURIComponent;
type Builder = (a: any, ctx: Ctx) => Promise<Out>;
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const lines = (s: string) => s.split("\n").length;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s); // for text a person reads (clip() adds a "[+N]" marker for the model)

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

/** A From address that is not "ready" (needs_domain, transport_missing) will fail or bounce: say so on the card. Unknown addresses pass (a verified domain can send as any address). */
async function senderWarning(ctx: Ctx, from: string): Promise<string[]> {
  const addr = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  const r = await read(ctx, "GET", "/v1/senders");
  const row = Array.isArray(r.data) ? r.data.find((x: any) => String(x.address).toLowerCase() === addr) : undefined;
  return row && row.status && row.status !== "ready" ? [`Sender ${addr} is "${String(row.status).replace(/_/g, " ")}": ${row.status === "needs_domain" ? "verify its domain first" : "connect a transport for it"} or the send will fail.`] : [];
}

// ---- template variables the assistant drafted ------------------------------------------------------------------------
const hash = (x: string) => createHash("sha1").update(x).digest("hex").slice(0, 8);
type Drafted = NonNullable<Proposal["variables"]>;
/** The card's variable list: each variable the template reads (worker-injected ones excluded) with the value drafted for it. One that is
 *  absent, or still a stand-in ("[add signup link]"), is flagged and blocks Apply; values the template never reads are dropped (one
 *  warning). `extra` fields (subject, from, text, html) are scanned for stand-ins too and listed only when they hold one. */
function draftedVariables(names: string[], given: Record<string, Val>, extra: Record<string, unknown> = {}) {
  const variables: Drafted = names.map((name) => {
    if (!(name in given)) return { name, value: "", placeholder: true as const };
    const v = String(given[name]);
    return { name, value: v, ...(typeof given[name] === "string" && findPlaceholders(v).length > 0 && { placeholder: true as const }) };
  });
  for (const [name, v] of Object.entries(extra)) { const f = typeof v === "string" ? findPlaceholders(v) : []; if (f.length) variables.push({ name, value: f.join(", "), placeholder: true }); }
  variables.sort((x, y) => Number(!!y.placeholder) - Number(!!x.placeholder)); // gaps first: the list folds after 8
  const unused = names.length ? Object.keys(given).filter((k) => !names.includes(k)) : [];
  return { variables, placeholders: variables.filter((v) => v.placeholder).map((v) => v.name), unused, warnings: unused.length ? [`The template does not use: ${unused.join(", ")}.`] : [] };
}
/** The model is told what the card shows, so it can answer "make it shorter" by proposing again with new values. */
const varNote = (v: { name: string; value: string }[], stuck: string[]) => ({
  variables: Object.fromEntries(v.slice(0, 30).map((x) => [x.name, clip(x.value, 60)])), needs_a_value: stuck.length ? stuck : undefined,
  hint: "The card shows the filled preview. If the user asks for changes, propose again with new values; never ask them to fill variables." + (stuck.length ? ` Ask only for what needs a real value (${stuck.join(", ")}).` : ""),
});

// ---- broadcasts and single emails ----------------------------------------------------------------------------------
/** The send was refused because the workspace is not approved for live sending. That is not a failure to report: the way forward
 *  is a go-live request a person approves. Proposes it (keeping what the user wanted as `pending`), or says one is already waiting. */
async function goLive(ctx: Ctx, kind: "email" | "broadcast", what: string): Promise<Out> {
  const pending = { kind, what }, key = `go_live:${kind}:${hash(what)}`;
  const next = goLiveNext(kind), tell = `Never suggest test keys. End with NEXT: Send it now.`;
  if (await goLivePending(ctx)) return propose(ctx, {
    kind: "go_live", risk: "safe", warnings: [], calls: [], link: "/approvals", pending, waiting: true, items: [what], key,
    title: "Waiting for go-live approval", summary: "A go-live request is already waiting for a person to approve it in Approvals. There is nothing more to apply.",
  }, { reason: "go_live_request_already_pending", note: `A go-live request is already waiting in Approvals; there is nothing to Apply and no second request is made. Say so in one sentence (do not say Apply asks for approval), mention ${what}, then say: ${next} ${tell}` });
  const st = await read(ctx, "GET", "/v1/account/status");
  if (!st.error && Array.isArray(st.data?.scopes) && !st.data.scopes.includes("manage"))
    return fail("forbidden_scope", "This key can't request go-live: it needs the manage scope.", "Say so and that someone with a manage key requests it and an admin approves it in Approvals. Never suggest test keys.");
  return propose(ctx, {
    kind: "go_live", risk: "safe", warnings: [], pending, link: "/approvals", items: [what], key,
    calls: [{ method: "POST", path: "/v1/go-live-requests", body: { note: cut(`Requested from the dashboard assistant. The user wants to send ${what}.`, 400) }, label: GO_LIVE_TITLE }],
    title: GO_LIVE_TITLE, summary: GO_LIVE_SUMMARY,
  }, { reason: "go_live_required", note: `Nothing has changed yet; the user must press Apply to request go-live approval. Do not say it was done. Say in one sentence that the workspace needs a person's go-live approval before it can send real mail; mention ${what}. Then say: ${next} ${tell}` });
}
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
  const base = { template_id: t.data.id ?? a.template, from, stream: "marketing", ...(isStr(a.transport_id) && { transport_id: a.transport_id }), ...(isStr(a.subject) && { subject: a.subject }), ...(a.max_per_day > 0 && { max_per_day: Math.floor(a.max_per_day) }) };
  const dcols = plainValues(a.data, "data");
  if ("error" in dcols) return fail("invalid_request", dcols.error, "Give each column text, a number or true/false (an empty string hides an optional one).");
  const data = dcols.ok, hasData = !list && Object.keys(data).length > 0; // shared columns for explicit recipients: {{ data.x }}
  const body = { ...base, ...(list ? { list_id: list } : { recipients: emails.map((email) => ({ email, ...(hasData && { data }) })) }) };
  const dry = await read(ctx, "POST", "/v1/broadcasts", { ...body, dry_run: true }, 0);
  if (isGoLive(dry.error)) return goLive(ctx, "broadcast", `broadcast of "${cut(a.template, 40)}" to ${list ? `list "${cut(list, 40)}"` : plural(emails.length, "address")}`);
  if (dry.error) return apiErr(dry.error);
  const n: number = dry.data.queued ?? 0, sk = skippedTally(dry.data.skipped);
  if (!n) return fail("empty_audience", "Nobody would receive this.", sk.map((s) => `${s.n} ${s.reason}`).join(", ") || "The audience is empty.");
  let recipient: any = emails.length ? { email: emails[0], ...(hasData && { data }) } : undefined, sample = false;
  if (!recipient) { const c = await read(ctx, "GET", `/v1/contacts?list=${enc(list!)}&limit=1`); recipient = c.data?.[0] && { email: c.data[0].email, first_name: c.data[0].first_name, last_name: c.data[0].last_name }; }
  if (!recipient) { recipient = { email: "preview@example.com", first_name: "Alex" }; sample = true; }
  const pv = await read(ctx, "POST", "/v1/broadcasts/preview", { template_id: base.template_id, ...(base.subject && { subject: base.subject }), stream: "marketing", recipient });
  const sch = dry.data.schedule, when = sch?.first_at ? `${String(sch.first_at).slice(0, 16).replace("T", " ")} to ${String(sch.last_at).slice(0, 16).replace("T", " ")}` : "";
  const dv = draftedVariables(hasData ? Object.keys(data).map((k) => `data.${k}`) : [], Object.fromEntries(Object.entries(hasData ? data : {}).map(([k, v]) => [`data.${k}`, v])), { subject: a.subject, from });
  const warnings = [...(await senderWarning(ctx, from)), ...(pv.error ? [`Preview failed: ${pv.error.message}`] : []), ...(sample ? ["Preview uses a sample recipient."] : []), ...sandbox(ctx),
    ...(sch?.daily_cap ? [`Paced at ${sch.daily_cap} per day.`] : []), ...dv.warnings];
  return propose(ctx, {
    kind: "broadcast", risk: "sends", warnings, link: undefined, linkKind: "broadcasts", variables: dv.variables.length ? dv.variables : undefined, key: `send:broadcast:${a.template}:${from.toLowerCase()}:${list ? `list:${list}` : emails.map((e) => e.toLowerCase()).sort().join(",")}`,
    confirm: liveConfirm(ctx, `This will email ${plural(n, "real person").replace("persons", "people")}.`),
    calls: [{ method: "POST", path: "/v1/broadcasts", body: { ...body, dry_run: false }, label: "Send broadcast" }],
    title: `Broadcast "${t.data.name ?? t.data.alias}" to ${list ? `list "${list}"` : plural(emails.length, "address")}`,
    summary: `Sends from ${from} to ${plural(n, "recipient")}${when ? `, spread over ${when}` : ""}. Approvals, go-live and the kill switch still apply.`,
    audience: { count: n, skipped: sk, schedule: when || undefined },
    preview: pv.error ? undefined : { subject: pv.data.subject, html: pv.data.html },
  }, { audience: n, skipped: sk, schedule: when || undefined, ...(dv.variables.length && varNote(dv.variables, dv.placeholders)) });
};

const proposeEmail: Builder = async (a, ctx) => {
  const to: string[] = Array.isArray(a?.to) ? a.to.map(String) : [];
  if (!to.length || to.length > 5 || to.some((e) => !EMAIL.test(e))) return fail("invalid_request", "to must be 1-5 valid addresses (use propose_broadcast for more).");
  if (!a.template && !a.html && !a.text) return fail("invalid_request", "Give template, html or text.");
  const tid: string | undefined = typeof a.template === "string" ? a.template : a.template?.id;
  if (a.template && !isStr(tid)) return fail("invalid_request", "template needs an id and the variables you drafted: {id, variables}.");
  const vals = plainValues(typeof a.template === "object" ? a.template?.variables : undefined, "template.variables");
  if ("error" in vals) return fail("invalid_request", vals.error, "Give each variable text, a number or true/false (an empty string hides an optional one).");
  const given: Record<string, Val> = { ...vals.ok };
  let names: string[] = [];
  if (tid) {
    const t = await read(ctx, "GET", `/v1/templates/${enc(tid)}`);
    if (t.error) return apiErr(t.error);
    names = varNames(t.data?.variables);
    if (to.length === 1) { // what the recipient's own record answers is filled from it, never left to a guess
      if (names.includes("email") && !("email" in given)) given.email = to[0];
      const need = ["first_name", "last_name"].filter((k) => names.includes(k) && !(k in given));
      if (need.length) { const c = await read(ctx, "GET", `/v1/contacts/${enc(to[0])}`); for (const k of need) if (isStr(c.data?.[k])) given[k] = c.data[k]; }
    }
  }
  const used = names.length ? Object.fromEntries(Object.entries(given).filter(([k]) => names.includes(k))) : given; // values the template never reads are not sent
  const tref = tid ? { id: tid, ...(Object.keys(used).length && { variables: used }) } : undefined;
  const body: Record<string, unknown> = { to, ...(isStr(a.from) && { from: a.from }), ...(isStr(a.transport_id) && { transport_id: a.transport_id }), ...(isStr(a.subject) && { subject: a.subject }), ...(tref && { template: tref }), ...(isStr(a.html) && { html: a.html }), ...(isStr(a.text) && { text: a.text }) };
  const dry = await read(ctx, "POST", "/v1/emails", { ...body, dry_run: true }, 0);
  if (isGoLive(dry.error)) return goLive(ctx, "email", `email to ${cut(to.join(", "), 80)}${isStr(a.from) ? ` from ${cut(a.from, 60)}` : ""}${isStr(a.subject) ? ` ("${cut(a.subject, 50)}")` : ""}`);
  if (dry.error) return apiErr(dry.error);
  let d = dry.data ?? {};
  if (tid) { // a dry run does not render templates (the worker does, at send time): render with the drafted variables, as the recipient will see it
    const r = await read(ctx, "POST", `/v1/templates/${enc(tid)}/preview`, { variables: used }, 0);
    if (r.error) return fail(r.error.code, `The template does not render with these variables: ${r.error.message}`, "Give every variable a value (an empty string hides an optional one), then propose again.");
    d = { ...d, ...r.data, rendered: undefined };
    if (!names.length) names = varNames(r.data?.variables);
  }
  const html = d.html ?? d.rendered?.html ?? d.preview?.html ?? (isStr(a.html) ? a.html : ""), subject = (isStr(a.subject) ? a.subject : undefined) ?? d.subject ?? d.rendered?.subject ?? "";
  const lint = (d.lint ?? d.rendered?.lint ?? []).map((l: any) => ({ sev: l.severity, msg: `${l.rule}: ${l.message}` }));
  const dv = draftedVariables(names, given, { subject: a.subject, from: a.from, text: a.text, html: a.html });
  return propose(ctx, {
    kind: "email", risk: "sends", lint, warnings: [...(isStr(a.from) ? await senderWarning(ctx, a.from) : []), ...sandbox(ctx), ...dv.warnings], link: undefined,
    variables: dv.variables.length ? dv.variables : undefined, key: `send:email:${tid ?? hash(subject)}:${isStr(a.from) ? a.from.toLowerCase() : ""}:${to.map((e) => e.toLowerCase()).sort().join(",")}`,
    confirm: liveConfirm(ctx, `This will email ${to.length === 1 ? "1 real person" : `${to.length} real people`}.`),
    calls: [{ method: "POST", path: "/v1/emails", body, label: "Send email" }],
    title: `Send "${clip(subject || "(template subject)", 50)}" to ${to[0]}${to.length > 1 ? ` and ${to.length - 1} more` : ""}`,
    summary: "Sends one email now. Approvals, go-live and the kill switch still apply.",
    preview: html ? { subject, html } : undefined, items: to,
  }, { lint_issues: lint.length, ...(dv.variables.length && varNote(dv.variables, dv.placeholders)) });
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
  propose_automation: T("propose_automation", "Propose creating/updating an automation (draft, not activated). Send the full definition; trigger is an event name.",
    o({ definition: o({ name: s("string"), trigger: s("string"), entry_rule: s("string"), goal: s("object"), approval: s("string"), steps: s("array", { items: o({ key: s("string"), type: s("string"), config: s("object"), next: {} }, ["key", "type"]) }) }, ["name", "steps"]) }, ["definition"])),
  propose_automation_state: T("propose_automation_state", "Propose activating, pausing or resuming an automation.", o({ id: s("string"), action: s("string", { enum: ["activate", "pause", "resume"] }), backfill_suppress: s("boolean") }, ["id", "action"])),
  propose_broadcast: T("propose_broadcast", "Propose sending a published template to a list or emails (dry run shown first). from: an address from list kind=sender. data: extra columns for emails, used as {{ data.x }}.", o({ template: s("string"), from: s("string"), transport_id: s("string"), subject: s("string"), list: s("string"), emails: strs, data: s("object"), max_per_day: s("integer") }, ["template"])),
  propose_email: T("propose_email", "Propose sending one email to 1-5 addresses. from: an address from list kind=sender. For a template give template.variables with a value for every variable.", o({ to: strs, from: s("string"), transport_id: s("string"), subject: s("string"), template: o({ id: s("string"), variables: s("object") }), html: s("string"), text: s("string") }, ["to"])),
  propose_list: T("propose_list", "Propose creating/updating a contact list or rule segment, optionally adding emails.", o({ id: s("string"), name: s("string"), filter: s("object"), emails: strs })),
  propose_contacts: T("propose_contacts", "Propose creating/updating up to 50 contacts by email.", o({ contacts: s("array", { items: o({ email: s("string"), first_name: s("string"), last_name: s("string"), timezone: s("string"), properties: s("object") }, ["email"]) }) }, ["contacts"])),
};
