// GET /api/assistant/mentions: names for the composer's @ menu (templates, lists, automations), fetched with the user's key.
import { read } from "@/lib/assistant/core";
import { auth, json } from "@/lib/assistant/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const a = await auth();
  if (!a) return json(401, { code: "unauthenticated", message: "Sign in first." });
  const ctx = { base: a.base, key: a.key, sid: a.sid, env: "test" as const };
  const [t, l, au] = await Promise.all(["/v1/templates?limit=100", "/v1/segments", "/v1/automations?limit=100"].map((p) => read(ctx, "GET", p)));
  const names = (r: any, f: (x: any) => string) => (Array.isArray(r.data) ? r.data.map(f).filter(Boolean).slice(0, 100) : []);
  return json(200, { template: names(t, (x) => x.alias ?? x.name), list: names(l, (x) => x.name), automation: names(au, (x) => x.name) });
}
