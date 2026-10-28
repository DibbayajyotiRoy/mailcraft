// Template-send helpers shared by the proposal builders and the send-context packer. Pure.

/** Names the worker injects at send time (templates read them as `unsubscribe_url`, `workspace.name`, ...): never the assistant's to fill. */
export const isReserved = (n: string) => /^(unsubscribe_url|preferences_url|mc_footer|workspace(\..*)?)$/.test(n);

/** The fillable variable names of a template: strings or `{name}` objects, reserved ones dropped. */
export const varNames = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x : x?.name)).filter((n): n is string => typeof n === "string" && n !== "" && !isReserved(n)))];

export type Val = string | number | boolean;
/** Variable values the API accepts (scalars). null/undefined become ""; objects and arrays are an error the model can correct, not silently dropped. */
export function plainValues(v: unknown, what: string): { ok: Record<string, Val> } | { error: string } {
  if (v == null) return { ok: {} };
  if (typeof v !== "object" || Array.isArray(v)) return { error: `${what} must be an object of name: value pairs.` };
  const ok: Record<string, Val> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x == null) ok[k] = "";
    else if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") ok[k] = x;
    else return { error: `${what}.${k} must be text, a number or true/false, not ${Array.isArray(x) ? "a list" : "an object"}.` };
  }
  return { ok };
}

// ---- placeholders ----------------------------------------------------------------------------------------------------------------
// The assistant fills variables itself, but must not invent real URLs, prices, offers or legal facts: there it leaves a marked gap
// ("[add signup link]") that a person fills. Anything that still looks like a gap blocks Apply, so the net is wide on purpose, but
// ordinary brackets ("[Beta] Invite", "?filter[type]=") must pass.
const GAP_WORDS = /\b(add|insert|enter|fill|replace|your|link|url|name|company|date|price|amount|offer|here|todo|tbd|xxx)\b/i;
const GAP_SINGLE = /^(link|url|name|company|date|price|amount|offer|insert|here|todo|tbd|xxx)$/i;
const gapLike = (inner: string) => {
  const t = inner.trim();
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t) || (/\s/.test(t) ? GAP_WORDS.test(t) : GAP_SINGLE.test(t)); // SIGNUP_LINK, "add a link", [url]
};
/** Every gap-looking stand-in in `value` (NFKC-normalised, so full-width brackets do not slip through). Linear: no nested quantifiers. */
export function findPlaceholders(value: string): string[] {
  const v = value.normalize("NFKC"), out: string[] = [];
  for (const m of v.matchAll(/\[([^[\]]{1,200})\]/g)) if (gapLike(m[1])) out.push(m[0]);
  for (const m of v.matchAll(/\{\{[^{}]{0,200}\}\}/g)) out.push(m[0]); // an unrendered {{ variable }}
  for (const m of v.matchAll(/<(?:add|insert|enter|your|replace|fill)\b[^<>]{0,100}>/gi)) out.push(m[0]);
  for (const m of v.matchAll(/\b(?:TODO|TBD|XXX)\b/g)) out.push(m[0]);
  return [...new Set(out)];
}
