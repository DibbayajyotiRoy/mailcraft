# Endpoints assumed by the agent surface (CLI, MCP, SDK, dashboard)

`openapi.yaml` currently has only `/healthz` and `POST /v1/emails`. Everything else follows SPEC.md 7.1.
Envelope everywhere (SPEC 4.1): `{ok:true,data,request_id,next_cursor?}` / `{ok:false,error:{code,message,field?,hint?,doc_url,retryable},request_id}`.
Auth: `Authorization: Bearer mc_test_...|mc_live_...`. Mutating routes take `Idempotency-Key`. Lists: `?limit=&cursor=`.

From SPEC 7.1 (route list is in the spec, body shapes are assumed from its examples):
- Emails: `POST /v1/emails`, `GET /v1/emails`, `GET /v1/emails/{id}`, `POST /v1/emails/{id}/cancel`, `GET /v1/emails/{id}/events`, `POST /v1/emails/batch`
- Domains: `POST /v1/domains {domain,stream?}` -> `{id,name,status,records[{record,type,name,value,priority?,status}]}`, `GET /v1/domains`, `GET /v1/domains/{id}`, `POST /v1/domains/{id}/verify` (200 with `status` verified|pending|failed), `DELETE /v1/domains/{id}`
- Transports: `POST /v1/transports {kind,preset?,config}`, `GET /v1/transports`, `POST /v1/transports/{id}/test`
- Templates: `POST/GET /v1/templates`, `GET/PATCH /v1/templates/{id}`, `POST /v1/templates/{id}/publish`, `POST /v1/templates/{id}/preview {variables}` -> `{subject,html,text,lint[]}`, `POST /v1/templates/import {format:html|mjml|json,name,content}`, `GET /v1/templates/{id}/export?format=html|mjml|json` -> `{format,content}`, `POST /v1/content/lint`
- Contacts: `PUT /v1/contacts`, `GET /v1/contacts`, `GET|PATCH|DELETE /v1/contacts/{id_or_email}`, `POST /v1/contacts/{id}/suppress`; `POST|GET /v1/segments`
- Events: `POST /v1/events {name,contact:{email},properties,dry_run}`, `GET|POST /v1/event-definitions`
- Automations: `POST|GET /v1/automations`, `GET|PATCH /v1/automations/{id}`, `POST /v1/automations/{id}/publish|pause|resume|simulate`, `GET /v1/automations/{id}/runs`
- Approvals: `GET /v1/approvals`, `GET /v1/approvals/{id}`, `POST /v1/approvals/{id}/decide {decision:"approve"|"reject"}` (refused for agent keys)
- Keys/policy: `POST|GET /v1/keys`, `DELETE /v1/keys/{id}`, `GET|PUT /v1/policy`, `POST /v1/policy/proposals`
- Ops: `GET /v1/account/status`, `POST /v1/go-live-requests`, `GET /v1/audit`, `POST /v1/kill-switch {on:bool}`, `GET /healthz`, `GET /readyz`

NOT in SPEC 7.1 - invented here, WP1 must add or tell us the real shape:
1. `GET /v1/kill-switch` -> `{on:bool,since?,by?}` (status; also surfaced as `kill_switch` in account status).
2. `GET /v1/account/status` data: `{env:"test"|"live", scopes[], key_prefix, kill_switch:bool, pending_approvals:int, delivery_path:{kind:"sandbox"|"gmail-oauth"|"smtp-relay"|"ses"|"direct", detail?}, verified:bool, limits:{daily_send_cap?,minute_send_cap?}}`.
3. `POST /v1/setup {admin_email?}` (unauthenticated, only valid before the first admin exists; SPEC §16 first-run `/setup`) -> `{admin_key,test_key}` (secrets shown once). CLI `init` uses it when no key is configured.
4. Gmail OAuth: `POST /v1/transports/gmail/oauth/start {redirect_uri}` -> `{auth_url,state}`; after Google redirects to the CLI loopback, `POST /v1/transports/gmail/oauth/complete {state,code,redirect_uri}` -> transport `{id,kind:"gmail-oauth",from}`. (Google OAuth client id/secret are instance env, per self-hoster.)
5. `GET /v1/stats/overview?days=7` -> `{totals:{sent,delivered,bounced,complained,deferred},series:[{date,sent,delivered,bounced,complained}]}` (dashboard overview).
6. `GET|PUT /v1/settings` -> `{llm_provider:{kind,model?,base_url?,api_key_set:bool}, delivery_path, default_from, reply_to}` (dashboard settings). Secrets are write-only.
7. `GET /v1/doctor` -> `{checks[{id,status:pass|fail|warn|skipped,detail,hint}]}` (server-side checks: dns_records, redis, postgres, transport_auth, dmarc_policy, ...). CLI doctor merges these with local probes (port 25, FCrDNS, blocklists).
8. `GET /v1/suppressions`, `GET /v1/webhooks` are as SPEC; not used by this surface except MCP.
9. Emails list filters: `?status=&to=&since=`; email object: `{id,from,to[],subject,status,stream,created_at,last_event}`; detail adds `events[]`, `policy_decisions[]`, `rendered{html,text}`.
10. Domain `status`: `not_started|pending|verified|failed`.
