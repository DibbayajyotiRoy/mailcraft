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

Resources: `emails` (send/get/list/cancel), `domains` (create/verify/list/get/remove), `templates` (create/get/list/update/publish/preview/import/export), `contacts` (upsert/get/list/update/remove), `events.track`, `automations` (create/get/list/update/publish/pause/resume/simulate/runs), `approvals` (list/get), `keys.list`, `settings.instructions` (get/set/clear), `killSwitch.get`. Approvals can only be read; deciding is a human action.

`src/schema.d.ts` is generated from `openapi.yaml` (`npm run generate`) and currently covers `POST /v1/emails` only. Other types are hand-written from `docs/ASSUMED-ENDPOINTS.md` until the spec grows.
