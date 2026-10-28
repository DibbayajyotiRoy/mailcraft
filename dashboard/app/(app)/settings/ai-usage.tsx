import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { allowedModels, resolveModels } from "@/lib/assistant/models";
import { keyInfo, requestsToday } from "@/lib/assistant/usage";

/** What the mailcraft-llm crate falls back to when MAILCRAFT_LLM_MODEL is unset (crates/mailcraft-llm/src/config.rs DEFAULT_MODEL). */
export const EMAIL_DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";

const LABEL: Record<string, string> = {
  label: "Key", usage: "Credits used", usage_daily: "Used today", usage_weekly: "Used this week", usage_monthly: "Used this month",
  limit: "Credit limit", limit_remaining: "Remaining", limit_reset: "Limit resets", is_free_tier: "Free tier",
};
const show = (v: unknown) => (v === null ? "none" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

function Model({ id, note }: { id: string; note?: string }) {
  const free = id.endsWith(":free");
  return <li className="flex flex-wrap items-center gap-2"><code className="break-all font-mono text-xs">{id}</code>{free ? <Badge tone="ok" size="sm">free</Badge> : <Badge tone="bad" size="sm">not free: refused</Badge>}{note && <span className="text-xs text-muted">{note}</span>}</li>;
}

/** Settings card: which free models the assistant and email writing use, and the OpenRouter key's own numbers (server-side; the key is never shown). */
export async function AiUsageCard({ emailModel }: { emailModel?: string | null }) {
  const [key, allowed] = await Promise.all([keyInfo(), allowedModels()]);
  const m = resolveModels(process.env, allowed);
  const d = key.ok ? key.data : null;
  const rate = d && typeof d.rate_limit === "object" && d.rate_limit && Number((d.rate_limit as { requests?: number }).requests) > 0 ? (d.rate_limit as { requests: number; interval: string }) : null; // OpenRouter reports -1 and marks the field deprecated
  return (
    <Card id="ai-usage" aria-labelledby="ai-usage-h" className="scroll-mt-20">
      <CardHeader title={<span id="ai-usage-h">AI usage</span>} description="The assistant and email writing use free, open-weight OpenRouter models only. Nothing paid is ever used." />
      <CardBody className="grid gap-5">
        <section aria-labelledby="ai-models-h">
          <h3 id="ai-models-h" className="text-sm font-medium">Models</h3>
          <div className="mt-2 grid gap-3 text-sm">
            <div>
              <p className="text-muted">Assistant{m.ok ? m.overridden ? " (pinned by MAILCRAFT_ASSISTANT_MODEL)" : " (fastest healthy first)" : ""}</p>
              {m.ok ? (
                <ul className="mt-1 grid gap-1">{m.chain.slice(0, 3).map((id, i) => <Model key={id} id={id} note={i === 0 ? "first choice" : "fallback"} />)}</ul>
              ) : <p role="alert" className="mt-1 rounded-md bg-bad-bg px-3 py-2 text-bad">{m.message} {m.hint}</p>}
              <p className="mt-1 text-xs text-muted">{allowed.source === "openrouter" ? `Allowed set: ${allowed.ids.length} models that are free, open-weight and support tools, from OpenRouter's public list (cached for an hour).` : "OpenRouter's model list could not be fetched; using the built-in free list."}</p>
            </div>
            <div>
              <p className="text-muted">Email writing</p>
              <ul className="mt-1 grid gap-1"><Model id={emailModel || EMAIL_DEFAULT_MODEL} note={emailModel ? undefined : "default, plus free fallbacks"} /></ul>
              {emailModel && !emailModel.endsWith(":free") && <p className="mt-1 text-xs text-bad">A model that is not free is never called. Generated emails use their static copy until this is changed (MAILCRAFT_LLM_MODEL or the LLM provider above).</p>}
            </div>
          </div>
        </section>

        <section aria-labelledby="ai-key-h">
          <h3 id="ai-key-h" className="text-sm font-medium">OpenRouter key</h3>
          {key.ok ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {Object.entries(key.data).filter(([k]) => k !== "rate_limit").map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{LABEL[k] ?? k}</dt><dd className="break-all tabular-nums">{show(v)}</dd></div>)}
              {rate && <div className="contents"><dt className="text-muted">Rate limit</dt><dd className="tabular-nums">{rate.requests} requests per {rate.interval}</dd></div>}
              <div className="contents"><dt className="text-muted">Requests today</dt><dd className="tabular-nums">{requestsToday()} <span className="text-xs text-muted">sent by this dashboard since midnight UTC; a local tally, approximate</span></dd></div>
            </dl>
          ) : (
            <p role="status" className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
              {key.message}{key.reason === "no_key" && <> Set <code className="font-mono">OPENROUTER_API_KEY</code> on the dashboard server and restart it; a free key is enough.</>}
            </p>
          )}
          <p className="mt-3 text-sm text-muted">
            {d?.is_free_tier === false
              ? "This key has credits, but mailcraft still only calls free models."
              : `Free models have a small allowance of requests per day and per minute, shared by everything that uses this key. When it runs out the assistant says so and tries again after the reset; it never switches to a paid model.${key.ok ? ' OpenRouter does not report how many requests were used today, so the count above is this dashboard\'s own.' : ""}`}
          </p>
        </section>
      </CardBody>
    </Card>
  );
}
