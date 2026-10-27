---
name: mailcraft-setup-domain
description: Choose a delivery path for mailcraft, add and verify a sending domain (SPF, DKIM, DMARC, return path), or connect Gmail when there is no domain. Use when the user wants real delivery, DNS records, or deliverability checks.
---

# Set up delivery with mailcraft

## Rules
1. Use `--json`. Stay on the test key; going live is a human approval.
2. Never print or ask for keys, including `CLOUDFLARE_API_TOKEN` and Google client secrets.
3. Exit `7` from `domain verify` or `doctor` = not ready; follow `error.hint` / the failing check's `hint`.
4. Never send directly from the host by default. Direct delivery is opt-in and refused until `doctor` passes port 25, FCrDNS, HELO and blocklist checks. Prefer a relay.

## Ladder
Sandbox (nothing leaves the box) -> Gmail (no domain, test/low volume) -> domain + relay -> domain + direct (discouraged).

## Domain steps
```
mailcraft domain add example.com --json
mailcraft domain verify example.com --json     # exit 7 until DNS propagates
mailcraft domain list --json
mailcraft doctor --json
```
- With `CLOUDFLARE_API_TOKEN` in the environment, `domain add` creates the records and polls. Otherwise give the human the printed `records[]` (type, name, value) as a copy-paste block and wait; then re-run `domain verify`.
- DKIM and return path must verify before sending. Missing DMARC is a warning only; start with `p=none`.
- Relay: `mailcraft connect relay <preset>` (e.g. postmark, ses). Check with `doctor`.

## No domain
`mailcraft connect gmail` (needs the human's own Google OAuth client: `MAILCRAFT_GOOGLE_CLIENT_ID/SECRET`; steps in QUICKSTART.md). From is the human's Gmail address; about 500/day; test or low volume only. The consent screen is a human step.

## Pitfalls
- DNS propagation takes minutes to hours; retry `verify` with backoff, do not loop tightly.
- Apps left in Google "Testing" status expire refresh tokens after 7 days; publish to "In production".
- Do not query or report blocklist results as final; `doctor` reports them with hints.
