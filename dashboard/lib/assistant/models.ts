// Free, open-weight, tool-capable OpenRouter models only. The allowed set comes from OpenRouter's public models list
// (cached 1h); a model outside it is never used, and an explicit override outside it is rejected, never swapped.
export const BASE = () => (process.env.MAILCRAFT_ASSISTANT_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");

/** Best first. Used as the default order and as the list when OpenRouter's catalogue cannot be fetched. */
export const PREFERRED = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "thinkingmachines/inkling:free",
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-lightning:free",
  "google/gemma-4-26b-a4b-it:free",
];

type Entry = { id: string; hugging_face_id?: string | null; pricing?: Record<string, string>; supported_parameters?: string[]; expiration_date?: string | null };

/** free (`:free` + zero prompt and completion price) AND open weights (has a Hugging Face id) AND can call tools. */
export function freeToolModels(list: Entry[], now = Date.now()): string[] {
  const zero = (v: unknown) => v === "0" || v === 0 || v === "0.0";
  return list
    .filter((m) => m.id.endsWith(":free") && zero(m.pricing?.prompt) && zero(m.pricing?.completion)
      && !!m.hugging_face_id && !!m.supported_parameters?.includes("tools")
      && !(m.expiration_date && Date.parse(m.expiration_date) < now))
    .map((m) => m.id);
}

export type Allowed = { ids: string[]; source: "openrouter" | "builtin" };
const g = globalThis as unknown as { __mcModels?: { at: number; v: Allowed } };

export async function allowedModels(fetchImpl: typeof fetch = fetch): Promise<Allowed> {
  const c = g.__mcModels;
  if (c && Date.now() - c.at < 3_600_000) return c.v;
  try {
    const r = await fetchImpl(`${BASE()}/models`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    const ids = freeToolModels(((await r.json()) as { data: Entry[] }).data);
    if (!r.ok || !ids.length) throw new Error("empty");
    g.__mcModels = { at: Date.now(), v: { ids, source: "openrouter" } };
  } catch {
    if (c) return c.v; // stale beats guessing
    return { ids: PREFERRED, source: "builtin" }; // every entry is `:free` by construction
  }
  return g.__mcModels!.v;
}

// Rolling first-token latency / error score per model, in memory: the fastest healthy model goes first.
const scores = ((globalThis as any).__mcScores ??= new Map<string, { ms: number; err: number }>()) as Map<string, { ms: number; err: number }>;
export function recordModel(id: string, ttftMs: number | null) {
  const s = scores.get(id) ?? { ms: ttftMs ?? 8000, err: 0 };
  if (ttftMs == null) s.err = s.err * 0.7 + 0.3;
  else { s.ms = s.ms * 0.6 + ttftMs * 0.4; s.err *= 0.7; }
  scores.set(id, s);
}
export const resetScores = () => scores.clear();
const score = (id: string, i: number) => { const s = scores.get(id); return s ? s.ms + s.err * 20_000 : 1500 + i * 1500; };

export type Resolved = { ok: true; chain: string[]; source: Allowed["source"]; overridden: boolean } | { ok: false; code: string; message: string; hint: string };

/** `MAILCRAFT_ASSISTANT_MODEL` (else `MAILCRAFT_LLM_MODEL` if it qualifies) pins the first model; the rest follow by measured speed. */
export function resolveModels(env: Record<string, string | undefined>, allowed: Allowed): Resolved {
  const ok = new Set(allowed.ids);
  const want = env.MAILCRAFT_ASSISTANT_MODEL?.trim();
  if (want && !ok.has(want)) {
    return { ok: false, code: "model_not_free", message: `MAILCRAFT_ASSISTANT_MODEL "${want}" is not an allowed model.`,
      hint: `The assistant only uses free, open-weight models that support tools (${allowed.source === "openrouter" ? "from OpenRouter's live list" : "OpenRouter's list could not be fetched; built-in list"}). Unset it or pick one, e.g. ${allowed.ids[0]}.` };
  }
  const shared = env.MAILCRAFT_LLM_MODEL?.trim();
  const pin = want || (shared && ok.has(shared) ? shared : undefined);
  const order = [...PREFERRED.filter((m) => ok.has(m)), ...allowed.ids.filter((m) => !PREFERRED.includes(m))];
  const rest = order.filter((m) => m !== pin).map((m, i) => [m, i] as const).sort((a, b) => score(a[0], a[1]) - score(b[0], b[1])).map(([m]) => m);
  const chain = pin ? [pin, ...rest] : rest;
  return chain.length ? { ok: true, chain, source: allowed.source, overridden: !!want } : { ok: false, code: "no_free_model", message: "No free tool-capable model is available right now.", hint: "Try again later." };
}
