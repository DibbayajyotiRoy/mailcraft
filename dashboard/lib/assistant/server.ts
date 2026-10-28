// Glue for the /api/assistant routes: the signed-in session as the assistant's identity, and the env it acts in.
import { request, session } from "@/lib/api";
import type { Ctx } from "./core";
import { sessionId } from "./proposals";

export const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The assistant acts as the logged-in user: every call carries their own session key, so scopes and gates apply unchanged. */
export async function auth(): Promise<(Omit<Ctx, "env"> & { env: () => Promise<Ctx["env"]> }) | null> {
  const s = await session();
  if (!s) return null;
  const sid = sessionId(s.key, s.base);
  // Unknown env (API down) is treated as live: the extra confirmation is the safe direction.
  return { base: s.base, key: s.key, sid, env: async () => { const r = await request(s.base, s.key, "GET", "/v1/account/status", undefined, 5000); return r.data?.env === "test" ? "test" : "live"; } };
}
