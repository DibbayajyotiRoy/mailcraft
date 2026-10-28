// One-call send context: the template, up to 3 recipients, the From sender and the workspace name, packed to ~300 est. tokens so the
// model can propose a send without a list/get round trip. All of it is attacker-controlled text: no raw HTML, every string clipped.
import { findSender, sendersOf } from "@/lib/senders";
import { clip } from "./compact";
import { apiErr, fail, read, type Ctx, type Out } from "./core";

const BUDGET = 1200, enc = encodeURIComponent;
const cut = (s: unknown, n: number) => clip(s, Infinity).slice(0, n);
const prune = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
const plain = (src: string) => cut(src.slice(0, 50_000).replace(/<(style|script|mj-style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/[<>]/g, " "), 300);
const props = (o: unknown) => {
  const e = Object.entries(o && typeof o === "object" ? o : {}).map(([k, v]) => [cut(k, 30), cut(v && typeof v === "object" ? JSON.stringify(v) : v, 60)]).filter(([, v]) => v).slice(0, 8);
  return e.length ? Object.fromEntries(e) : undefined;
};

export function packSendContext(t: any, contacts: { email: string; contact?: any }[], sender: { address?: string; name?: string } | undefined, workspace?: string): Record<string, unknown> {
  t = t && typeof t === "object" ? t : {};
  const src = [t.source, t.content, t.html].find((x) => typeof x === "string" && x) ?? "";
  const s = prune({ address: cut(sender?.address, 120), name: cut(sender?.name, 60) });
  const p: any = prune({
    template: prune({ id: t.id, alias: t.alias, subject: cut(t.subject, 120), variables: (Array.isArray(t.variables) ? t.variables : []).map((v: any) => cut(typeof v === "string" ? v : v?.name, 40)).filter(Boolean).slice(0, 30), excerpt: plain(src) }),
    contacts: contacts.map(({ email, contact: c }) => (c && typeof c === "object"
      ? prune({ email, known: true, first_name: cut(c.first_name, 60), last_name: cut(c.last_name, 60), timezone: cut(c.timezone, 40), props: props(c.properties) })
      : { email, known: false })),
    sender: Object.keys(s).length ? s : undefined,
    workspace: cut(workspace, 80),
  });
  // Over budget: shorten the excerpt first, then drop properties (from the contact with the most), then variable names.
  for (let over = JSON.stringify(p).length - BUDGET; over > 0; over = JSON.stringify(p).length - BUDGET) {
    const tpl = p.template ?? {}, cs = (p.contacts ?? []).filter((c: any) => c.props), fat = cs.sort((a: any, b: any) => Object.keys(b.props).length - Object.keys(a.props).length)[0];
    if (tpl.excerpt) { tpl.excerpt = tpl.excerpt.slice(0, Math.max(0, tpl.excerpt.length - over)); if (!tpl.excerpt) delete tpl.excerpt; }
    else if (fat) { delete fat.props[Object.keys(fat.props).pop()!]; if (!Object.keys(fat.props).length) delete fat.props; }
    else if (tpl.variables?.length) { tpl.variables.pop(); if (!tpl.variables.length) delete tpl.variables; }
    else break;
  }
  return p;
}

export async function sendContext(a: { template?: string; to?: string[] | string; from?: string }, ctx: Ctx): Promise<Out> {
  const id = String(a.template ?? "").trim();
  if (!id) return fail("invalid_request", "template (id or alias) is required");
  const to = [...new Map([a.to ?? []].flat().flatMap((x) => String(x ?? "").split(/[\s,;]+/)).filter(Boolean).map((e) => [e.toLowerCase(), e])).values()].slice(0, 3);
  const [tr, cs, sr, ar] = await Promise.all([
    read(ctx, "GET", `/v1/templates/${enc(id)}`),
    Promise.all(to.map(async (email) => ({ email, contact: (await read(ctx, "GET", `/v1/contacts/${enc(email)}`)).data ?? undefined }))),
    read(ctx, "GET", "/v1/senders?limit=100"), // same path as the list tool, so the 60s read cache is shared
    read(ctx, "GET", "/v1/account/status"),
  ]);
  if (tr.error) return apiErr(tr.error);
  const senders = sendersOf(sr), row = (a.from ? findSender(senders, a.from) : undefined) ?? senders.find((x) => x.is_default);
  const ws = ar.data?.name ?? ar.data?.workspace?.name;
  return { ok: packSendContext(tr.data, cs, row && { address: row.address, name: row.display_name ?? undefined }, typeof ws === "string" ? ws : undefined), done: "Read the send context" };
}

/** "Send @template:welcome to a@example.com and b@example.com" -> { template: "welcome", to: [...] }; null unless both are there. */
export function mentionedSend(text: string): { template: string; to: string[] } | null {
  const template = /@template:([\w-]+(?:\.[\w-]+)*)/i.exec(text)?.[1];
  const to = [...new Map((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g) ?? []).map((e) => [e.toLowerCase(), e])).values()];
  return template && to.length ? { template, to } : null;
}
