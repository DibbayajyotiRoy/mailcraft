# Integrate mailcraft with your product

How a product (your SaaS, app or internal tool) talks to mailcraft: push events from your backend, optionally let
mailcraft pull your contact list, pick who the mail comes from, and stay on the right side of consent. Nothing here is
specific to one kind of product. Replace `mail.example.com` with wherever your mailcraft API runs.

> Pre-alpha. Routes are listed in [openapi.yaml](../openapi.yaml), which is the source of truth. Sections marked
> **Coming** describe work that is not on `main` yet.

Contents: [Concepts](#1-concepts) · [Push events](#2-push-events-from-your-backend) · [Let mailcraft pull your contacts](#3-let-mailcraft-pull-your-contact-list) ·
[Senders](#4-senders) · [Consent and compliance](#5-consent-and-compliance) · [Testing](#6-testing-before-anyone-gets-real-mail) · [Agents and MCP](#7-agents-mcp-and-the-assistant)

## The short version

1. A human creates one API key per connected product (`send` scope is enough to push events).
2. Your backend calls `POST /v1/events` when something worth an email happens: `signed_up`, `first_success`, `credits.low`.
3. An automation (events, delays, conditions, then a template) turns the event into an email. The LLM may write a slot inside a
   fixed template; a validator checks it and static fallback copy goes out when the check fails.
4. Everything starts in test mode (sandbox inbox). Going live is a human approval.

## 1. Concepts

| Term | What it is |
|---|---|
| **Workspace** | The tenant. Keys, domains, contacts, templates, automations, approvals and the audit log all belong to one workspace. `mailcraft init` creates the first one. |
| **API key** | A bearer secret (`mc_test_...` or `mc_live_...`) with scopes, a send policy and caps. **Use one key per connected product** so you can revoke, cap or pause it alone. |
| **Contact** | A person, keyed by email within the workspace. Has `first_name`, `last_name`, `timezone`, free-form `properties`, topic opt-ins and a suppression state. |
| **List / segment** | A segment is a saved rule over contacts (`properties.plan = free`, `event_count:signed_up >= 1`). A manual segment has no rule and holds explicit members. <!-- TODO(contact-sources): lists (origin manual/import/source) are a manual segment plus an origin; document here once merged. --> |
| **Event** | Something your product tells mailcraft happened (`name` + `properties`, tied to a contact by email). Events are what start, wake and end automations. |
| **Automation** | A flow that starts on an event or a segment entry: `delay`, `condition`, `wait_for_event`, `send_email`, `update_contact`, `add_to_segment`, `exit`. |
| **Broadcast** | One template sent once to a set of recipients (up to 5000 per call), paced under your sending limits, with an approval step. |
| **Template** | Blocks (JSON), HTML or MJML, versioned (draft, then published), with `{{ variables }}` and optional LLM `slot` blocks. |
| **Stream / topic** | `transactional` (receipts, security, account) or `marketing` (everything else). Topics are opt-in/out categories inside a stream (`product`, `digest`, `account`). |

### API keys

Created by a human with the admin key (`mailcraft keys create`, the dashboard, or `POST /v1/keys`). The secret is shown once.

```bash
mailcraft --profile admin keys create --name acme-backend --scopes send --env test
```

| Setting | Meaning |
|---|---|
| `env` | `test` keys never leave the box: mail is rendered, signed and stored, then lands in the sandbox inbox. `live` keys send for real, and only after the workspace is approved to go live. |
| `scopes` | `read` (look at things), `send` (send mail, track events), `manage` (templates, contacts, segments, automations, domains, transports, webhooks). `admin` (approvals, policy, kill-switch release, settings) is never granted to a key made over the API. |
| `policy` | Per action: `auto`, `needs_approval` or `blocked`. A key whose sends a human should always review can be `needs_approval`. |
| `daily_send_cap`, `minute_send_cap`, `recipient_allowlist`, `expires_at` | Hard limits per key. An allowlist takes exact addresses or `@domain` entries. |

For pushing events from your backend, `send` is enough. Ship a **test** key first, run the whole flow, then swap in a live key.

## 2. Push events from your backend

### The contract

```
POST /v1/events
Authorization: Bearer mc_live_...
Content-Type: application/json
Idempotency-Key: signed_up:usr_8f2c        # your own stable id for this occurrence

{
  "name": "signed_up",
  "contact": { "email": "ana@example.com" },
  "properties": { "plan": "free", "source": "docs" },
  "contact_properties": { "plan": "free", "timezone": "Asia/Kolkata" }
}
```

| Field | Rules |
|---|---|
| `name` | Required, 1 to 128 characters. Must equal an automation's trigger name exactly (case-sensitive). Dots and underscores are both fine; pick one style and keep it. |
| `contact.email` | Required. The contact is created if it does not exist, so an event is also how a new person enters mailcraft. |
| `properties` | Facts about **this** occurrence. In automations they are `event.<key>` (conditions) and `{{ event.<key> }}` (templates). |
| `contact_properties` | Durable attributes merged into the contact (`plan`, `company`). Template variable `{{ plan }}`, condition field `contact.plan`. `timezone` here (an IANA name) is also copied to the contact's time zone, which drives quiet hours. |
| `dry_run` | `true` lists the active automations the event would trigger and changes nothing. |
| `Idempotency-Key` | Same key and same body within 24 hours replays the first answer; same key with a different body is `409 idempotency_key_reused`. Always send one. |

Names (`first_name`, `last_name`) are not set by events. Set them with `PUT /v1/contacts` (`manage` scope) or by letting mailcraft
[pull your contacts](#3-let-mailcraft-pull-your-contact-list); until then `{{ first_name }}` renders as `there`.

Answer `202`:

```json
{ "ok": true, "data": { "event_id": "…", "contact_id": "…", "duplicate": false,
  "triggered_automations": [{ "id": "…", "run_id": "…" }] }, "request_id": "…" }
```

Errors use `{"ok": false, "error": {"code", "message", "hint", "retryable"}}`. `401` bad key, `403` missing scope or kill switch,
`422` invalid body (for example a malformed email), `429` rate limited (retry after `Retry-After`), `5xx` retry.

### Do not block your users on it

Treat email as a side effect. The pattern in every example below:

- **Fire and forget.** Never `await` mailcraft on a user-facing request path. A mailcraft outage must not become your outage.
- **Short timeout** (2 to 3 seconds) per attempt.
- **Retry** network errors, timeouts, `429` and `5xx` with exponential backoff and jitter, at most 3 or 4 times. Do not retry other `4xx`: log and move on.
- **Idempotency key from your own data**, so a retry can never send twice: `signed_up:<user id>` for once-per-user events, `credits.low:<user id>:<period>` for repeating ones.
- On serverless platforms the process may freeze when the response is sent. Hand the call to the platform's background hook (`waitUntil`, `after()`) or a queue instead of a bare floating promise.
- For anything you cannot afford to lose, write the event to your own outbox table in the same transaction as the change and let a worker deliver it.

### curl

```bash
curl -sS -X POST https://mail.example.com/v1/events \
  -H "Authorization: Bearer $MAILCRAFT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: signed_up:usr_8f2c" \
  --max-time 3 --retry 3 --retry-all-errors \
  -d '{"name":"signed_up","contact":{"email":"ana@example.com"},"properties":{"plan":"free"}}'
```

Add `"dry_run": true` to see which automations would fire.

### TypeScript (fetch)

```ts
// mailcraft.ts: call track() anywhere. It returns immediately and never throws.
const BASE = process.env.MAILCRAFT_URL ?? "http://localhost:8080";
const KEY = process.env.MAILCRAFT_API_KEY!;

type Tracked = {
  name: string;
  email: string;
  idempotencyKey: string;
  properties?: Record<string, unknown>;
  contactProperties?: Record<string, unknown>;
};

async function attempt(e: Tracked): Promise<"ok" | "retry" | "drop"> {
  try {
    const res = await fetch(`${BASE}/v1/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "idempotency-key": e.idempotencyKey,
      },
      body: JSON.stringify({
        name: e.name,
        contact: { email: e.email },
        properties: e.properties,
        contact_properties: e.contactProperties,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return "ok";
    return res.status === 429 || res.status >= 500 ? "retry" : "drop";
  } catch {
    return "retry"; // network error or timeout
  }
}

export function track(e: Tracked): void {
  void (async () => {
    for (let i = 0; i < 4; i++) {
      const outcome = await attempt(e);
      if (outcome === "ok") return;
      if (outcome === "drop") return console.error("mailcraft rejected", e.name);
      await new Promise((r) => setTimeout(r, 2 ** i * 500 + Math.random() * 250));
    }
    console.error("mailcraft unreachable, gave up on", e.name);
  })();
}

// track({ name: "signed_up", email: user.email, idempotencyKey: `signed_up:${user.id}`,
//         properties: { plan: "free" }, contactProperties: { plan: "free" } });
```

### TypeScript (SDK)

`npm i @dibbayajyotiroy/mailcraft` (Node 22+, no runtime dependencies). Methods never throw; they return `{ data, error }` and
`error.retryable` tells you whether to retry with the same key. The SDK has no timeout option, so pass a `fetch` that sets one.

```ts
import { Mailcraft } from "@dibbayajyotiroy/mailcraft";

const mailcraft = new Mailcraft(process.env.MAILCRAFT_API_KEY!, {
  baseUrl: process.env.MAILCRAFT_URL,
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(3000) }),
});

const { data, error } = await mailcraft.events.track(
  {
    name: "first_success",
    contact: { email: "ana@example.com" },
    properties: { kind: "export", latency_ms: 840 },
  },
  { idempotencyKey: `first_success:${user.id}` },
);
if (error?.retryable) {
  // queue it for a later retry with the same idempotency key
}
```

### Python (requests)

```python
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor

import requests

BASE = os.environ.get("MAILCRAFT_URL", "http://localhost:8080")
KEY = os.environ["MAILCRAFT_API_KEY"]
_pool = ThreadPoolExecutor(max_workers=2)  # background sender: callers never wait
_session = requests.Session()


def _send(name, email, idem_key, properties=None, contact_properties=None):
    body = {
        "name": name,
        "contact": {"email": email},
        "properties": properties or {},
        "contact_properties": contact_properties or {},
    }
    headers = {"Authorization": f"Bearer {KEY}", "Idempotency-Key": idem_key}
    for attempt in range(4):
        try:
            r = _session.post(f"{BASE}/v1/events", json=body, headers=headers, timeout=3)
            if r.ok:
                return
            if r.status_code != 429 and r.status_code < 500:
                print("mailcraft rejected", name, r.status_code, r.text)  # retrying will not help
                return
        except requests.RequestException:
            pass  # network error or timeout: retry
        time.sleep(2**attempt * 0.5 + random.random() * 0.25)
    print("mailcraft unreachable, gave up on", name)


def track(name, email, idem_key, properties=None, contact_properties=None):
    """Returns immediately; the event is delivered from a worker thread."""
    _pool.submit(_send, name, email, idem_key, properties, contact_properties)


# track("signed_up", user.email, f"signed_up:{user.id}", {"plan": "free"}, {"plan": "free"})
```

### Go (net/http)

```go
package mailcraft

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"os"
	"time"
)

var (
	base   = envOr("MAILCRAFT_URL", "http://localhost:8080")
	key    = os.Getenv("MAILCRAFT_API_KEY")
	client = &http.Client{} // per-attempt deadline comes from the context
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

type Event struct {
	Name              string         `json:"name"`
	Contact           map[string]any `json:"contact"` // {"email": "..."}
	Properties        map[string]any `json:"properties,omitempty"`
	ContactProperties map[string]any `json:"contact_properties,omitempty"`
}

// Track returns immediately; delivery, retries and logging happen in a goroutine.
func Track(e Event, idempotencyKey string) {
	go func() {
		body, _ := json.Marshal(e)
		for i := 0; i < 4; i++ {
			switch attempt(body, idempotencyKey) {
			case "ok":
				return
			case "drop":
				log.Printf("mailcraft rejected %s", e.Name)
				return
			}
			time.Sleep(time.Duration(500<<i)*time.Millisecond + time.Duration(rand.Intn(250))*time.Millisecond)
		}
		log.Printf("mailcraft unreachable, gave up on %s", e.Name)
	}()
}

func attempt(body []byte, idem string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/events", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", idem)
	res, err := client.Do(req)
	if err != nil {
		return "retry" // network error or timeout
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode < 300:
		return "ok"
	case res.StatusCode == 429 || res.StatusCode >= 500:
		return "retry"
	}
	return "drop"
}

// mailcraft.Track(mailcraft.Event{Name: "signed_up", Contact: map[string]any{"email": u.Email}}, "signed_up:"+u.ID)
```

### Recommended events

mailcraft does not require any of these names; they are a starting set that covers the usual product lifecycle. Send what an
email needs to say as event properties, because the LLM validator only accepts numbers, hosts and links that appear in the
context it was given (see [LLM-written slots](#llm-written-slots)).

| Event | Send it when | Useful `properties` | Typical automation |
|---|---|---|---|
| `signed_up` | An account is created (once per user). | `plan`, `source` | Welcome after a short delay. Put `plan` in `contact_properties` too. |
| `onboarding.completed` | The user finishes your setup flow. | `role`, `use_cases` | Next-step email. Also the **exit event** of any "finish setup" nudge. |
| `first_success` | The first time the core action works (first API call, first export, first project). | `kind`, `latency_ms` | Congratulate and suggest one next step. Exit event for "stalled" nudges. |
| `usage.failed` | A core action failed in a way worth a human-sounding email. Batch it: send at most once per target per few hours. | `code`, `count`, `target`, `doc_url` | Help email, filtered with `event.count >= 2`. |
| `credits.low` | Usage crossed a threshold (80 percent, 100 percent). | `threshold`, `used`, `limit`, `resets_at` | Usage alert. Account-type mail: use a topic users cannot unsubscribe from only if it is genuinely operational. |
| `inactive` | Your own daily job found a user with no activity for N days. | `days`, `last_seen_at` | Win-back, with a goal that exits when the user returns. |

mailcraft cannot see your product's activity on its own. `inactive` has to come from you, or from a segment rule such as
`days_since:first_success >= 14` if you track the events it counts.

### How automations use events

Import a definition (`mailcraft automations import onboarding.json`, then `mailcraft automations publish onboarding`; the template
must be published first):

```json
{
  "name": "onboarding",
  "entry_rule": "once",
  "goal": { "events": ["onboarding.completed"] },
  "approval": "first_n:5",
  "steps": [
    { "key": "trigger", "type": "trigger", "config": { "event": "signed_up" }, "next": "wait" },
    { "key": "wait", "type": "delay", "config": { "duration": "24h" }, "next": "idle" },
    { "key": "idle", "type": "condition",
      "config": { "rule": { "field": "event_count:first_success", "op": "eq", "value": 0 } },
      "next": { "true": "nudge", "false": "done" } },
    { "key": "nudge", "type": "send_email",
      "config": { "template": "finish-setup", "topic": "product", "mode": "llm", "from": "hello@example.com",
                  "instructions": "Friendly and brief. Mention the user's plan once." },
      "next": "await" },
    { "key": "await", "type": "wait_for_event",
      "config": { "event": "first_success", "timeout": "3d" },
      "next": { "event": "done", "timeout": "last_call" } },
    { "key": "last_call", "type": "send_email",
      "config": { "template": "finish-setup-last", "topic": "product", "from": "hello@example.com" }, "next": "done" },
    { "key": "done", "type": "exit", "config": { "reason": "finished" } }
  ]
}
```

- **Trigger.** `config.event` (or `events`), optionally `filter` over `event.*` and `contact.*`: `{"field": "event.count", "op": "gte", "value": 2}`. A trigger can also be a segment entry (`config.segment`).
- **Conditions** are evaluated when the step runs, after any delay. Fields: `event.<key>`, `contact.<key>`, `properties.<key>`, `topic:<key>`, `event_count:<event>`, `days_since:<event>`. Ops: `eq neq lt lte gt gte in contains exists`; combine with `and`, `or`, `not`.
- **Exit events.** `goal.events` ends a run (and cancels its pending sends) when the event arrives. `wait_for_event` pauses until the event or a timeout, with named edges `event` and `timeout`. A suppressed contact's run exits at its next send step.
- **Template variables.** `{{ first_name }}`, `{{ email }}`, any contact property as `{{ plan }}`, and event properties as `{{ event.used }}`.
- **Gates.** Kill switch, suppression, topic opt-out, frequency caps (default one lifecycle email per 48 hours, three per 7 days), quiet hours (09:00 to 18:00 contact-local, weekdays, live sends only), approvals and send caps all apply after the step decides to send. `cap_exempt: true` skips the frequency caps for genuinely operational mail.
- `entry_rule`: `once`, `always`, `after_days:N` or `if_no_active_run`.

A complete worked set (welcome, nudges, usage alerts, win-back) lives in [examples/lifecycle-pack](../examples/lifecycle-pack/pack.json).
Check wiring before anything is live: `mailcraft events track signed_up --contact ana@test.mailcraft.local --dry-run`.

#### LLM-written slots

The model only fills `slot` blocks you declare in the template, from a context your code builds (contact, event properties). It cannot
add links, prices or claims: the validator rejects numbers, hosts, URLs, error codes and parameters that are not in the context, plus
banned terms and spam phrases. One repair attempt, then the slot's `fallback` text is sent. Give every slot a `fallback`, and keep
facts in event properties so the model has something true to say. Writing style for the whole workspace goes in
`mailcraft settings instructions set`. Links in generated text may only point at the workspace's own sending and tracking domains, and
`MAILCRAFT_LLM_BANNED_TERMS` (semicolon-separated regexes, set on the server and added to the compose `mailcraft` environment) adds your own banned terms.
<!-- TODO(guardrails): MAILCRAFT_LLM_GUARDRAILS (default|api-product) is parsed but the automation adapter builds its own guardrails; mention the preset here once it is wired. -->

## 3. Let mailcraft pull your contact list

> **Coming.** Contact sources are in review and not on `main` yet. The contract below is final for that feature; the route names
> will be `/v1/contact-sources` and `/v1/lists` in [openapi.yaml](../openapi.yaml) once it merges.
> <!-- TODO(contact-sources): drop this note after the merge; confirm full_sync_hours, the 50,000-row cap and the route list against docs/CONTACT-SOURCES.md on main. -->

Pushing events creates contacts one at a time, with an email and properties. If your product already has the user table, it is easier
to let mailcraft **pull** it: you expose one internal HTTP endpoint, give mailcraft its URL and a key, and mailcraft upserts what comes
back every few minutes. mailcraft never connects to your database and your product never calls mailcraft for this.

Register it (dashboard: Settings, Contact sources; or the API, `manage` scope):

```bash
curl -sS -X POST https://mail.example.com/v1/contact-sources \
  -H "Authorization: Bearer $MAILCRAFT_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"app users","url":"http://app.internal:3000/internal/mailcraft/contacts","key":"<a key only this endpoint accepts>","interval_minutes":15}'
```

Every synced contact joins a list named after the source. `POST /v1/contact-sources/test` fetches one page and shows the field names
without writing anything; `POST /v1/contact-sources/{id}/sync?dry_run=true` previews a full run.

### The pull contract

```
GET <your url>?limit=500&cursor=<opaque>&updated_since=<RFC 3339>
Authorization: Bearer <key>
```

`cursor` and `updated_since` are omitted on the first request of a full read. After the first page both are sent on every request.

```json
200 {
  "data": [
    {
      "external_id": "usr_8f2c",
      "email": "ana@example.com",
      "first_name": "Ana",
      "last_name": null,
      "timezone": "Asia/Kolkata",
      "created_at": "2026-09-01T10:00:00Z",
      "updated_at": "2026-10-20T08:30:00Z",
      "deleted": false,
      "properties": { "plan": "pro", "signup_source": "docs" }
    }
  ],
  "next_cursor": "opaque-string-or-null",
  "synced_at": "2026-10-28T12:00:00Z"
}
```

| Field | Rules |
|---|---|
| `external_id` | Required string, stable for the person, at most 200 characters. How a later sync finds the same contact. |
| `email` | Required. Invalid addresses are skipped and counted. |
| `first_name`, `last_name`, `timezone` | Optional. **`null` means unknown, not "clear it":** it never erases a value mailcraft already has. `timezone` is an IANA name (`Europe/Berlin`); an invalid one is dropped and counted. |
| `updated_at` | Required, RFC 3339. Drives the incremental sync. |
| `created_at`, `synced_at` | Informational. |
| `deleted` | `true` means the person is gone on your side. Include these rows with a fresh `updated_at`, otherwise mailcraft cannot learn about deletions. |
| `properties` | Optional JSON object, merged shallowly into the contact's attributes. |

What your endpoint must do:

- **Order** rows by `(updated_at, external_id)` ascending (keyset order). mailcraft resumes from the newest `updated_at` it saw, which is only correct for ordered rows.
- **`updated_since` is inclusive.** mailcraft asks for its watermark minus 5 minutes, so rows arrive more than once. That is harmless (upserts are idempotent) and covers clock skew and open transactions.
- **Page with `next_cursor`** until it is `null`. At most `limit` rows per page; more than 1000 is treated as a broken source. Answer in under 10 seconds, pages under 20 MB.
- **Status codes.** `401` or `403`: the key is wrong (mailcraft stops and shows it). `429` and `5xx`: temporary, mailcraft tries again at the next interval. Anything else is an error.
- **Bump `updated_at` on every change** to a field you return. Computed properties (a plan derived from billing, a usage count) often change without touching your user row, so mailcraft also does a **periodic full pull** (default every 24 hours, `full_sync_hours`; `0` turns it off) to catch them. Do not rely on `updated_at` alone for values you compute.

What a sync does to a contact: identity is `(source, external_id)`; an email change in the source updates the contact unless another
contact already owns that address; properties from the source overwrite the same keys but never remove keys set in mailcraft.
**Suppressions and unsubscribes are never undone by a sync**, and `deleted: true` suppresses the address (reason `source_deleted`)
while keeping the contact and its history. Runs stop at 50,000 rows or 5 minutes and resume where they left off.

### The keyset query

One query serves every language below. `$1` is `updated_since`, `$2` and `$3` come from the decoded cursor, `$4` is `limit + 1` (the
extra row tells you whether there is a next page). `updated_at::text` keeps microseconds, which a JavaScript `Date` would drop.

```sql
SELECT id AS external_id, email, first_name, last_name, timezone, created_at, updated_at,
       updated_at::text AS cursor_ts,
       deleted_at IS NOT NULL AS deleted,
       jsonb_build_object('plan', plan, 'signup_source', signup_source) AS properties
FROM users
WHERE ($1::text IS NULL OR updated_at >= $1::text::timestamptz)
  AND ($2::text IS NULL OR (updated_at, id) > ($2::text::timestamptz, $3::text))
ORDER BY updated_at, id
LIMIT $4;
```

Assumptions: `id` is text (cast or compare as the same type everywhere), `updated_at` has an index `(updated_at, id)`, deletes are
soft (`deleted_at`) and bump `updated_at`. If you hard-delete rows, keep a tombstone table and `UNION ALL` it in with
`deleted = true`. Return only the properties an email needs.

### Reference implementation: TypeScript (Express)

```ts
import express from "express";
import { Pool } from "pg";
import { createHash, timingSafeEqual } from "node:crypto";

const pool = new Pool(); // PG* environment variables
const KEYS = (process.env.MAILCRAFT_SOURCE_KEYS ?? "").split(",").filter(Boolean); // two keys = zero-downtime rotation
const sha = (s: string) => createHash("sha256").update(s).digest();
const authorized = (header = "") =>
  KEYS.map((k) => timingSafeEqual(sha(header.replace(/^Bearer /, "")), sha(k))).some(Boolean);

const SQL = `...the keyset query above...`;
const enc = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString("base64url");

const app = express();
app.get("/internal/mailcraft/contacts", async (req, res) => {
  if (!authorized(req.header("authorization"))) return res.status(401).json({ error: "unauthorized" });
  const limit = Math.min(Number(req.query.limit) || 500, 1000);
  const [ts, id] = req.query.cursor ? Buffer.from(String(req.query.cursor), "base64url").toString().split("|") : [null, null];
  const { rows } = await pool.query(SQL, [req.query.updated_since || null, ts, id, limit + 1]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.json({
    data: page.map(({ cursor_ts, ...contact }) => contact),
    next_cursor: rows.length > limit ? enc(last.cursor_ts, last.external_id) : null,
    synced_at: new Date().toISOString(),
  });
});
app.listen(3000);
```

### Reference implementation: Go (net/http)

```go
package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const query = `...the keyset query above...`

type contact struct {
	ExternalID string          `json:"external_id"`
	Email      string          `json:"email"`
	FirstName  *string         `json:"first_name"`
	LastName   *string         `json:"last_name"`
	Timezone   *string         `json:"timezone"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
	Deleted    bool            `json:"deleted"`
	Properties json.RawMessage `json:"properties"`
	cursorTS   string
}

func authorized(header string) bool {
	given := sha256.Sum256([]byte(strings.TrimPrefix(header, "Bearer ")))
	ok := 0
	for _, k := range strings.Split(os.Getenv("MAILCRAFT_SOURCE_KEYS"), ",") { // two keys = zero-downtime rotation
		if k == "" {
			continue
		}
		want := sha256.Sum256([]byte(k))
		ok |= subtle.ConstantTimeCompare(given[:], want[:])
	}
	return ok == 1
}

func handler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r.Header.Get("Authorization")) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		if limit <= 0 {
			limit = 500
		}
		limit = min(limit, 1000)
		var since, ts, id *string // nil = NULL = "not given"
		if s := q.Get("updated_since"); s != "" {
			since = &s
		}
		if raw, err := base64.RawURLEncoding.DecodeString(q.Get("cursor")); err == nil && len(raw) > 0 {
			a, b, _ := strings.Cut(string(raw), "|")
			ts, id = &a, &b
		}
		rows, err := db.QueryContext(r.Context(), query, since, ts, id, limit+1)
		if err != nil {
			http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
			return
		}
		defer rows.Close()
		page := []contact{}
		for rows.Next() {
			var c contact
			var props string
			if err := rows.Scan(&c.ExternalID, &c.Email, &c.FirstName, &c.LastName, &c.Timezone,
				&c.CreatedAt, &c.UpdatedAt, &c.cursorTS, &c.Deleted, &props); err != nil {
				http.Error(w, `{"error":"scan failed"}`, http.StatusInternalServerError)
				return
			}
			c.Properties = json.RawMessage(props)
			page = append(page, c)
		}
		var next *string
		if len(page) > limit {
			page = page[:limit]
			last := page[limit-1]
			n := base64.RawURLEncoding.EncodeToString([]byte(last.cursorTS + "|" + last.ExternalID))
			next = &n
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": page, "next_cursor": next, "synced_at": time.Now().UTC()})
	}
}

func main() {
	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	http.Handle("/internal/mailcraft/contacts", handler(db))
	panic(http.ListenAndServe(":3000", nil))
}
```

### Reference implementation: Python (FastAPI)

```python
import base64
import hmac
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import asyncpg
from fastapi import FastAPI, Header, HTTPException

KEYS = [k.encode() for k in os.environ.get("MAILCRAFT_SOURCE_KEYS", "").split(",") if k]  # two keys = zero-downtime rotation
SQL = """...the keyset query above..."""


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(os.environ["DATABASE_URL"])
    yield
    await app.state.pool.close()


app = FastAPI(lifespan=lifespan)


def to_contact(r: asyncpg.Record) -> dict:
    c = {k: r[k] for k in ("external_id", "email", "first_name", "last_name", "timezone", "created_at", "updated_at", "deleted")}
    return {**c, "properties": json.loads(r["properties"])}  # asyncpg returns jsonb as text


@app.get("/internal/mailcraft/contacts")
async def contacts(limit: int = 500, cursor: str = "", updated_since: str = "", authorization: str = Header("")):
    given = authorization.removeprefix("Bearer ").encode()
    if not any([hmac.compare_digest(given, k) for k in KEYS]):
        raise HTTPException(status_code=401, detail="unauthorized")
    limit = max(1, min(limit, 1000))
    ts, _, ext_id = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode().partition("|") if cursor else (None, "", None)
    rows = await app.state.pool.fetch(SQL, updated_since or None, ts, ext_id, limit + 1)
    page = rows[:limit]
    nxt = base64.urlsafe_b64encode(f"{page[-1]['cursor_ts']}|{page[-1]['external_id']}".encode()).decode() if len(rows) > limit else None
    return {"data": [to_contact(r) for r in page], "next_cursor": nxt, "synced_at": datetime.now(timezone.utc)}
```

### Security notes

- **Internal network only.** Put the endpoint on a private address (mailcraft accepts private and loopback URLs, and follows redirects only within the same scheme, host and port). Do not expose it to the internet; if you must, restrict it by IP at the proxy.
- **A dedicated key** that can read only this endpoint. Compare it in constant time (all three examples hash or use `compare_digest`), never log it, and never reuse your API or session secrets.
- **Rotation without downtime:** put the new key next to the old one in `MAILCRAFT_SOURCE_KEYS` (comma-separated), update the source with `PATCH /v1/contact-sources/{id} {"key": "<new>"}`, confirm a sync succeeds, then remove the old key. mailcraft seals its copy with `MAILCRAFT_SECRET_KEY` and never returns it.
- **Return what an email needs, nothing more.** Email, names, time zone and a handful of non-sensitive properties (`plan`, `signup_source`). No password hashes, tokens, payment details or free text from users. Properties become template variables and part of the LLM's context.
- Treat user-supplied strings in properties as data. They can end up in prompts; the validator and the fixed template slots limit the damage, but do not put secrets there.

## 4. Senders

Mail goes out from an address you control, through a transport you control. mailcraft never relays through project-run infrastructure.

| You have | Connect it with | Notes |
|---|---|---|
| A domain you can edit DNS for | `mailcraft domain add example.com` | Prints (or creates, with `CLOUDFLARE_API_TOKEN`) the SPF, DKIM, DMARC and return-path records, then verifies. Send as anything `@example.com`. Use a subdomain for marketing (`mail.example.com`) so its reputation stays apart from your main domain. |
| A mailbox (Zoho, Google Workspace, Outlook) | `mailcraft connect relay custom --host smtp.zoho.in --port 587 --username dev@example.com --mailbox-sender` | The provider only accepts the signed-in address as sender, so From is that address. The provider's daily cap applies and bounces land in that mailbox. |
| A relay account (SES, Postmark, Mailgun, Brevo, SMTP2GO, any SMTP) | `mailcraft connect relay <preset>` | Best for volume. Pair with a verified domain. |
| Nothing yet | `mailcraft connect gmail`, or just the sandbox | Test or very low volume only. See [QUICKSTART](QUICKSTART.md#no-domain-send-through-your-own-gmail). |

The From address is set where the mail is created: the `from` field of `POST /v1/emails` and `POST /v1/broadcasts`, and `config.from`
of an automation's `send_email` step (optional once a verified domain exists, which supplies `hello@<domain>`). A live send needs a
verified domain, or a mailbox relay whose login is that address.

### Several From addresses (aliases, several mailboxes)

> **Coming.** Multiple senders are in review and not on `main` yet.
> <!-- TODO(multi-sender): drop this note after the merge; check the flag names against `mailcraft connect relay --help` and docs/QUICKSTART.md. -->

- **One mailbox, several "send as" aliases** (Zoho, Workspace): list them on the relay, with a display name per address. The envelope sender stays the login; the From header is the alias.

  ```bash
  mailcraft connect relay custom --host smtp.zoho.in --port 587 \
    --username dev@example.com --mailbox-sender \
    --alias partner@example.com --alias support@example.com \
    --display-name 'dev@example.com=Example Developers' --display-name 'support@example.com=Example Support'
  ```
- **Several mailboxes or products:** connect each as its own relay and bind a domain to a transport with `PATCH /v1/domains/{id} {"transport_id": "..."}`.
- **Routing by From.** A send picks its transport from the From address: an explicit `transport_id`, else the mailbox relay with that login or alias, else the transport bound to the From domain, else the default. The decision is recorded in the email's `policy_decisions` (rule `routing`).
- `GET /v1/senders` lists the From addresses you can pick, with a status (`ready`, `needs_domain`, `transport_missing`). A step or broadcast chooses its sender by setting `from` (and, to force one, `transport_id`).

## 5. Consent and compliance

mailcraft enforces mechanics. The decisions are yours, and none of this is legal advice.

- **Only email people who asked for it.** Contacts should come from sign-ups or opt-ins in your product. Do not import bought lists or scraped addresses: they bounce, trip spam traps and damage the domain for everyone. Hard bounces and complaints suppress the address automatically, but a purchased list will still hurt your sending reputation.
- **Transactional versus marketing.** `transactional` is for mail a person needs to use your product (receipts, password resets, security notices, usage alerts they depend on). Anything promotional, educational or re-engaging is `marketing`. Do not put promotions in a transactional email to dodge unsubscribe handling.
- **Unsubscribe is automatic for marketing.** Every marketing email carries a visible unsubscribe link plus `List-Unsubscribe` and one-click `List-Unsubscribe-Post` headers (RFC 8058), and a footer with your legal name and postal address. Live marketing sends are refused until the workspace has both (`legal_name`, `postal_address`). There is no settings route or screen for them yet, so on a self-hosted install set them in the database: `UPDATE workspaces SET legal_name = 'Example Inc', postal_address = '1 Main St, Springfield';`. Do not remove the footer from templates. <!-- TODO(settings): replace the SQL with the route or screen once one exists. -->
- **Topics.** Group lifecycle mail into topics (`product`, `digest`, `account`). A contact can opt out of one topic and keep the others; a topic with `can_unsubscribe: false` is for operational mail only.
- **Suppression always wins.** A hard bounce, a complaint, an unsubscribe or a manual suppression blocks every future send to that address, whatever the source: an event, a broadcast, a contact import or a contact-source sync. Syncs and imports never clear a suppression.
- **Deletions.** When a user deletes their account, delete or suppress their contact (`DELETE /v1/contacts/{id}`, or `deleted: true` through a contact source). The audit log is append-only and hash-chained by design.
- **Frequency and timing.** Lifecycle mail is capped (default one per 48 hours, three per 7 days) and held to quiet hours in the contact's time zone. Set `timezone` for every contact you can.

## 6. Testing before anyone gets real mail

- **Test keys.** A `mc_test_` key never delivers outside mailcraft: mail is rendered, signed and stored, then shown in the sandbox inbox (dashboard Emails). Automation emails stay in the sandbox until the workspace goes live, even with a live key.
- **Magic addresses** (any `+label` allowed) simulate outcomes: `delivered@test.mailcraft.local`, `bounced@test.mailcraft.local` (550 5.1.1), `complained@`, `suppressed@`, `deferred@` (4.2.0, then delivered).
- **Dry runs.** `POST /v1/events` and `POST /v1/emails` accept `dry_run: true` (CLI: `--dry-run`); `POST /v1/broadcasts` with `dry_run` lists what would be skipped and how the send is paced; `POST /v1/templates/{id}/preview` renders with variables; `POST /v1/automations/{id}/test` runs the flow for one contact (sandboxed under a test key).
- **Approvals.** New automations default to `approval: first_n:5`: the first five sends wait in `pending_approval` until a human with the admin key approves them (dashboard Approvals, or `mailcraft --profile admin approvals approve <id>`). Broadcasts and go-live requests are approvals too.
- **Going live** is a human action: request it (`POST /v1/go-live-requests`), approve in the dashboard, then swap the product's key for a `mc_live_` one. `mailcraft doctor` must pass first if you send directly from your own IP.
- **Kill switch.** `mailcraft kill-switch on` stops all sending at once; engaging needs `manage`, releasing needs a human with `admin`.

A reasonable rollout: test key and `dry_run` events, then watch the sandbox inbox, then a live key limited by `recipient_allowlist` to your own team, then widen.

## 7. Agents, MCP and the assistant

Everything above can be set up by an AI agent, with the human steps (approvals, go-live, limits, kill-switch release, OAuth consent) kept out of its reach.

- **MCP server.** Local: `claude mcp add mailcraft -e MAILCRAFT_API_URL=http://localhost:8080 -e MAILCRAFT_API_KEY=mc_test_... -- npx -y @dibbayajyotiroy/mailcraft-mcp`. Remote: `https://<your-host>/mcp` with a bearer key. Install only the scoped package named here: look-alikes exist for other email MCP servers. `--read-only` and `--tools a,b` narrow the surface. Tools mirror the REST routes (`event_send`, `contact_upsert`, `template_create`, `automation_create`, `email_send`, `approval_list`, ...); an agent can engage the kill switch but never approve, raise limits or go live. See [mcp/README.md](../mcp/README.md) and [agent-setup.md](agent-setup.md).
- **Skills and docs for agents.** [llms.txt](llms.txt), [SKILL.md](SKILL.md), [AGENTS.md](AGENTS.md) (paste into your product's `AGENTS.md`), and per-task skills in [docs/skills/](skills/).
- **A good prompt:** "Using the mailcraft MCP with a test key, create a `finish-setup` template and an automation triggered by `signed_up` that waits 24 hours, skips users who fired `first_success`, then sends it. Dry-run it, then ask me to approve."
- **The in-dashboard assistant.** An AI agent inside the dashboard that drafts templates, automations and segments for you as **proposals**: nothing is written until you press Apply, and Apply runs with your own key, so scopes, approvals and the kill switch still apply. It runs on free, open-weight OpenRouter models and shows a usage card for your OpenRouter key. It needs `OPENROUTER_API_KEY` on the dashboard server. <!-- TODO(assistant): Coming, not on main yet. Confirm env names (MAILCRAFT_ASSISTANT_MODEL, MAILCRAFT_ASSISTANT_BASE_URL), where it lives in the UI, and drop this marker after the merge; add a screenshot to docs/images. -->

## Checklist

- [ ] One key per product, `send` scope for event pushes, test key first.
- [ ] `track()` is fire-and-forget with a timeout, retries and an idempotency key.
- [ ] Event names match the automation triggers exactly; `mailcraft events track ... --dry-run` shows the automation.
- [ ] Facts the email will mention are in event `properties`.
- [ ] Every template slot has a fallback; every marketing template keeps its footer.
- [ ] Workspace legal name and postal address set (needed for live marketing mail); domain (or mailbox) verified; contacts have a `timezone`.
- [ ] A human approved the first sends and the go-live request.
