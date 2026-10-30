// Draft editing for one send: apply natural-language edits to rendered email HTML without touching the template.
// Uses a short non-streaming LLM call to interpret instructions like "remove the benefits section".
import { BASE, allowedModels, resolveModels } from "./models";
import { apiKey } from "./usage";
import type { Ctx } from "./core";

export type DraftEdit = { instruction: string; applied: boolean; note?: string };
export type DraftState = {
  original: string;
  current: string;
  edits: DraftEdit[];
  /** True when the last instruction could not be matched (the card says so). */
  unmatched?: boolean;
};

const MAX_HTML = 120_000;
const MAX_OUTPUT = 80_000;

function trunc(html: string) {
  if (html.length <= MAX_HTML) return html;
  const head = html.slice(0, MAX_HTML / 2);
  const tail = html.slice(-MAX_HTML / 2);
  return `${head}\n<!-- …${html.length - MAX_HTML} characters omitted… -->\n${tail}`;
}

/** Ask a cheap, fast model to apply one edit instruction to the email HTML. Returns the new HTML and whether it looks applied. */
export async function applyDraftEdit(ctx: Ctx, current: string, instruction: string): Promise<{ html: string; applied: boolean; note?: string }> {
  const key = apiKey();
  if (!key) return { html: current, applied: false, note: "The assistant model is not configured." };
  const models = resolveModels(process.env, await allowedModels());
  if (!models.ok) return { html: current, applied: false, note: "The assistant model is not available right now." };
  const model = models.chain[0];
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You edit email HTML for a single send. Apply the user's instruction to the HTML. " +
          "Return ONLY a JSON object with keys: html (the full edited HTML), applied (boolean), note (optional short reason if the instruction could not be applied, e.g. the section was not found). " +
          "Do not wrap the JSON in markdown. Preserve all variables like {{ first_name }} and all unsubscribe links. " +
          "If the instruction asks to remove something that is not present, set applied=false and note='That section was not found in the email.'",
      },
      {
        role: "user",
        content: `Instruction: ${instruction}\n\nHTML:\n${trunc(current)}\n\nReturn JSON with html, applied, note.`,
      },
    ],
    temperature: 0.2,
    max_tokens: 4096,
    response_format: { type: "json_object" },
  };
  const res = await fetch(`${BASE()}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/DibbayajyotiRoy/mailcraft", "X-Title": "mailcraft" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content ?? "";
  let parsed: { html?: string; applied?: boolean; note?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { html: current, applied: false, note: "The model did not return valid JSON." };
  }
  const html = typeof parsed.html === "string" && parsed.html.length > 0 ? parsed.html.slice(0, MAX_OUTPUT) : current;
  const applied = Boolean(parsed.applied) && html !== current;
  return { html, applied, note: applied ? undefined : (parsed.note ?? "That change could not be applied.") };
}

/** Apply a list of edit instructions sequentially, tracking each one. */
export async function applyDraftEdits(ctx: Ctx, original: string, instructions: string[]): Promise<DraftState> {
  let current = original;
  const edits: DraftEdit[] = [];
  for (const instruction of instructions) {
    const { html, applied, note } = await applyDraftEdit(ctx, current, instruction);
    edits.push({ instruction, applied, note });
    current = html;
  }
  const unmatched = edits.length > 0 && !edits[edits.length - 1].applied;
  return { original, current, edits, unmatched };
}

/** Remove the last applied edit by replaying all but the last instruction. */
export async function undoLastDraftEdit(ctx: Ctx, state: DraftState): Promise<DraftState> {
  const applied = state.edits.filter((e) => e.applied);
  const last = applied.at(-1);
  if (!last) return { ...state, edits: [...state.edits, { instruction: "undo last change", applied: false, note: "Nothing to undo." }] };
  const keep = state.edits.slice(0, state.edits.indexOf(last));
  return applyDraftEdits(ctx, state.original, keep.map((e) => e.instruction));
}

/** Reset to the original template-rendered HTML. */
export function resetDraft(original: string): DraftState {
  return { original, current: original, edits: [{ instruction: "start from the template again", applied: true, note: "Reset to the template." }] };
}

/** Build a short, human-readable summary of what changed. */
export function draftSummary(state: DraftState): string {
  const applied = state.edits.filter((e) => e.applied);
  const failed = state.edits.filter((e) => !e.applied);
  const parts: string[] = [];
  if (applied.length) parts.push(applied.map((e) => `“${e.instruction}”`).join("; "));
  if (failed.length) parts.push(`not found: ${failed.map((e) => `“${e.instruction}”`).join(", ")}`);
  return parts.join("; ") || "No edits yet.";
}

const UNDO_RE = /^(undo|revert|remove|delete)\s+(the\s+)?last\s+(change|edit|update)/i;
const RESET_RE = /^(start\s+from\s+(the\s+)?template\s+again|reset\s+(the\s+)?draft|start\s+over)/i;

/** Interpret meta-instructions like "undo the last change" or "start from the template again". */
export function normalizeDraftEdits(prev: DraftState | undefined, edits: string[]): { instructions: string[]; reset: boolean; undo: boolean } {
  let reset = false, undo = false;
  const normalized: string[] = [];
  for (const e of edits) {
    if (RESET_RE.test(e)) { reset = true; continue; }
    if (UNDO_RE.test(e)) { undo = true; continue; }
    normalized.push(e);
  }
  if (reset) return { instructions: [], reset: true, undo: false };
  if (undo && prev) {
    const applied = prev.edits.filter((e) => e.applied);
    const keep = applied.slice(0, -1).map((e) => e.instruction);
    return { instructions: [...keep, ...normalized], reset: false, undo: true };
  }
  return { instructions: normalized, reset: false, undo: false };
}
