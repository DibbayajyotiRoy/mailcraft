# @dibbayajyotiroy/mailcraft

Typed TypeScript client for the mailcraft API. Node 22+ (global `fetch`), zero runtime dependencies.

```sh
npm i @dibbayajyotiroy/mailcraft
```

```ts
import { Mailcraft } from "@dibbayajyotiroy/mailcraft";

const mailcraft = new Mailcraft(process.env.MAILCRAFT_API_KEY!, { baseUrl: "https://mail.example.com" });

const { data, error } = await mailcraft.emails.send(
  {
    from: "Acme <hello@notify.example.com>",
    to: ["ana@example.org"],
    subject: "Welcome",
    html: "<p>Hello Ana</p>",
  },
  { idempotencyKey: "welcome-user_123" },
);

if (error) {
  console.error(error.code, error.message, error.hint); // e.g. domain_not_verified
  if (error.retryable) { /* retry with the same idempotencyKey */ }
} else {
  console.log(data.id, data.status); // queued | pending_approval | blocked_by_policy
}
```

Methods never throw for API or network errors; they return `{ data, error }` (plus `requestId`, and `nextCursor` on lists). `error` is `{ code, message, field?, hint?, doc_url?, retryable }`.

### Broadcasts

```ts
// Dry run first: nothing is stored; `skipped` says why a row was dropped and `schedule` how it is paced.
const body = {
  template_id: "welcome", // id or alias
  from: "Acme <hello@notify.example.com>",
  recipients: [{ email: "ana@example.org", first_name: "Ana", data: { plan: "pro" } }], // up to 5000
};
const dry = await mailcraft.broadcasts.create({ ...body, dry_run: true });
console.log(dry.data?.queued, dry.data?.skipped, dry.data?.schedule);

const sent = await mailcraft.broadcasts.create(body, { idempotencyKey: "welcome-2026-10" });
// 202: status queued | pending_approval (poll approvals.get with data.approval_id, never decide)
const progress = await mailcraft.broadcasts.get(sent.data!.id!); // counts + per-recipient status
```

Test keys sandbox every broadcast. `broadcasts.preview({ template_id, recipient })` renders one recipient exactly as it would be sent.

Resources and methods:

| Resource | Methods |
|---|---|
| `emails` | `send` `batch` `get` `list` (filters `status` `stream` `env` `q` `from` `to`) `events` `cancel` |
| `broadcasts` | `create` (`dry_run`) `list` `get` `preview` |
| `domains` | `create` `verify` `list` `get` `remove` (records carry `checked_at` `detail` `found`; domains `last_checked_at` `relay_sender`) |
| `transports` | `create` (`config.mailbox_sender`) `list` `test` `remove` |
| `templates` | `create` `get` (adds `source_format` + `source`) `list` `update` (alias, stream, preheader) `publish` (`{ version }`) `preview` (saved `version` or unsaved `draft` content) `versions` `version` `restore` `discardDraft` `import` `export` |
| `contacts` | `upsert` `get` `list` (`q`) `update` `remove` `activity` `import` (up to 5000, bad rows come back in `failed`) |
| `segments` | `create` `list` `preview` `update` `remove` `addMembers` |
| `events` | `track` `names` |
| `automations` | `create` `get` `list` (`status`) `publish` `pause` `resume` `archive` `unarchive` `test` `run` `runs` |
| `approvals` | `list` `get` `decide(id, decision, reason?)` (admin key only; agent keys get 403) |
| `keys`, `killSwitch`, `settings.instructions`, `account`, `goLive`, `policy`, `audit` | see `src/index.ts` |

`automations.test` starts a real run for one contact: a test key keeps mail in the sandbox, a live key sends. `templates.discardDraft` and `segments.remove` cannot be undone.

`src/schema.d.ts` is generated from `openapi.yaml` (`npm run generate`; re-run it after the spec changes) and covers every route. The response types used by the client come from it where the spec defines the body (broadcasts, `PatchTemplate`); the rest are hand-written in `src/index.ts` from the API handlers.
