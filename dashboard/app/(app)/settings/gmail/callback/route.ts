import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { withFlash } from "@/lib/flash";

/** Google redirects here with ?code&state; finish the OAuth exchange, then land back on Settings with a toast. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const back = (p: string) => NextResponse.redirect(new URL(p, req.nextUrl.origin));
  if (q.get("error") || !q.get("code") || !q.get("state")) return back(`/settings?err=${encodeURIComponent(`gmail_denied|Gmail was not connected: ${q.get("error") ?? "no authorization code"}|You can try again from Settings.`)}#delivery`);
  const r = await api("POST", "/v1/transports/gmail/oauth/complete", { state: q.get("state"), code: q.get("code"), redirect_uri: `${req.nextUrl.origin}/settings/gmail/callback` });
  if (r.error) return back(`/settings?err=${encodeURIComponent(`${r.error.code}|${r.error.message}|${r.error.hint ?? ""}`)}#delivery`);
  return back(`${withFlash("/settings", `Gmail connected${r.data?.from ? ` as ${r.data.from}` : ""}.`)}#delivery`);
}
