/** Merge fields a template uses: the declared `variables` list, else every {{ name }} found in its source. */
export function templateVariables(t: any): string[] {
  if (Array.isArray(t?.variables) && t.variables.length) return t.variables.map((v: any) => (typeof v === "string" ? v : v?.name)).filter(Boolean);
  const src = [t?.subject, t?.html, t?.mjml, typeof t?.content === "string" ? t.content : t?.content ? JSON.stringify(t.content) : ""].filter(Boolean).join("\n");
  const found = new Set<string>();
  for (const m of src.matchAll(/\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g)) found.add(m[1]);
  return [...found];
}

/** The newest version is not the live one: there is a draft to publish (or to discard). */
export const isUnpublished = (t: any) => t?.version != null && (t.published_version == null || t.version > t.published_version);

export type Lint = { rule?: string; severity?: string; message: string; path?: string };
export const lintSummary = (l: Lint[]) => ({ errors: l.filter((x) => x.severity === "error").length, warnings: l.filter((x) => x.severity !== "error").length });

export type SourceFormat = "html" | "mjml" | "json";
const FORMATS: SourceFormat[] = ["html", "mjml", "json"];

/** What the editor opens: the API's `source` (html/mjml as pasted, else the block tree), falling back to the block tree we already have. */
export function sourceOf(t: any): { format: SourceFormat; text: string } {
  if (FORMATS.includes(t?.source_format) && typeof t?.source === "string") return { format: t.source_format, text: t.source };
  return { format: "json", text: JSON.stringify(t?.template ?? t?.content ?? { version: 1, subject: t?.subject ?? "", blocks: [] }, null, 2) };
}

/** JSON carries its own subject and preheader; mjml always has a preheader slot; html only when it is a fragment (a full document is passed through as-is). */
export const hasSubjectField = (format: SourceFormat) => format !== "json";
export const hasPreheaderField = (format: SourceFormat, body: string) =>
  format === "mjml" || (format === "html" && !/^\s*(<!doctype|<html)/i.test(body));

export type Draft = { format: SourceFormat; body: string; subject: string; preheader: string };

/** The fields PATCH /v1/templates/{id} and POST .../preview share for unsaved content. */
export function contentBody(d: Draft) {
  return {
    format: d.format,
    content: d.body,
    ...(hasSubjectField(d.format) && { subject: d.subject }),
    ...(hasPreheaderField(d.format, d.body) && { preheader: d.preheader }),
  };
}

/** Variables the platform fills at send time (mirrors RESERVED_VARS in mailcraft-templates): the author never supplies them. */
export const PLATFORM_VARS = ["first_name", "last_name", "email", "unsubscribe_url", "preferences_url", "workspace.name"];

/** `{"a.b": "x"}` -> `{a: {b: "x"}}`, so a dotted merge field resolves like `{{ a.b }}`. */
export function nest(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let cur = out;
    for (const p of parts.slice(0, -1)) cur = typeof cur[p] === "object" && cur[p] ? cur[p] : (cur[p] = {});
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

/** Preview values: what the author typed, else a visible `[name]` for their own variables (platform ones keep the server's defaults).
 *  Filling every gap keeps the live lint from flagging variables the preview itself fills in. */
export function sampleVariables(vars: string[], values: Record<string, string>) {
  const flat: Record<string, string> = {};
  for (const v of vars) {
    if (values[v]) flat[v] = values[v];
    else if (!PLATFORM_VARS.includes(v)) flat[v] = `[${v}]`;
  }
  return nest(flat);
}

/** Cheap client-side check so a typo in block JSON never costs a round trip. */
export function jsonError(text: string): string | null {
  try { JSON.parse(text); return null; } catch (e) { return (e as Error).message; }
}

export const API_LIMIT_CHARS = 1_000_000;

/** "Start from blank": a minimal responsive MJML layout with one merge field. */
export const BLANK_MJML = `<mjml>
  <mj-head>
    <mj-title>Your subject here</mj-title>
  </mj-head>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text font-size="22px" font-weight="bold">Hello {{ first_name }}</mj-text>
        <mj-text>Write your message here.</mj-text>
        <mj-button href="https://example.com">Call to action</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
`;

export type Edit = { from: number; to: number; text: string; selStart: number; selEnd: number };

/** Tab / Shift+Tab in the source box. A caret inserts two spaces; a selection (or Shift+Tab) indents / outdents every line it touches. */
export function indentEdit(value: string, start: number, end: number, outdent: boolean): Edit {
  if (!outdent && start === end) return { from: start, to: end, text: "  ", selStart: start + 2, selEnd: start + 2 };
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end; // a selection ending at a line start leaves that line alone
  const nl = value.indexOf("\n", last);
  const to = nl < 0 ? value.length : nl;
  const lines = value.slice(from, to).split("\n");
  const out = lines.map((l) => (outdent ? l.replace(/^ {1,2}/, "") : "  " + l));
  const text = out.join("\n");
  const firstDelta = out[0].length - lines[0].length;
  return { from, to, text, selStart: Math.max(from, start + firstDelta), selEnd: Math.max(from, end + text.length - (to - from)) };
}
