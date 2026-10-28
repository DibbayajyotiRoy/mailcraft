// GET /api/assistant/status: is the assistant enabled, which free models it will use, and the OpenRouter usage line.
import { allowedModels, resolveModels } from "@/lib/assistant/models";
import { auth, json } from "@/lib/assistant/server";
import { apiKey, freeToday, keyInfo, requestsToday } from "@/lib/assistant/usage";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await auth())) return json(401, { code: "unauthenticated", message: "Sign in first." });
  if (!apiKey()) return json(200, { configured: false });
  const [m, k] = [resolveModels(process.env, await allowedModels()), await keyInfo()];
  return json(200, { configured: true, model: m.ok ? { chain: m.chain.slice(0, 3), source: m.source } : { error: m }, key: k.ok ? { is_free_tier: k.data.is_free_tier, usage: k.data.usage, limit_remaining: k.data.limit_remaining } : { error: k.message }, requests_today: requestsToday(), free: freeToday() }); // after keyInfo(): freeToday() reads its cache
}
