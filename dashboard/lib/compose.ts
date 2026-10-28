// Pure helpers behind the "New email" dialog (no React, no server imports: unit-tested).

export type Mode = "text" | "html" | "template";
export type Compose = {
  from: string; to: string; subject: string; stream: "transactional" | "marketing";
  mode: Mode; text: string; html: string; template: string; vars: Record<string, string>;
};
export type Errors = Partial<Record<"from" | "to" | "subject" | "content", string>>;

/** Comma, semicolon or newline separated addresses; blanks dropped, case-insensitive duplicates removed. */
export function parseRecipients(s: string): string[] {
  const seen = new Set<string>();
  return s.split(/[,;\n]+/).map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
}

/** The shape check behind every recipient (the API stays the judge of the rest). */
export const isEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

/** The platform fills these in at send time, so the form never asks for them. */
const PLATFORM_VARS = /^(unsubscribe_url|preferences_url|workspace(\..*)?|slots(\..*|\[.*)?)$/;
export const askableVars = (vars: unknown): string[] =>
  (Array.isArray(vars) ? vars : []).map((v) => (typeof v === "string" ? v : v?.name)).filter((v): v is string => !!v && !PLATFORM_VARS.test(v));

/** `{ "name": "Ada", "data.company": "Acme" }` -> `{ name: "Ada", data: { company: "Acme" } }`; blank values are dropped. */
export function nestVars(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (!v.trim()) continue;
    const path = k.split(".");
    let cur = out;
    for (const p of path.slice(0, -1)) cur = typeof cur[p] === "object" && cur[p] ? cur[p] : (cur[p] = {});
    cur[path[path.length - 1]] = v;
  }
  return out;
}

/** Validates, then builds the POST /v1/emails body. The API stays the judge of everything else (domains, policy, caps). */
export function composeBody(c: Compose): { body: Record<string, unknown> } | { errors: Errors } {
  const errors: Errors = {};
  const to = parseRecipients(c.to);
  if (!c.from.trim()) errors.from = "Enter the address this is sent from.";
  if (!to.length) errors.to = "Add at least one recipient.";
  else if (to.length > 50) errors.to = "At most 50 recipients per email.";
  else { const bad = to.find((a) => !isEmail(a)); if (bad) errors.to = `“${bad}” is not an email address.`; }
  if (c.mode !== "template" && !c.subject.trim()) errors.subject = "Add a subject.";
  if (c.mode === "text" && !c.text.trim()) errors.content = "Write the message.";
  if (c.mode === "html" && !c.html.trim()) errors.content = "Paste the HTML.";
  if (c.mode === "template" && !c.template) errors.content = "Choose a template.";
  if (Object.keys(errors).length) return { errors };
  const body: Record<string, unknown> = { from: c.from.trim(), to, stream: c.stream };
  if (c.subject.trim()) body.subject = c.subject.trim();
  if (c.mode === "text") body.text = c.text;
  else if (c.mode === "html") body.html = c.html;
  else body.template = { id: c.template, variables: nestVars(c.vars) };
  return { body };
}
