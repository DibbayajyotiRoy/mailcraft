// How a streamed field lands in the New email form, and how "Undo AI" takes it back (pure: unit-tested).
import type { Compose } from "@/lib/compose";

export type Snap = Pick<Compose, "subject" | "text" | "html" | "vars">;
export const snapshot = (c: Compose): Snap => ({ subject: c.subject, text: c.text, html: c.html, vars: { ...c.vars } });

/** The first delta of a field replaces what was in the box; the rest append. A field that gets no delta is left alone. */
export function applyField(c: Compose, field: string, chunk: string, replace: boolean): Compose {
  if (field.startsWith("var:")) { const k = field.slice(4); return { ...c, vars: { ...c.vars, [k]: (replace ? "" : c.vars[k] ?? "") + chunk } }; }
  if (field === "subject" || field === "text" || field === "html") return { ...c, [field]: (replace ? "" : c[field]) + chunk };
  return c;
}

/** Puts back the pre-AI value of every field the AI wrote. A variable that had no value goes back to having none. */
export function restoreFields(c: Compose, snap: Snap, touched: Iterable<string>): Compose {
  let out = c;
  for (const f of touched) {
    if (f.startsWith("var:")) { const vars = { ...out.vars }, k = f.slice(4); if (k in snap.vars) vars[k] = snap.vars[k]; else delete vars[k]; out = { ...out, vars }; }
    else if (f === "subject" || f === "text" || f === "html") out = { ...out, [f]: snap[f] };
  }
  return out;
}

const body = (f: string) => f === "text" || f === "html";
export const writingLabel = (f: string) => (f === "subject" ? "Writing subject…" : body(f) ? "Writing body…" : `Filling ${f.slice(4)}…`);
export const doneLabel = (f: string) => (f === "subject" ? "Subject written" : body(f) ? "Message written" : `${f.slice(4)} filled`);
export const shortName = (f: string) => (f === "subject" ? "Subject" : body(f) ? "Message" : f.slice(4));
