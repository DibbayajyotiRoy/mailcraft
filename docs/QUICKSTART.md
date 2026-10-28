# Quickstart

Pre-alpha: commands that are not built yet return `not_implemented`; see the README status.

## With a domain (three commands)

```
echo "MAILCRAFT_SECRET_KEY=$(openssl rand -base64 32)" > .env   # once; encrypts DKIM keys + credentials
docker compose up -d                 # postgres, redis, mailcraft :8080, dashboard :3000
alias mailcraft='docker compose run --rm cli'   # or: cargo install --path crates/mailcraft-cli (install the CLI BEFORE init)
mailcraft init                       # once per database: creates test + admin keys, prints the admin key once, saves both (profiles default/admin)
mailcraft domain add example.com     # prints (or creates) SPF/DKIM/DMARC/return-path records, then verifies
```

- With `CLOUDFLARE_API_TOKEN` set, `domain add` creates the DNS records through the Cloudflare API and polls until `verified`.
- Without a token it prints a copy-paste block of records. Add them at your DNS host, then run `mailcraft domain verify example.com`. It exits 7 while records are missing and prints a hint.
- A domain cannot send until DKIM and the return path verify. A missing DMARC record is only a warning.
- Test send (works with the test key, delivers to the built-in sandbox inbox, nothing leaves the box):

```
mailcraft send --to delivered@test.mailcraft.local --subject "Hello" --text "It works" --json
```

Notes:

- The `cli` compose service talks to `http://mailcraft:8080` and stores its config in the `mc-config` volume, so keys survive `--rm`. Without an alias use `docker compose run --rm cli init`. Natively installed CLI: set `MAILCRAFT_API_URL` if the API is not on `localhost:8080`.
- `init` prints the admin key once. Store it. It is also saved as profile `admin`: `mailcraft --profile admin approvals list` (or `MAILCRAFT_PROFILE=admin`). Approvals, go-live and the kill-switch release need it.
- Dashboard: `http://localhost:3000/login`, API base URL `http://mailcraft:8080` (pre-filled), API key = the admin key. Ports: `MAILCRAFT_DASHBOARD_PORT`, `MAILCRAFT_PORT`.
- Verified on a fresh clone: compose up, `init`, test send, dashboard login. Not verified: `domain add`.

## Your first automation

A welcome email whose intro line is written by the LLM inside a fixed slot, with static fallback copy. Needs `OPENROUTER_API_KEY` in `.env` (see `.env.example`); without it the fallback text is sent.

`welcome.json` (template; the `slot` block is where the model writes):

```json
{"version": 1, "subject": "Welcome {{ first_name }}",
 "blocks": [
  {"type": "heading", "text": "Hi {{ first_name }}"},
  {"type": "slot", "name": "intro", "max_len": 240,
   "instructions": "One warm sentence welcoming them and naming the next step.",
   "fallback": "Thanks for signing up. Your account is ready."}]}
```

`welcome-automation.json` (the step takes a plain `instructions` string and a `from`; there is no `llm{}` object):

```json
{"name": "welcome", "trigger": "signed_up", "approval": "first_n:5",
 "steps": [
  {"key": "mail", "type": "send_email", "config": {
    "template": "welcome", "mode": "llm", "from": "hello@example.com",
    "instructions": "Friendly and brief. Mention the product name once."}}]}
```

```bash
mailcraft templates import welcome.json --name welcome      # draft
mailcraft templates publish welcome                          # sends use the published version
mailcraft automations import welcome-automation.json         # draft
mailcraft automations publish welcome                        # activates (add --backfill-suppress to skip existing matches)
mailcraft contacts upsert ana@test.mailcraft.local --first-name Ana --timezone Europe/Berlin
mailcraft events track signed_up --contact ana@test.mailcraft.local
mailcraft --profile admin approvals list                     # the first 5 sends wait for a human with the admin key
```

`from` is required until a domain is verified: without it (and without a verified domain) the run fails immediately with a clear reason, no retries. Until the workspace goes live, automation emails are test-env and go to the sandbox, so a fresh install needs no transport; test-env sends ignore quiet hours. For live sends, quiet hours (09:00-18:00 contact-local, 13:00-17:00 UTC when the contact has no timezone) apply, so set `--timezone` (an invalid zone is a 422). Approving the `automation_first_send` approval releases the email (approve queues it, reject cancels it). `mailcraft automations enable` only resumes a paused automation; a draft needs `publish`.

LLM settings go in `.env` and compose passes them through: `OPENROUTER_API_KEY`, `MAILCRAFT_LLM_MODEL`, `MAILCRAFT_LLM_FALLBACK_MODELS` (comma list, sent as OpenRouter fallbacks and used when a model returns an empty completion; e.g. `MAILCRAFT_LLM_MODEL=nvidia/nemotron-3.5-super-vl:free`, `MAILCRAFT_LLM_FALLBACK_MODELS=deepseek/deepseek-v4-flash`), `MAILCRAFT_LLM_REASONING`, `MAILCRAFT_LLM_GUARDRAILS`, plus `MAILCRAFT_PUBLIC_URL` and `MAILCRAFT_EGRESS_IP`. Without `MAILCRAFT_EGRESS_IP` (or `--ip`), `mailcraft doctor` reports the reverse-DNS and blocklist checks as skipped, not failed.

Going live (a `mc_live_` key) is a human approval in the dashboard. Direct delivery from your own IP is opt-in and refused until `mailcraft doctor` passes; most users should use a relay (`mailcraft connect relay <preset>`).

## No domain: send through your own Gmail

For test or low-volume use only. Mail is sent from your own Gmail address through the Gmail API; Google signs it.

Honest limits: about 500 messages/day for free Gmail and about 2,000/day for Workspace, shared with the rest of that account's mail. From is your address, not an app address. Bulk or automated mail through a personal account may violate Google's terms. Keep it to personal or transactional scale.

mailcraft ships no shared Google OAuth client (`gmail.send` is a sensitive scope that needs Google verification for public apps), so each self-hoster creates their own. Verify against Google's current rules; the console labels below change.

1. In Google Cloud Console, create a project.
2. Enable the Gmail API for that project (APIs and Services, Library).
3. Configure the OAuth consent screen (Google Auth Platform). User type External (Internal for a Workspace-only setup). Fill in app name and your email.
4. Add the scope `https://www.googleapis.com/auth/gmail.send`.
5. Create credentials, OAuth client ID. Type Web application (add the redirect URI below) or Desktop app. Authorized redirect URI: `http://127.0.0.1:<port>/callback`, where `<port>` is the loopback port `mailcraft connect gmail` prints.
6. Set the publishing status to **In production**. Apps left in "Testing" issue refresh tokens that expire after 7 days. (Unverified production apps show a warning screen and are limited to 100 users; that is fine for your own account.)
7. Export the client credentials where the mailcraft server runs:

```
export MAILCRAFT_GOOGLE_CLIENT_ID=...
export MAILCRAFT_GOOGLE_CLIENT_SECRET=...
docker compose up -d        # restart so the server sees them
```

8. Connect:

```
mailcraft connect gmail
```

Open the printed URL, approve, and the CLI receives the callback on the loopback address. Then `mailcraft doctor`.

## Bring your own relay

`mailcraft connect relay <preset>` with credentials for SES, Postmark, Mailgun, Brevo, SMTP2GO or any SMTP server you own. mailcraft never routes your mail through project-run infrastructure.

A mailbox you already have (Zoho, Google Workspace, Outlook) works too. Those servers only accept the
signed-in address as the sender, so add `--mailbox-sender`. Bounces then land in that inbox instead of
being tracked by mailcraft, and the provider's daily sending cap applies:

```sh
export MAILCRAFT_SMTP_PASSWORD='<app password>'
mailcraft connect relay custom --host smtp.zoho.in --port 587 \
  --username dev@example.com --mailbox-sender
```

Several From addresses:

- **One mailbox, several "send as" aliases** (Zoho, Workspace): list the aliases, with a display name for
  each address. The envelope sender stays the login; the From header is the alias.

  ```sh
  mailcraft connect relay custom --host smtp.zoho.in --port 587 \
    --username dev@example.com --mailbox-sender \
    --alias partner@example.com --alias support@example.com \
    --display-name 'dev@example.com=Example Developers' --display-name 'support@example.com=Example Support'
  ```

- **Several mailboxes or products**: connect each mailbox as its own relay, and bind a domain to a transport
  with `PATCH /v1/domains/{id} {"transport_id": ...}` (Domains page: "Sends via").

A send picks its transport from the From address: an explicit `transport_id`, else the mailbox relay with that
login or alias, else the transport bound to the From domain, else the default transport. The choice is recorded
in the email's `policy_decisions` (rule `routing`). `GET /v1/senders` lists the From addresses you can pick.
