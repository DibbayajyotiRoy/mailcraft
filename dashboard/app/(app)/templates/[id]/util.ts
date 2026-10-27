/** Merge fields a template uses: the declared `variables` list, else every {{ name }} found in its source. */
export function templateVariables(t: any): string[] {
  if (Array.isArray(t?.variables) && t.variables.length) return t.variables.map((v: any) => (typeof v === "string" ? v : v?.name)).filter(Boolean);
  const src = [t?.subject, t?.html, t?.mjml, typeof t?.content === "string" ? t.content : t?.content ? JSON.stringify(t.content) : ""].filter(Boolean).join("\n");
  const found = new Set<string>();
  for (const m of src.matchAll(/\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g)) found.add(m[1]);
  return [...found];
}

export type Lint = { rule?: string; severity?: string; message: string; path?: string };
export const lintSummary = (l: Lint[]) => ({ errors: l.filter((x) => x.severity === "error").length, warnings: l.filter((x) => x.severity !== "error").length });
