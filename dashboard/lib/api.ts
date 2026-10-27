// The only place the dashboard talks to the REST API. Server-side only (reads the httpOnly cookies).
import { cookies } from "next/headers";

export type ApiError = { code: string; message: string; hint?: string; doc_url?: string; field?: string };
export type ApiResult<T = any> = { data: T | null; error: ApiError | null; next_cursor?: string | null };

export const DEFAULT_BASE = process.env.MAILCRAFT_API_URL || "http://localhost:8080";

/** Pure: one call, envelope unwrapped, never throws. */
export async function request<T = any>(
  base: string, key: string, method: string, path: string, body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  let res: Response;
  try {
    res = await fetch(base.replace(/\/+$/, "") + path, {
      method, headers, cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { data: null, error: { code: "unreachable", message: `Cannot reach ${base}: ${(e as Error).message}`, hint: "Check the API base URL and that the server is running." } };
  }
  let j: any;
  try { j = await res.json(); } catch {
    return { data: null, error: { code: "bad_response", message: `HTTP ${res.status} with a non-JSON body`, hint: "Is the base URL pointing at the mailcraft API?" } };
  }
  if (j && j.ok === true) return { data: j.data as T, error: null, next_cursor: j.next_cursor ?? null };
  const e = j?.error;
  return { data: null, error: e?.code ? e : { code: `http_${res.status}`, message: e?.message ?? "Unexpected response shape" } };
}

export async function session() {
  const c = await cookies();
  const key = c.get("mc_key")?.value;
  return key ? { key, base: c.get("mc_base")?.value || DEFAULT_BASE } : null;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const s = await session();
  if (!s) return { data: null, error: { code: "unauthenticated", message: "Not signed in", hint: "Sign in at /login." } };
  return request<T>(s.base, s.key, method, path, body);
}

export const get = <T = any>(path: string) => api<T>("GET", path);
