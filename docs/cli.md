# CLI reference

Global: `--json` (result JSON on stdout, logs on stderr; output carries `"schema": 1`). JSON is the default when stdout is not a TTY. Envelope: `{"ok", "data"|"error", "request_id", "schema": 1}`; lists add `next_cursor`.

Config: `~/.config/mailcraft/config.json`, mode 600. Env: `MAILCRAFT_API_URL`, `MAILCRAFT_API_KEY` (env overrides the file). Never print the key.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | generic failure / not implemented |
| 2 | usage error |
| 3 | authentication or scope failure |
| 4 | blocked by policy or approval required |
| 5 | retryable (rate limited, transient) |
| 6 | not found |
| 7 | checks failed (`doctor`, `domain verify` not yet verified) |

## Commands

| Command | Notes |
|---|---|
| `init [--url] [--key] [--non-interactive] [--delivery gmail\|relay:<preset>\|domain:<name>\|sandbox]` | Generates the secret key, creates admin and a `mc_test_` key, probes ports, installs skills and the AGENTS.md snippet. |
| `connect gmail` | OAuth to your own Gmail (test / low volume). Needs `MAILCRAFT_GOOGLE_CLIENT_ID/SECRET` on the server. See QUICKSTART. |
| `connect relay <preset>` | Relay transport (e.g. `postmark`, `ses`, `mailgun`, `brevo`, `smtp2go`). |
| `domain add <name>` | Prints records; creates them with `CLOUDFLARE_API_TOKEN`. |
| `domain verify <name>` | Exit 7 until verified. |
| `domain list` | |
| `send --to --subject --text --html --from --template --data '<json>' --dry-run --idempotency-key` | `--template` with `--data` renders a stored template. `--to` may repeat. |
| `emails get <id>` | Status, from_addr/to_addr, attempts, last_error, policy decisions. Ids are plain UUIDs. |
| `emails events <id>` | Event timeline. |
| `emails cancel <id>` | Cancel a queued, deferred or pending_approval email. |
| `emails list [--status] [--limit] [--cursor]` | Newest first; `next_cursor` in the envelope. |
| `templates import <file> [--name] [--format html\|mjml\|json]` | Format inferred from extension if omitted. |
| `templates export <id> [--format html\|mjml\|json]` | Default `json`. |
| `templates list` | |
| `templates preview <id> --data '<json>'` | Returns subject, html, text, lint. |
| `contacts` (`list`, `get <email>`, `upsert`) | |
| `events track <name> --contact <email> --data '<json>'` | Add `--dry-run` to list the emails it would trigger. |
| `automations list` | |
| `automations enable <id>` / `disable <id>` | |
| `automations import <file.json>` | See llms-full.txt for the format. First sends go to approval. |
| `keys create --name <n> --scopes read,send --env test\|live` | `data.token` is the secret, shown once. Scopes are `read`, `send`, `manage`; `admin` is never granted over the API. |
| `keys list`, `keys revoke <id>` | |
| `approvals list` | |
| `approvals approve <id>` / `reject <id>` | Human only. Refused with agent keys. |
| `settings instructions set "<text>"\|set --file <path>\|get\|clear` | Workspace writing instructions for LLM emails (max 2,000 chars). Changing needs `admin`. |
| `kill-switch on\|off` (aliases `pause` / `resume`, also top-level `mailcraft pause` / `mailcraft resume`) | Engaging needs `manage`; releasing needs `admin` (a human). |
| `doctor` | Exit 7 if any check fails. |

Mutating commands also accept `--yes` (skip prompt), `--dry-run`, `--idempotency-key`. Exact subcommand coverage follows the build; SPEC.md 7.2 lists planned extras (`policy`, `audit`, `webhook listen`, `mcp serve`).
