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
| `init [--url] [--key] [--non-interactive] [--delivery gmail\|relay:<preset>\|domain:<name>\|sandbox]` | First run: creates the admin and `mc_test_` keys, prints the admin key once, saves both in the config as profiles `default` (test) and `admin` (select with `--profile admin` / `MAILCRAFT_PROFILE`). |
| `connect gmail` | OAuth to your own Gmail (test / low volume). Needs `MAILCRAFT_GOOGLE_CLIENT_ID/SECRET` on the server. See QUICKSTART. |
| `connect relay <preset>` | Relay transport (e.g. `postmark`, `ses`, `mailgun`, `brevo`, `smtp2go`). |
| `domain add <name>` | Prints records; creates them with `CLOUDFLARE_API_TOKEN`. |
| `domain verify <name>` | Exit 7 until verified. |
| `domain list` | |
| `send --to --subject --text --html --from --template --data '<json>' --dry-run --idempotency-key` | `--template` with `--data` renders a stored template. `--to` may repeat. |
| `emails get <id>` | Status, from_addr/to_addr, attempts, last_error, policy decisions. Ids are plain UUIDs. |
| `emails events <id>` | Event timeline. |
| `emails cancel <id>` | Cancel a queued, deferred or pending_approval email. |
| `emails list [--status] [--stream] [--env] [--q <text>] [--from <date>] [--to <date>] [--limit] [--cursor]` | Newest first; `next_cursor` in the envelope. `--q` matches to / from / subject (or an exact id); `--from` / `--to` bound `created_at` (YYYY-MM-DD or RFC 3339). |
| `broadcasts create --template <id\|alias> --from <addr> (--csv <file>\|--recipients <json\|@file>) [--subject] [--stream] [--max-per-day N] [--dry-run] [--idempotency-key]` | One template to up to 5000 recipients, paced under the daily cap. **`--dry-run` first**: it stores nothing and returns `queued`, `skipped[]` (reason per dropped row) and `schedule`. CSV: header row with `email`, optional `first_name` / `last_name`; every other column is `{{ data.<column> }}`. Test keys sandbox it; a live send asks for confirmation on a terminal (`--yes` skips). `pending_approval` exits 4 (one `approval_id`; poll `approvals list`). |
| `broadcasts list [--limit] [--cursor]`, `broadcasts get <id> [--status] [--limit] [--cursor]` (alias `show`) | Status and per-status counts; `get` adds skipped rows and each recipient's email status. |
| `broadcasts preview --template <id\|alias> --email <addr> [--first-name] [--last-name] [--data <json>] [--subject] [--stream]` | Renders one recipient exactly as sent. Sends nothing. |
| `templates import <file> [--name] [--format html\|mjml\|json]` | Format inferred from extension if omitted. |
| `templates export <id> [--format html\|mjml\|json]` | Default `json`. |
| `templates list` | |
| `templates versions <id\|alias>` | History, newest first; `published` marks the live version. |
| `templates restore <id\|alias> <version>` | Copies an older version into a new draft; `publish` it to go live. |
| `templates discard-draft <id\|alias>` | Deletes the unpublished versions newer than the published one. Cannot be undone; asks on a terminal (`--yes` skips). |
| `templates publish <id\|alias> [--version N]` | Makes a version live. |
| `templates preview <id> [--data '<json>'] [--version N] [--file <f.html\|f.mjml\|f.json> [--format] [--subject] [--preheader]]` | Returns subject, html, text, lint, variables. `--file` renders unsaved content (nothing is stored). |
| `contacts` (`list`, `get <email>`, `upsert <email> [--first-name n] [--data json] [--timezone IANA]`) | `--timezone` (IANA; invalid is 422) drives live-send quiet hours. `properties.timezone` is also lifted into it. |
| `contacts import <file.csv> [--idempotency-key]` | Header row: `email`, `first_name`, `last_name`, `timezone`; other columns become properties (numbers and true/false stay typed). Up to 5000 rows per call (larger files go in chunks). Bad rows come back in `data.failed` with their zero-based `index`; the rest are imported. The API has no import dry run yet. |
| `events track <name> --contact <email> --data '<json>'` | Add `--dry-run` to list the emails it would trigger. |
| `automations list [--status draft\|active\|paused\|archived] [--limit] [--cursor]` | Archived ones are hidden unless asked for. |
| `automations archive <id>` / `unarchive <id>` | Archive a draft or paused automation / bring it back as a draft. |
| `automations test <id\|name> --email <addr> [--first-name] [--data <event props json>] [--contact-data <json>]` | Starts a **real run** for one contact now, whatever the status, skipping the entry rule. A test key keeps mail in the sandbox; a live key sends (asks on a terminal). Returns `run_id`. |
| `automations runs <id> [--status active\|waiting\|completed\|exited\|failed] [--limit] [--cursor]` | Runs, newest first. |
| `automations run <id> <run_id>` | One run with its step log; poll after `test`. |
| `automations publish <id\|name> [--backfill-suppress]` | Activates a draft (publish the template first). |
| `automations enable <id>` / `disable <id>` | Resume / pause. A draft needs `publish`. |
| `automations import <file.json>` | See llms-full.txt for the format. First sends go to approval. |
| `keys create --name <n> --scopes read,send --env test\|live` | `data.token` is the secret, shown once. Scopes are `read`, `send`, `manage`; `admin` is never granted over the API. |
| `keys list`, `keys revoke <id>` | |
| `approvals list` | |
| `approvals approve <id> [--reason <text>]` / `reject <id> [--reason <text>]` | Human only. Refused with agent keys. The note (max 500 chars) is kept with the decision. |
| `settings instructions set "<text>"\|set --file <path>\|get\|clear` | Workspace writing instructions for LLM emails (max 2,000 chars). Changing needs `admin`. |
| `kill-switch on\|off` (aliases `pause` / `resume`, also top-level `mailcraft pause` / `mailcraft resume`) | Engaging needs `manage`; releasing needs `admin` (a human). |
| `doctor` | Exit 7 if any check fails. |

Mutating commands also accept `--yes` (skip prompt), `--dry-run`, `--idempotency-key`. Exact subcommand coverage follows the build; SPEC.md 7.2 lists planned extras (`policy`, `audit`, `webhook listen`, `mcp serve`).
