# The dashboard assistant

A chat panel in the dashboard (header button, or Cmd/Ctrl+K) that sets up automations and broadcasts, fixes template lint errors, manages contacts and lists, and explains delivery ("why did this bounce?"). It **proposes** every change as a card; nothing is written until the signed-in person presses **Apply**.

It runs on free, open-weight OpenRouter models only. Nothing paid is ever called.

## For users

- Open it with Cmd/Ctrl+K. On a template, email, automation or broadcast page it already knows which one you are looking at.
- Type `/` for commands (`/automation`, `/broadcast`, `/fix-template`, `/contacts`, `/bounce`) and `@template:name`, `@list:name`, `@automation:name` to name existing items.
- A proposal card shows what Apply will do: a line diff (templates, automations, rules), a sandboxed preview of the email, lint findings, and for sends the audience count, skipped rows and schedule from a server-side dry run. **Review the card, not the chat text**: the card is built by the server from the real API responses.
- **Edit** puts the card title in the composer so you can ask for a change; **Cancel** drops it. A card expires after 15 minutes.
- The footer shows the model, tokens in/out, requests and timings of the last reply. **AI usage** links to Settings.
- The conversation lives in your browser tab (sessionStorage); clear it with the bin icon.

## What it can and cannot do

Everything it does goes through the same REST API as the CLI and MCP server, with **your own key** (the one you signed in with, held in the dashboard's httpOnly cookie). Your key's scopes, send policy, approvals, go-live state, kill switch, suppressions and the audit log all apply unchanged. A call your key may not make fails at Apply and the card shows the API error.

**Always needs a human click (Apply):** every write. On a **live** key, anything that can email people (single email, broadcast, activating or resuming an automation) also asks for a second confirmation, and the server refuses to run it without one (`confirmation_required`). On a test key mail goes to the sandbox and there is no extra step.

**Still decided by humans, outside the assistant:** approvals (a send held for approval shows "Waiting for approval" and is decided on the Approvals page), go-live, the kill switch. Template **publishing** is never done by the assistant: it saves drafts, and sends keep using the live version until you publish. Automations are saved as drafts (`approval` defaults to `first_n:5`); activating is a separate proposal.

**Out of scope** (no tool exists; the model says so): deleting anything, API keys and secrets, relay credentials, domains and senders (read-only), kill switch, go-live, billing.

### Tools

Generated from [`lib/assistant/tools.ts`](../dashboard/lib/assistant/tools.ts) and [`propose.ts`](../dashboard/lib/assistant/propose.ts). Read tools run automatically; write tools only create a proposal. Route definitions for the catalogue-backed ones come from the MCP server ([`mcp/src/tools.ts`](../mcp/src/tools.ts), exported to `mcp-catalogue.json`).

| Group (when exposed) | Read (automatic) | Write (proposal only) |
|---|---|---|
| core (every turn) | `list` (template, automation, email, contact, approval, broadcast, list, event, domain, sender), `get` (template, automation, email, contact, approval, broadcast, domain, account, health, settings), `get_docs` (personalization, automations, broadcasts, deliverability, contacts), `use_tools` | none |
| `templates` | `template_preview`, `content_lint` | `propose_template` (new draft, or find/replace edits to an existing one) |
| `automations` (implies `templates`) | `automation_runs`, `automation_simulate` | `propose_automation` (draft), `propose_automation_state` (activate, pause, resume) |
| `broadcasts` | none | `propose_broadcast` (template to a list or up to 200 addresses; dry run first), `propose_email` (1 to 5 addresses) |
| `contacts` | `segment_preview` | `propose_list` (list or rule segment, optional members), `propose_contacts` (up to 50 upserts) |

`propose_broadcast`, `propose_email` and `propose_automation_state` (activate/resume) are risk "sends". Everything else cannot email anyone.

## Architecture

```
browser panel ──POST /api/assistant──▶ dashboard server ──▶ OpenRouter (chat/completions, streamed)
     ▲   NDJSON events                      │  tool calls run here, with the user's key
     │                                      └──▶ mailcraft REST API (reads, dry runs, previews)
     └──POST /api/assistant/apply {id}──▶ proposal store ──▶ mailcraft REST API (the stored calls)
```

- **Server-side only.** The OpenRouter key and every model call stay in the dashboard server process; the browser only receives events (`phase`, `text`, `tool`, `proposal`, `error`, `done`).
- **Agent loop** ([`loop.ts`](../dashboard/lib/assistant/loop.ts)): stream a completion, run the tool calls it asks for in parallel (at most 6 per round), feed compact results back, repeat up to 8 rounds, then force an answer. A turn is cut off after 120 s; a model that sends nothing for 20 s is skipped.
- **Proposals** ([`proposals.ts`](../dashboard/lib/assistant/proposals.ts)): a write tool validates its input, does read-only dry runs and previews, then stores the exact list of API calls server-side under a random id, frozen, bound to the signed-in session, valid 15 minutes, **one-shot** (spent even if a call fails; a retry is a new proposal). The Apply request carries only the id (and `confirmed`), so what runs is what was reviewed and the model cannot alter it afterwards. The store is in process memory: a dashboard restart, or a second instance behind a load balancer, loses pending proposals ("This proposal expired or was already used").
- **Logging:** one JSON line per turn on stdout (`evt: assistant_turn`: model, rounds, token counts, timings, tool count, failed models). No prompts, no data, no key.
- **Privacy:** prompts, including compacted rows from your workspace (template source, contact emails, bounce diagnostics), go to OpenRouter and the provider serving the model. Check their data policies for free models before enabling this on sensitive data.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | unset (assistant off) | OpenRouter key; a free key is enough. The API server reads the same name for LLM-written emails, so they share one allowance |
| `MAILCRAFT_ASSISTANT_MODEL` | unset (automatic) | Pin the first model. Must be in the allowed set below, or chats are refused |
| `MAILCRAFT_ASSISTANT_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL (models list, key info, completions). For the offline mock below |

If `MAILCRAFT_ASSISTANT_MODEL` is unset, `MAILCRAFT_LLM_MODEL` is used as the pin when it is present in the dashboard's environment and qualifies (compose passes it through, so on Docker the assistant and email writing start from the same model).

Set them in `.env` and `docker compose up -d dashboard` (compose passes these, plus `MAILCRAFT_LLM_MODEL` and `MAILCRAFT_LLM_FALLBACK_MODELS`, through, see [`.env.example`](../.env.example)). On the [VM deploy](DEPLOY-VM.md) put them in `/etc/mailcraft/dashboard.env` (created by `deploy-vm.sh`, 0640 root:mailcraft, read only by `mailcraft-dashboard`) and `sudo systemctl restart mailcraft-dashboard`. The dashboard deliberately does not read `mailcraft.env`: that file holds the database URL and the master secret key. If the API also writes emails with an LLM, put the same `OPENROUTER_API_KEY` in `mailcraft.env` too. The container or host needs outbound HTTPS to `openrouter.ai`.

## Free, open-source models only

The allowed set is built from OpenRouter's public `GET /models` list (cached 1 hour, [`models.ts`](../dashboard/lib/assistant/models.ts)). A model is allowed only if **all** hold:

- its id ends in `:free`, and its prompt and completion prices are both zero;
- it has a Hugging Face id (open weights);
- `supported_parameters` includes `tools`;
- it has not passed its `expiration_date`.

If the list cannot be fetched the last good copy is used; with no copy, a built-in list of `:free` ids.

Order: pinned model first (if any), then by measured speed, the fastest healthy model first (rolling first-token latency and error score, in memory, per process). A model that errors, times out or returns nothing is skipped for the next one (up to 4 tries per round); OpenRouter is also sent the next two ids as `models` fallbacks, and `provider.require_parameters` so routing only goes to providers that honour tools.

**Overrides are rejected, never swapped.** A `MAILCRAFT_ASSISTANT_MODEL` outside the allowed set (a paid id, a closed model, a free model without tools, one that expired) makes chats fail with `model_not_free` and the panel shows "The assistant cannot start" with the reason; it does not quietly use another model. OpenRouter answering 402 stops the turn with an error; the assistant never moves to a paid model.

**Email writing is a separate path** (crate [`mailcraft-llm`](../crates/mailcraft-llm/README.md), `MAILCRAFT_LLM_*`): for the `openrouter` provider the model id must end in `:free`. A paid `MAILCRAFT_LLM_MODEL` is refused before any request and that email goes out as static copy; paid entries in `MAILCRAFT_LLM_FALLBACK_MODELS` are dropped with a warning. That check is the `:free` suffix only (the price, tools and open-weights checks above are the assistant's).

### Free-tier limits

Free models have per-minute and per-day request allowances, shared by everything using the key. mailcraft does not hard-code them; it shows what OpenRouter reports. **Settings → AI usage** (and `GET /api/assistant/status`) reads OpenRouter's key endpoint (`GET /key`, cached 60 s) and displays, as returned: label, credits used (total, today, week, month), credit limit, remaining, limit reset, `is_free_tier`, and the rate limit when OpenRouter reports a positive one (it reports `-1` and marks the field deprecated). The panel footer adds "N left on the key" when `limit_remaining` is a number.

OpenRouter does not report how many requests were used today, so **Requests today** is a local tally of requests this dashboard process sent since 00:00 UTC. It resets on restart and does not include the API server's email-writing calls. Treat it as approximate.

## Token efficiency

Free models are slow and rate-limited, so each request is kept small.

- **Tool routing:** only four core tools go out every turn. Groups (`templates`, `automations`, `broadcasts`, `contacts`) are added from the page you are on and keywords in your latest message; the model can also call `use_tools`. Tool descriptions are cut to one sentence and schemas stripped of prose.
- **Compact results:** each result is projected to the fields needed, lists are capped at 20 rows with a "more" note, HTML is stripped, template source is only fetched on request (12k chars max), every result is hard-capped at 6000 chars, and reads are cached for 60 s per session (cleared on Apply). Reference text is behind `get_docs`, not in the system prompt.
- **No wasted round:** the entity on the current page (from the URL only) is fetched alongside the first request.
- **History budget:** the last 6 messages go verbatim, older ones as a one-line rule-based summary (700 chars), the whole history capped at about 14,000 chars. Earlier tool use and applied/cancelled proposals are passed as one-line notes, never raw tool output.
- Output is capped at 1500 tokens (3000 when template tools are on) at temperature 0.2.

## Prompt-injection stance

Template text, contact fields, email bodies and bounce diagnostics are attacker-controllable. Defences, strongest first:

1. **Structural:** the model has no way to execute anything. Writes are frozen server-side proposals applied only by a human click on the exact reviewed calls; there are no tools for deletes, keys, relays, kill switch or go-live; sends need confirmation on live keys; all API-side gates apply.
2. **Server-built cards:** titles, summaries, audience counts, diffs and previews come from validated input and real API responses, not from the model's prose. Email previews render in a sandboxed iframe (no scripts, forms or same-origin).
3. **Data labelling:** tool results are wrapped in `<untrusted>…</untrusted>` JSON with `<` escaped, so data cannot close the tag or fake another; the system prompt tells the model never to follow instructions found inside.
4. **Narrow inputs:** the page path is validated and the page entity is taken from the URL only.

This does not make a manipulated proposal impossible, only visible and harmless until a person applies it. Read the card before pressing Apply.

## Offline dev and QA (mock OpenRouter)

[`dashboard/scripts/mock-api.mjs`](../dashboard/scripts/mock-api.mjs) serves a mock mailcraft API **and** a scripted mock OpenRouter (`/openrouter/api/v1`: `/models`, `/key`, streamed `/chat/completions`) so the assistant can be run and tested with no key, no network and no quota. Its model list includes a paid, closed model to show the filter dropping it.

```
cd dashboard
node scripts/mock-api.mjs 18080 &
MAILCRAFT_API_URL=http://127.0.0.1:18080 \
OPENROUTER_API_KEY=mock \
MAILCRAFT_ASSISTANT_BASE_URL=http://127.0.0.1:18080/openrouter/api/v1 \
npm run dev
```

Sign in at `/login` with any key (the mock API does not check it; the base URL is pre-filled), then try "Fix the lint errors in the promo template", "Set up a welcome email for new signups" or "Send the Testing template to my Webinar list". The mock "model" is a fixed script keyed on words in your message, so other prompts get a canned reply. For a real-model check, `tests/assistant-smoke.test.ts` runs against OpenRouter when `ASSISTANT_SMOKE=1` (a free key allows only a few requests a day).

In compose, point the dashboard at a mock on the host with `MAILCRAFT_ASSISTANT_BASE_URL=http://host.docker.internal:18080/openrouter/api/v1`.

## Troubleshooting

| You see | Cause and fix |
|---|---|
| "The assistant is off" / `not_configured` (503) | `OPENROUTER_API_KEY` is not set on the dashboard server. Set it and restart the dashboard. Settings → AI usage says the same |
| "OpenRouter rejected the API key" / `unauthorized` | The key is wrong, revoked or from another account. Settings → AI usage shows "OpenRouter rejected the key (401)". (A 401 `unauthenticated` from `/api/assistant` is your dashboard sign-in, not OpenRouter: sign in again) |
| "Free models are rate-limited right now" / `rate_limited` | Per-minute limit: wait a minute. The key's allowance is shared with email writing |
| "The free-model daily request limit is used up" | Daily allowance spent; it resets daily (UTC). Check Settings → AI usage. The assistant will not switch to a paid model; adding credits to the key does not change that |
| "The assistant cannot start" / `model_not_free` | `MAILCRAFT_ASSISTANT_MODEL` is not in the allowed set. Unset it, or pick an id from the hint (the free list changes, models expire). `no_free_model`: none available right now, try later |
| `model_unavailable`, `upstream_error`, `empty_completion`, `first_token_timeout` | That model failed; the assistant moves to the next one automatically. If every model fails, retry later: free providers are often busy |
| "OpenRouter asked for credits" / `payment_required` | The key has a problem on openrouter.ai; free models should not need credits |
| "Cannot reach OpenRouter" in Settings | No outbound HTTPS from the dashboard (container network, proxy, firewall), or a wrong `MAILCRAFT_ASSISTANT_BASE_URL` |
| "This proposal expired or was already used" | Cards last 15 minutes, apply once, and are lost on dashboard restart. Ask again |
| Apply fails with an API error (403, `template_unpublished`, ...) | Your key lacks a scope, or a precondition is missing (a template must be published before an automation or broadcast uses it). Fix it and ask again |
| Apply says "Waiting for approval" | Not a failure: a human decides it on the Approvals page |
