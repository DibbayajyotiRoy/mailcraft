import { ruleWords } from "../../_p3/rules";

export type Step = { key: string; type: string; config?: any; next?: string | Record<string, string> | null };
export type Slot = { name: string; max_len?: number; instructions?: string; fallback?: string };

/** The trigger is "the first step" in the stored definition; older rows only carry a top-level `trigger`. */
export function flowSteps(a: any): Step[] {
  const steps: Step[] = Array.isArray(a?.steps) ? a.steps : [];
  if (steps[0]?.type === "trigger") return steps;
  const t = a?.trigger;
  const cfg = typeof t === "string" ? { event: t } : t && typeof t === "object" ? t : null;
  return cfg ? [{ key: "trigger", type: "trigger", config: cfg }, ...steps] : steps;
}

/** Slots live in the template's blocks, not on the step. */
export function slotsOf(template: any): Slot[] {
  let c = template?.content ?? template;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch { return []; } }
  const blocks: any[] = Array.isArray(c?.blocks) ? c.blocks : [];
  return blocks.filter((b) => b?.type === "slot" && b.name).map((b) => ({ name: b.name, max_len: b.max_len, instructions: b.instructions, fallback: b.fallback }));
}

export const durationWords = (d?: string) => {
  const m = /^(\d+)\s*([smhdw])$/.exec(d ?? "");
  if (!m) return d ?? "";
  const unit = { s: "second", m: "minute", h: "hour", d: "day", w: "week" }[m[2]]!;
  return `${m[1]} ${unit}${m[1] === "1" ? "" : "s"}`;
};

export function triggerWords(cfg: any): string {
  const evs: string[] = [cfg?.event, ...(cfg?.events ?? [])].filter(Boolean);
  const base = evs.length ? `A contact triggers ${evs.map((e) => `“${e}”`).join(" or ")}` : cfg?.segment ? `A contact enters segment “${cfg.segment}”` : "A contact enters";
  const f = ruleWords(cfg?.filter);
  return f ? `${base}, when ${f}` : base;
}

export const branchLabels = (n: Step["next"]): [string, string][] => (n && typeof n === "object" ? Object.entries(n) : []);
