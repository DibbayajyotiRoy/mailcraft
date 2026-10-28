# Contact sources and lists

mailcraft can **pull** its contact list from another product's internal HTTP API.
You register a URL and an API key that identifies mailcraft; mailcraft calls it every few minutes and
upserts what comes back. There is no database connection to the other product, and the other product
never calls mailcraft.

Everything lands in a **list** named after the source, so you can always tell where a contact came from.

## Using it

Dashboard: Settings, Contact sources. API: `POST /v1/contact-sources` with `{name, url, key, interval_minutes?, list_name?}`
(scope `manage`). Then `POST /v1/contact-sources/{id}/sync` runs it now; the background loop runs every enabled source each
`interval_minutes` (default 15, 1 to 1440). `POST /v1/contact-sources/test` fetches one page and shows what came back
(field names only) without writing anything.

The key is sealed with `MAILCRAFT_SECRET_KEY` and never returned, logged or audited. Rotate it with
`PATCH /v1/contact-sources/{id}` `{key}`. The URL may be a private or loopback address; it must be `http(s)`, carry no
credentials, and answer JSON. Redirects are followed only within the same scheme, host and port, so the key never
leaves the origin you configured.

## The pull contract (what a product implements)

```
GET <source url>?limit=500&cursor=<opaque>&updated_since=<RFC3339>
Authorization: Bearer <source key>
```

`cursor` and `updated_since` are omitted when not needed: a full read has no `updated_since`, and the first page has no
`cursor`. When `updated_since` is sent it is sent on every page. `limit` is at most 1000 (mailcraft asks for 500).

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
| `external_id` | Required string, stable for the person, at most 200 characters. This is how a re-sync finds the same contact. |
| `email` | Required. Invalid addresses are skipped and counted. |
| `first_name`, `last_name`, `timezone` | Optional or `null`. `null` means "unknown", never "clear": it does not change what mailcraft already has (the same goes for a `null` value inside `properties`). `timezone` must be an IANA name (`Europe/Berlin`); an invalid one is dropped (the contact is still imported) and counted as `invalid_timezone`. |
| `updated_at` | Required RFC 3339. Drives the incremental sync. |
| `created_at` | Informational. |
| `synced_at` (top level) | The source's clock, taken **before** it starts reading. mailcraft resumes from it (see below). |
| `deleted` | `true` means the person is gone on your side: deleted or suspended (see below). `properties.status` may say which: `deleted`, `suspended` or `active`. |
| `properties` | Optional JSON object. Merged shallowly into the contact's attributes. |

Server obligations:

* Order rows by `(updated_at, external_id)` ascending. When mailcraft stops at a cap (50,000 rows or 5 minutes per run) it
  resumes from the newest `updated_at` it saw, which is only correct for ordered rows.
* `updated_since` is **inclusive**. mailcraft sends its watermark minus 5 minutes, so rows are delivered more than once;
  that is harmless (upserts are idempotent) and covers clock skew and in-flight transactions.
* Return `synced_at` and take it before the read starts. A run that reads to the last page resumes from the `synced_at` of
  its first page; without one it falls back to the newest `updated_at`.
* Fields computed at read time (usage, plan, credits) do not move `updated_at`, so an incremental read cannot see them
  change. That is why mailcraft also reads **everything** (no `updated_since`) every `full_sync_hours` (default 24, 0 = never)
  and on the first run.
* Rate limits: mailcraft fetches pages one at a time, at least 200 ms apart. On `429` it waits `Retry-After` (1 s if absent,
  doubling) and retries up to 3 times before recording an error.
* Follow `next_cursor` until it is `null`. Pages hold at most `limit` rows (mailcraft treats more than 1000 as a broken source).
* Include deleted people with `"deleted": true` and a fresh `updated_at`; otherwise mailcraft cannot learn about deletions.
* Answer within 10 seconds per request and keep a page under 20 MB.
* Status codes: `401` or `403` means the key is wrong; `429` and `5xx` mean try again later. Anything else is an error.

## What a sync does to a contact

* **Identity**: `(source, external_id)`. A re-sync updates the same contact. If the person's email changes in the source, the
  contact's email is changed too, unless another contact already has that address (then the old address is kept, the rest
  still syncs, and the run notes `email_conflict`). An existing contact with the same email and no source yet is adopted.
  An address owned by a different `external_id` is left alone (`duplicate_email`).
* **Attributes**: `properties` keys from the source overwrite the same keys; keys a person set in mailcraft are never removed.
  Names and timezone from the source overwrite when present.
* **Opt-outs are permanent**: a sync never clears a suppression or an unsubscribe. If a suppressed person's email changes in the
  source, the new address inherits the opt-out (unsubscribe, complaint, manual, source_deleted).
* **Deletions**: `deleted: true` suppresses the address with reason `source_deleted`, or `source_suspended` when
  `properties.status` is `suspended`. The contact is kept (with its history), not deleted. A deleted row for someone mailcraft
  never had is skipped (`deleted_unknown`). Suppressions are never lifted automatically: a reinstated account stays suppressed
  until someone removes it (`DELETE /v1/suppressions/{email}`).
* **List**: every synced contact joins the source's list. Renaming the list is fine. Removing a contact from it by hand is undone by
  the next sync that returns that contact.

## Runs, watermark and errors

A run pages until `next_cursor` is `null`, or stops early at 50,000 rows, 400 pages, 5 minutes or shutdown. The **watermark**
moves only when a run finishes or stops at a cap, so a failed run retries from the same place. A finished run sets it to the
source's `synced_at` from the first page; a run stopped at a cap sets it to the newest `updated_at` it saw. It is never in the
future. A full read completes only if it reaches the last page, so a source with more than 50,000 contacts cannot finish one
(it still syncs incrementally). After a failure `last_status` is `error` and `last_error` says why (`the source rejected the API key (HTTP 401)`, `the source
is unavailable (HTTP 503)`, ...); the next attempt is one interval later. Changing the URL clears the watermark.

`last_counts`: `{created, updated, skipped, deleted, fetched, reasons}`. `skipped` rows were not imported; `reasons` counts why
(`invalid_email`, `invalid_properties`, `invalid_external_id`, `malformed`, `duplicate_email`, `deleted_unknown`, `conflict`) and also
notes fixes that did not skip a row (`invalid_timezone`, `email_conflict`).

Only one run per source at a time, across instances: a Postgres advisory lock held on its own connection (released when that
connection ends, so a crash cannot leave a source stuck). `POST .../sync` while another run is active answers `409 sync_in_progress`.

Deleting a source never deletes contacts or suppressions. Its list stays as a **detached** list unless you delete it with the source
(`DELETE /v1/contact-sources/{id}?delete_list=true`).

## Lists

A list is a manual segment (a segment without rules) that also records its `origin`: `manual`, `import` (a CSV import) or `source`.
A contact can be on many lists.

| | |
|---|---|
| `POST/GET /v1/lists`, `GET/PATCH/DELETE /v1/lists/{id}` | Create, read, rename or describe, delete. Deleting a list never touches contacts or suppressions. A list fed by a source cannot be deleted directly. |
| `POST /v1/lists/{id}/members`, `POST /v1/lists/{id}/members/remove` | Bulk add or remove by `contact_ids` and/or `emails` (1 to 1000 in total). |
| `GET /v1/contacts?list=<id or name>` | Contacts on a list. Every contact object carries `lists: [{id, name, origin}]`. |
| `POST /v1/contacts/import` `{list_id \| list_name, contacts}` | Adds every imported contact (new or existing) to a list; `list_name` finds or creates it. |
| Segment rule field `list:<id or name>` | `{"field":"list:Webinar","op":"eq","value":true}` is true for members. Segments only, like `days_since:`. |
| `POST /v1/broadcasts` `{list_id, ...}` | The list is the audience (up to 5000 members). Suppressed and opted-out members are skipped like any inline row. |
| Automations | The `segment.entered` trigger and the `add_to_segment` step work on a list, since a list is a segment. |

Membership never overrides a suppression: a suppressed contact on a list still receives nothing.

## Previewing

`POST /v1/contacts/import` with `dry_run: true`, and `POST /v1/contact-sources/{id}/sync?dry_run=true`, answer what each row
would do (`new`, `update` with `{field, old, new}` changes, `unchanged`, `skipped` with a reason) and change nothing. The source
preview reads only the first page, so treat it as a sample. The dashboard shows both as a diff table.

## Implementing the other side

Any product can serve this. A minimal implementation reads `updated_since` (inclusive) and `cursor` (for example `base64(updated_at|external_id)`
of the last row sent), selects `WHERE (updated_at, external_id) > cursor AND updated_at >= updated_since ORDER BY updated_at, external_id LIMIT limit+1`,
and returns `next_cursor` when the extra row exists. Authenticate with a dedicated key that can read only this endpoint.
