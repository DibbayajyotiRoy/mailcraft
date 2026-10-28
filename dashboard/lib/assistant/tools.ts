// Read tools (run automatically) and tool routing. Write tools live in propose.ts and only ever return proposals.
// Only a small core set goes to the model every turn; groups are added from the page and the user's wording.
import { CAT, buildCall, oneLine, slim, type Schema } from "./catalogue";
import { clip, compactGet, compactLint, compactList, untrusted } from "./compact";
import { apiErr, fail, read, type Ctx, type Out } from "./core";
import { DOCS, DOC_TOPICS } from "./docs";
import { errorLabel } from "./errors";
import { PROPOSE, PROPOSE_SCHEMAS } from "./propose";
import type { Phase, Proposal } from "./types";

export type Outcome = { content: string; done: string; error?: boolean; proposal?: Proposal; detail?: string };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Schema } };

// ---- list / get over kinds, backed by the MCP catalogue where it has the route ------------------------------------
const NOUN: Record<string, string> = { template: "templates", automation: "automations", broadcast: "broadcasts", email: "emails", contact: "contacts", list: "lists", domain: "domains", sender: "senders", approval: "approvals", event: "event names" };
const LIST: Record<string, { tool?: string; path: string; q?: boolean }> = {
  template: { tool: "template_list", path: "/v1/templates" }, automation: { tool: "automation_list", path: "/v1/automations" },
  email: { tool: "email_list", path: "/v1/emails", q: true }, contact: { tool: "contact_list", path: "/v1/contacts", q: true }, approval: { tool: "approval_list", path: "/v1/approvals" },
  broadcast: { tool: "broadcast_list", path: "/v1/broadcasts" }, list: { tool: "segment_list", path: "/v1/segments" }, event: { tool: "event_names", path: "/v1/events/names" },
  sender: { tool: "sender_list", path: "/v1/senders" },
  domain: { path: "/v1/domains" }, // not in the MCP server (a human adds domains)
};
const GET: Record<string, { tool?: string; path: string }> = {
  template: { tool: "template_get", path: "/v1/templates/{id}" }, automation: { tool: "automation_get", path: "/v1/automations/{id}" }, email: { tool: "email_get", path: "/v1/emails/{id}" },
  contact: { tool: "contact_get", path: "/v1/contacts/{id_or_email}" }, approval: { tool: "approval_get", path: "/v1/approvals/{id}" },
  broadcast: { tool: "broadcast_get", path: "/v1/broadcasts/{id}" }, domain: { path: "/v1/domains/{id}" }, account: { tool: "account_status", path: "/v1/account/status" }, health: { tool: "doctor", path: "/v1/doctor" }, settings: { tool: "settings_get_instructions", path: "/v1/settings" },
};
const route = (m: { tool?: string; path: string }) => (m.tool ? CAT.get(m.tool)! : { method: "GET", path: m.path });
const KINDS_LIST = Object.keys(LIST), KINDS_GET = Object.keys(GET);
const hay = (r: any) => [r.name, r.alias, r.subject, r.email, r.to_addr, r.template_name, r.trigger, r.address, r.display_name].filter(Boolean).join(" ").toLowerCase();

async function list(a: any, ctx: Ctx): Promise<Out> {
  const m = LIST[a?.kind];
  if (!m) return fail("invalid_request", `kind must be one of ${KINDS_LIST.join(", ")}`);
  const q = String(a.q ?? "").trim().toLowerCase(), serverQ = m.q && q;
  const c = buildCall(route(m), { limit: m.q || a.kind === "email" ? 20 : 100, ...(a.status && { status: a.status }), ...(serverQ && { q }) });
  const r = await read(ctx, c.method, c.path);
  if (r.error) return apiErr(r.error);
  let rows: any[] = Array.isArray(r.data) ? r.data : [];
  if (a.status && !m.tool) rows = rows.filter((x) => x.status === a.status);
  if (q && !serverQ) rows = rows.filter((x) => hay(x).includes(q));
  return { ok: compactList(a.kind, rows, r.next_cursor ? 1 : 0), done: `Read ${Math.min(rows.length, 20)}${rows.length > 20 || r.next_cursor ? "+" : ""} ${rows.length === 1 && !r.next_cursor ? (a.kind === "event" ? "event name" : a.kind) : NOUN[a.kind]}`, total: rows.length };
}

async function get(a: any, ctx: Ctx): Promise<Out> {
  const kind = a?.kind, m = GET[kind];
  if (!m) return fail("invalid_request", `kind must be one of ${KINDS_GET.join(", ")}`);
  const id = String(a.id ?? "").trim();
  if (!id && !/^(account|health|settings)$/.test(kind)) return fail("invalid_request", "id is required");
  const main = buildCall(route(m), { id, id_or_email: id });
  const sib = async (path: string, method = "GET", body?: unknown) => { const r = await read(ctx, method, path, body); return r.error ? undefined : r.data; };
  const e = encodeURIComponent(id);
  const [r, x1] = await Promise.all([read(ctx, main.method, main.path),
    kind === "email" ? sib(`/v1/emails/${e}/events`) : kind === "template" ? sib(`/v1/templates/${e}/preview`, "POST", {}) : kind === "contact" ? sib(buildCall(CAT.get("contact_activity")!, { id_or_email: id }).path) : undefined]);
  if (r.error) return apiErr(r.error);
  const extra = kind === "email" ? { events: x1 } : kind === "template" ? { lint: (x1 as any)?.lint } : kind === "contact" ? { activity: x1 } : {};
  const d = r.data;
  return { ok: compactGet(kind, d, extra, !!a.source), done: `Read ${kind}${id ? ` ${clip(d?.name ?? d?.alias ?? d?.email ?? id, 40)}` : ""}` };
}

// ---- tools derived from the MCP catalogue (slimmed) -----------------------------------------------------------------
const fromCat = (name: string): ToolDef => { const t = CAT.get(name)!; return { type: "function", function: { name, description: oneLine(t.description), parameters: slim(t.parameters) } }; };
async function viaCat(name: string, a: any, ctx: Ctx): Promise<Out> {
  const t = CAT.get(name)!, c = buildCall(t, a ?? {});
  const r = await read(ctx, c.method, c.path, c.body);
  if (r.error) return apiErr(r.error);
  const d: any = r.data;
  switch (name) {
    case "template_preview": return { ok: { subject: d.subject, variables: d.variables, lint: compactLint(d.lint), text: clip(d.text, 500) }, done: "Rendered a preview" };
    case "content_lint": return { ok: { lint: compactLint(d.lint ?? d) ?? [], warnings: d.warnings }, done: "Checked lint" };
    case "automation_runs": return { ok: { rows: (Array.isArray(d) ? d : []).slice(0, 10).map((x: any) => ({ id: x.id, contact: x.contact_email, state: x.state, step: x.current_step, exit: x.exit_reason ?? undefined, test: x.test || undefined })) }, done: "Read automation runs" };
    case "segment_preview": return { ok: { count: d.count, sample: (d.sample ?? []).slice(0, 5).map((x: any) => x.email) }, done: `Counted ${d.count ?? 0} matches` };
    default: return { ok: compactGet("other", d), done: name === "automation_simulate" ? "Simulated the automation" : "Done" };
  }
}

// ---- schemas the model sees: tiny, one-line descriptions, no examples -------------------------------------------------
const S = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length && { required }) });
const str = { type: "string" } as Schema, bool = { type: "boolean" } as Schema;
const T = (name: string, description: string, parameters: Schema): ToolDef => ({ type: "function", function: { name, description, parameters } });

const CORE: ToolDef[] = [
  T("list", "Find things. Returns up to 20 rows plus a 'more' note.", S({ kind: { type: "string", enum: KINDS_LIST }, q: str, status: str }, ["kind"])),
  T("get", "Details of one thing (id, alias, name or email). Template source only with source:true.", S({ kind: { type: "string", enum: KINDS_GET }, id: str, source: bool }, ["kind"])),
  T("get_docs", "Reference text, fetch only when needed.", S({ topic: { type: "string", enum: DOC_TOPICS } }, ["topic"])),
  T("use_tools", "Unlock more tools for this chat.", S({ groups: { type: "array", items: { type: "string", enum: ["templates", "automations", "broadcasts", "contacts"] } } }, ["groups"])),
];
export const GROUPS = ["templates", "automations", "broadcasts", "contacts"] as const;
export type Group = (typeof GROUPS)[number];
const GROUP_TOOLS: Record<Group, ToolDef[]> = {
  templates: [fromCat("template_preview"), fromCat("content_lint"), PROPOSE_SCHEMAS.propose_template],
  automations: [fromCat("automation_runs"), fromCat("automation_simulate"), PROPOSE_SCHEMAS.propose_automation, PROPOSE_SCHEMAS.propose_automation_state],
  broadcasts: [PROPOSE_SCHEMAS.propose_broadcast, PROPOSE_SCHEMAS.propose_email],
  contacts: [fromCat("segment_preview"), PROPOSE_SCHEMAS.propose_list, PROPOSE_SCHEMAS.propose_contacts],
};
const KEYWORDS: Record<Group, RegExp> = {
  templates: /templat|subject|html|mjml|lint|design|layout|copy|preheader|footer|wording|rewrite|fix/i,
  automations: /automat|flow|journey|workflow|trigger|drip|onboard|welcome|nudge|sequence|win-?back|lifecycle|signup|sign-up|abandon|reminder|step\b|runs?\b/i,
  broadcasts: /broadcast|newsletter|blast|campaign|announce|\bsend\b|email (it|them|this)|webinar|launch/i,
  contacts: /contact|\blists?\b|segment|audience|import|subscriber|people|upsert|@\w|customers?/i,
};
const PAGE: [RegExp, Group[]][] = [[/^\/templates/, ["templates"]], [/^\/automations/, ["automations", "templates"]], [/^\/broadcasts/, ["broadcasts"]], [/^\/contacts/, ["contacts"]]];

/** Groups to expose for this turn: the page you are on plus keywords in the latest message (automations imply templates). */
export function routeGroups(text: string, path: string, extra: Iterable<Group> = []): Set<Group> {
  const g = new Set<Group>(extra);
  for (const [re, gs] of PAGE) if (re.test(path)) gs.forEach((x) => g.add(x));
  for (const k of GROUPS) if (KEYWORDS[k].test(text)) g.add(k);
  if (g.has("automations")) g.add("templates");
  return g;
}
export const toolsFor = (groups: Iterable<Group>): ToolDef[] => [...CORE, ...[...groups].flatMap((g) => GROUP_TOOLS[g])];

// ---- labels for the activity row -------------------------------------------------------------------------------------
const ACT: Record<string, string> = {
  get_docs: "Checking the docs", use_tools: "Getting ready", template_preview: "Rendering a preview", content_lint: "Checking lint", automation_runs: "Reading automation runs",
  automation_simulate: "Simulating the automation", segment_preview: "Counting matches", propose_template: "Drafting the template", propose_automation: "Drafting the automation",
  propose_automation_state: "Preparing the automation change", propose_broadcast: "Preparing the broadcast preview", propose_email: "Preparing the email preview", propose_list: "Preparing the list change", propose_contacts: "Preparing the contacts",
};
export function activity(name: string, a: any): { phase: Phase; label: string } {
  if (name === "list") return { phase: "reading", label: `Reading ${NOUN[a?.kind] ?? "items"}…` };
  if (name === "get") return { phase: "reading", label: `Reading ${a?.kind ?? "item"} details…` };
  return { phase: name.startsWith("propose_") ? "writing" : "reading", label: `${ACT[name] ?? name}…` };
}

// ---- dispatcher ------------------------------------------------------------------------------------------------------
export function parseArgs(raw: string): { ok: true; v: any } | { ok: false } {
  if (!raw?.trim()) return { ok: true, v: {} };
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, v } : { ok: false }; } catch { return { ok: false }; }
}

/** Runs one tool call. Never throws: any failure is returned as a structured error the model can recover from. */
export async function runTool(name: string, raw: string, ctx: Ctx, groups: Set<Group>): Promise<Outcome> {
  const p = parseArgs(raw);
  const out = (o: Out, label = ACT[name] ?? name): Outcome =>
    "error" in o ? { content: JSON.stringify({ error: o.error }), done: errorLabel(o.error) ?? `${label} failed`, error: true, detail: [o.error.message, o.error.hint].filter(Boolean).join(" ") }
      : "proposal" in o ? { content: untrusted(o.model), done: `Prepared: ${o.proposal.title}`, proposal: o.proposal }
      : { content: untrusted(o.ok), done: o.done ?? label };
  if (!p.ok) return out(fail("invalid_arguments", "Arguments were not a JSON object.", "Call the tool again with valid JSON."));
  const a = p.v;
  try {
    switch (name) {
      case "list": return out(await list(a, ctx));
      case "get": return out(await get(a, ctx));
      case "get_docs": return DOCS[a.topic] ? { content: DOCS[a.topic], done: `Read docs: ${a.topic}` } : out(fail("invalid_request", `topic must be one of ${DOC_TOPICS.join(", ")}`));
      case "use_tools": {
        const gs = (Array.isArray(a.groups) ? a.groups : []).filter((x: string): x is Group => (GROUPS as readonly string[]).includes(x));
        gs.forEach((x: Group) => groups.add(x));
        return { content: JSON.stringify({ ok: true, added: gs.flatMap((g: Group) => GROUP_TOOLS[g].map((t) => t.function.name)) }), done: "Unlocked more tools" };
      }
      case "template_preview": case "content_lint": case "automation_runs": case "automation_simulate": case "segment_preview":
        return out(await viaCat(name, a, ctx));
      default:
        if (PROPOSE[name]) return out(await PROPOSE[name](a, ctx));
        return out(fail("unknown_tool", `No tool named ${name}.`, "Use only the tools you were given; call use_tools to unlock more."));
    }
  } catch (e) {
    return out(fail("tool_failed", (e as Error).message));
  }
}
