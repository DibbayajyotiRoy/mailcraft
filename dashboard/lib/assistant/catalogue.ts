// Reuses the MCP server's tool names, descriptions, schemas and routes (mcp/src/tools.ts, exported to mcp-catalogue.json
// by mcp/test/catalogue.test.ts) instead of re-describing the API. The assistant sends them slimmed down.
import raw from "./mcp-catalogue.json";

export type CatTool = { name: string; description: string; method: string; path: string; mutating: boolean; parameters: Schema };
export type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; description?: string; items?: Schema; enum?: unknown[]; [k: string]: unknown };

export const CAT = new Map<string, CatTool>((raw as unknown as CatTool[]).map((t) => [t.name, t]));

/** First sentence, capped: tool descriptions cost tokens on every request. */
export const oneLine = (s: string, n = 100) => { const f = s.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, " "); return f.length > n ? f.slice(0, n - 1) + "…" : f; };

/** Drops what the model does not need: $schema, idempotency_key, parameter prose, additionalProperties. */
export function slim(s: Schema): Schema {
  const o: Schema = {};
  for (const [k, v] of Object.entries(s)) {
    if (["$schema", "additionalProperties", "description", "minimum", "maximum", "maxLength", "minLength", "maxItems", "minItems", "default", "format", "pattern"].includes(k)) continue;
    if (k === "properties") o.properties = Object.fromEntries(Object.entries(v as Record<string, Schema>).filter(([n]) => n !== "idempotency_key").map(([n, p]) => [n, slim(p)]));
    else if (k === "items" && v && typeof v === "object") o.items = slim(v as Schema);
    else if (k === "required" && Array.isArray(v) && !v.length) continue;
    else o[k] = v;
  }
  return o;
}

export type Call = { method: string; path: string; body?: unknown };

/** Same path templating and GET-query / body split as mcp/src/server.ts `callApi`. */
export function buildCall(def: { method: string; path: string }, args: Record<string, unknown>): Call {
  const a = { ...args };
  const path = def.path.replace(/\{(\w+)\}/g, (_, k) => { const v = encodeURIComponent(String(a[k])); delete a[k]; return v; });
  if (def.method === "GET" || def.method === "DELETE") {
    const qs = new URLSearchParams(Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
    return { method: def.method, path: path + (qs ? "?" + qs : "") };
  }
  return { method: def.method, path, body: a };
}
