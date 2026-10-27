# Endpoints the agent surface (CLI, MCP, SDK, dashboard) depends on

Contract between the surface and the API. Real shapes for what is on `main` live in `openapi.yaml` and are pinned by
`docs/contract/fixtures.json` (every client's contract test serves it). **Update the fixture first when the API changes.**
Anything below marked `NEW` is not on `main` yet: the API must implement it exactly as written (and add it to `openapi.yaml`).

## Conventions (all routes)
- Envelope: `{ok:true,data,request_id,next_cursor?}` / `{ok:false,error:{code,message,field?,hint?,doc_url,retryable},request_id}`. Lists put the array in `data`; `next_cursor` is `null` when done.
- Auth `Authorization: Bearer mc_test_<32>|mc_live_<32>`. Mutating routes accept `Idempotency-Key` (24 h replay).
- Ids are plain UUIDs. Timestamps RFC 3339 UTC. Pagination: `?limit=&cursor=` (cursor is opaque; audit uses `?before=<int id>`).
- Test keys: magic recipients `delivered|bounced|complained|suppressed|deferred[+label]@test.mailcraft.local`.
- Scopes: `read`, `send`, `manage`, `admin`. Agent keys never hold `admin`. Approval decide: `admin` only. Kill switch: engage `manage` or `admin`; disengage `admin`.
- Error codes the clients map to CLI exit codes: `unauthenticated`/`forbidden_scope` -> 3; `blocked_by_policy`, `recipient_not_allowed`, `recipient_suppressed`, `domain_not_verified`, `send_cap_exceeded`, `kill_switch_active`, `test_key_live_recipient` -> 4; `rate_limited` (and 502-504) -> 5; `not_found` -> 6; `invalid_request` -> 2; else 1. `pending_approval` is a 202 result status, not an error.

## On main and used as-is
`POST/GET /v1/emails`, `GET /v1/emails/{id}` (+`/events`, `POST /cancel`), `POST /v1/emails/batch`, `POST/GET /v1/keys`, `GET/PATCH/DELETE /v1/keys/{id}`, `GET /v1/approvals`, `GET /v1/approvals/{id}`, `POST /v1/approvals/{id}/decide {decision:"approve"|"reject"}` -> `{id,status:"approved"|"rejected"}`, `POST /v1/go-live-requests`, `POST /v1/policy/proposals`, `GET|POST /v1/kill-switch` (`GET` -> `{on,paused_keys[]}`, `POST {on,key_id?}` -> `{on,key_id}`), `GET /v1/audit`, `GET /v1/account/status` -> `{workspace,kill_switch,live_enabled,pending_approvals,key:{id,name,env,scopes[]}}`, webhooks, `/healthz`, `/readyz`.
Email object (list/get): `{id,status,stream,env,from_addr,to_addr,subject,tags[],policy_decisions[],scheduled_at,attempts,last_error,sent_at,created_at}`; statuses `queued|pending_approval|sending|deferred|sent|delivered|bounced|failed|suppressed|cancelled`. List filter: `?status=` only. Events: `[{type,enhanced_code,diagnostic,occurred_at}]`.
Create key: `{name,env:"test"|"live",scopes[read|send|manage]}` required; response `{id,name,env,scopes,token,prefix}` (token shown once).

## Routes on main that answer 501 until their service is wired (WP3/WP4); bodies the clients expect
- `POST /v1/domains {domain,stream?}` 201 -> `{id,name,status,records[{record,type,name,value,priority?,status}]}`; `GET /v1/domains` -> array of the same; `GET|DELETE /v1/domains/{id}`; `POST /v1/domains/{id}/verify` 200 -> the domain (status `not_started|pending|verified|failed`); `POST /v1/domains/{id}/rotate-dkim`. Errors: `domain_exists` 409, `domain_not_found` 404.
- `PUT /v1/contacts {email,first_name?,last_name?,timezone?,properties?}` -> `{id,email,properties}`; `GET /v1/contacts?limit=&cursor=`; `GET|DELETE /v1/contacts/{id_or_email}`; `POST /v1/contacts/{id}/suppress {reason?}`.
- `POST /v1/events {name,contact:{email},properties?,contact_properties?,dry_run?}` 202 (200 for dry run) -> `{event_id,contact_id,triggered_automations[{id,run_id}],would_send[]}`.
- `POST|GET /v1/segments`, `POST /v1/segments/{id}/members {emails[]}`.

## NEW (not on main): the API worker implements exactly this
Scopes in brackets.

1. `GET /v1/account/status` additive fields [read]: `delivery_path:{kind:"sandbox"|"gmail-oauth"|"smtp-relay"|"ses"|"direct",detail?}`, `limits:{daily_send_cap?,minute_send_cap?}`. Clients tolerate absence (doctor shows `unknown`).
2. `POST /v1/setup {admin_email?}` (no auth; only valid before the first admin exists, else 409 `invalid_state`) 201 -> `{admin_key,test_key}` (secrets once). CLI `init` uses it when no key is configured.
3. Transports [manage]: `POST /v1/transports {kind:"smtp-relay"|"gmail-oauth"|"ses"|"direct",preset?,config:{host?,port?,username?,password?}}` 201 -> `{id,kind,from?,status}` (secrets write-only); `GET /v1/transports` -> array; `POST /v1/transports/{id}/test` 200 -> `{ok:bool,detail}`.
4. Gmail OAuth [manage]: `POST /v1/transports/gmail/oauth/start {redirect_uri}` -> `{auth_url,state}`; `POST /v1/transports/gmail/oauth/complete {state,code,redirect_uri}` -> `{id,kind:"gmail-oauth",from}`. Errors `invalid_request` for a bad state. Google client id/secret are instance env.
5. Templates [manage; GET read]: `POST /v1/templates {name,subject?,html?,mjml?,text?,variables?[]}` 201 -> `{id,name,subject?,status:"draft"|"published",...}`; `GET /v1/templates?limit=&cursor=`; `GET|PATCH /v1/templates/{id}`; `POST /v1/templates/{id}/publish`; `POST /v1/templates/{id}/preview {variables}` 200 -> `{subject,html,text,lint[]}` (undefined variable -> 422 `template_render_failed`); `POST /v1/templates/import {format:"html"|"mjml"|"json",name,content}` 201 -> template; `GET /v1/templates/{id}/export?format=html|mjml|json` -> `{format,content}`; `POST /v1/content/lint {subject?,html?,text?}` -> `{lint[{rule,severity,message}]}`.
6. Contacts `PATCH /v1/contacts/{id_or_email} {properties?,first_name?,last_name?,timezone?}` -> contact [manage].
7. Event definitions [manage]: `POST /v1/event-definitions {name,schema?}`, `GET /v1/event-definitions`.
8. Automations [manage; GET read]: `POST /v1/automations {name,trigger,entry_rule?,goal?,approval?,caps?,steps[]}` 201 -> `{id,name,status:"draft"|"active"|"paused",trigger,steps}`; `GET /v1/automations`; `GET|PATCH /v1/automations/{id}`; `POST /v1/automations/{id}/publish|pause|resume`; `POST /v1/automations/{id}/simulate {event?}` -> run trace, nothing sent; `GET /v1/automations/{id}/runs?status=&limit=&cursor=`.
9. Policy [GET read, PUT admin]: `GET /v1/policy` -> `{keys:[{key_id,policy}]}` (workspace default `{send:"auto"|"needs_approval"|"blocked"}` under `default`); `PUT /v1/policy {default}`. Agents use `POST /v1/policy/proposals` (on main).
10. `GET /v1/stats/overview?days=7` [read] -> `{totals:{sent,delivered,bounced,complained,deferred},series:[{date,sent,delivered,bounced,complained}]}` (dashboard overview).
11. `GET|PUT /v1/settings` [read / admin] -> `{llm_provider:{kind,model?,base_url?,api_key_set:bool},delivery_path,default_from,reply_to}`; secrets write-only.
12. `GET /v1/doctor` [read] -> `{checks:[{id,status:"pass"|"fail"|"warn"|"skipped",detail,hint}]}` (dns_records, redis, postgres, transport_auth, dmarc_policy, ...). The CLI merges these with local probes (port 25, FCrDNS, blocklists).
13. `GET /v1/suppressions` [read] (SPEC 7.1), not used by this surface.
