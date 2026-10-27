import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, annotations, inputShape, type ToolDef } from "./tools.js";

export interface Opts {
  apiUrl: string;
  /** called per tool call so HTTP mode can use the request's key */
  apiKey: () => string | undefined;
  readOnly?: boolean;
  only?: string[];
}

export const selectTools = (o: Pick<Opts, "readOnly" | "only">): ToolDef[] =>
  TOOLS.filter((t) => (!o.readOnly || !t.mutating) && (!o.only || o.only.includes(t.name)));

const text = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], ...(isError ? { isError: true } : {}) });

export async function callApi(t: ToolDef, args: Record<string, unknown>, o: Opts) {
  const a = { ...args };
  const idem = a.idempotency_key as string | undefined;
  delete a.idempotency_key;
  const path = t.path.replace(/\{(\w+)\}/g, (_, k) => {
    const v = encodeURIComponent(String(a[k]));
    delete a[k];
    return v;
  });
  const hasBody = t.method !== "GET" && t.method !== "DELETE";
  const qs = !hasBody ? new URLSearchParams(Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : "";
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = o.apiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (idem) headers["Idempotency-Key"] = idem;
  if (hasBody) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(o.apiUrl.replace(/\/$/, "") + path + (qs ? "?" + qs : ""), {
      method: t.method, headers, body: hasBody ? JSON.stringify({ ...a, ...t.fixedBody }) : undefined,
    });
    const raw = await res.text();
    let env: any;
    try { env = JSON.parse(raw); } catch { env = { ok: false, error: { code: "bad_response", message: `HTTP ${res.status}: non-JSON response`, retryable: res.status >= 500 } }; }
    if (env === null || typeof env !== "object") env = { ok: res.ok, data: env };
    return text({ ...env, schema: 1 }, env.ok === false || (env.ok === undefined && !res.ok));
  } catch (e) {
    // never include headers/key in the message
    return text({ ok: false, schema: 1, error: { code: "network_error", message: `Cannot reach mailcraft API at ${o.apiUrl}: ${(e as Error).message}`, hint: "Check MAILCRAFT_API_URL and that the server is running.", retryable: true } }, true);
  }
}

export function buildServer(o: Opts): McpServer {
  const s = new McpServer({ name: "mailcraft", version: "0.0.1" });
  for (const t of selectTools(o)) {
    s.registerTool(t.name, { description: t.description, inputSchema: inputShape(t), annotations: annotations(t) }, (args: Record<string, unknown>) => callApi(t, args, o));
  }
  return s;
}
