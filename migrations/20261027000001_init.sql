-- mailcraft initial schema. Mirrors SPEC.md section 8. Postgres 15+.
-- Single-tenant per instance for the MVP, but every table carries workspace_id so
-- multi-tenant (v1) is not a rewrite (architecture.md 3.1).

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  legal_name    text,                 -- CAN-SPAM footer; marketing sends blocked if NULL
  postal_address text,
  kill_switch   boolean NOT NULL DEFAULT false,   -- checked at dequeue time
  live_enabled  boolean NOT NULL DEFAULT false,   -- human-approved go-live
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  email         text NOT NULL UNIQUE,
  password_hash text,                 -- argon2id
  role          text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','member')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  prefix        text NOT NULL,        -- display only, e.g. mc_test_ab12
  token_hash    bytea NOT NULL UNIQUE,-- sha256 of the secret (high-entropy, so no argon2)
  env           text NOT NULL CHECK (env IN ('test','live')),
  scopes        text[] NOT NULL,      -- read | send | manage | admin
  domain_id     uuid,                 -- optional restriction (FK added below)
  policy        jsonb NOT NULL DEFAULT '{}',   -- {"send":"auto|needs_approval|blocked", ...}
  recipient_allowlist text[],         -- NULL = no restriction (live), test keys force it
  daily_send_cap  integer,
  minute_send_cap integer,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domains (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,        -- sending (From) domain, e.g. mail.example.com
  stream        text NOT NULL DEFAULT 'transactional' CHECK (stream IN ('transactional','marketing')),
  status        text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','pending','verified','failed')),
  return_path_host text NOT NULL,     -- bounce.<name>, VERP envelope domain
  tracking_host text,                 -- click.<name> (marketing only)
  tls_mode      text NOT NULL DEFAULT 'opportunistic' CHECK (tls_mode IN ('opportunistic','enforced')),
  open_tracking  boolean NOT NULL DEFAULT false,
  click_tracking boolean NOT NULL DEFAULT false,
  dns_provider  text,                 -- 'cloudflare' when auto-managed
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_domain_fk FOREIGN KEY (domain_id) REFERENCES domains(id);

CREATE TABLE dkim_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  selector      text NOT NULL,        -- s2026a; never reused
  algorithm     text NOT NULL DEFAULT 'rsa-sha256' CHECK (algorithm IN ('rsa-sha256','ed25519-sha256')),
  public_key    text NOT NULL,
  private_key_enc bytea NOT NULL,     -- encrypted with MAILCRAFT_SECRET_KEY
  state         text NOT NULL DEFAULT 'active' CHECK (state IN ('standby','active','retired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  retired_at    timestamptz,
  UNIQUE (domain_id, selector)
);

CREATE TABLE domain_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  record        text NOT NULL CHECK (record IN ('DKIM','SPF','DMARC','ReturnPath','Tracking','MX')),
  type          text NOT NULL CHECK (type IN ('TXT','CNAME','MX')),
  name          text NOT NULL,
  value         text NOT NULL,
  priority      integer,
  status        text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','pending','verified','failed')),
  checked_at    timestamptz,
  detail        text                  -- why it failed (hint for the agent)
);

-- Transports (plugins) configured for the workspace. Secrets encrypted at rest.
CREATE TABLE transports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  kind          text NOT NULL CHECK (kind IN ('smtp-relay','ses','gmail-oauth','direct','kumomta')),
  name          text NOT NULL,
  config_enc    bytea NOT NULL,
  is_default    boolean NOT NULL DEFAULT false,
  label         text NOT NULL DEFAULT 'production' CHECK (label IN ('test','low-volume','production')),
  daily_cap     integer,              -- e.g. 500 for free Gmail
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  alias         text NOT NULL,
  name          text NOT NULL,
  stream        text NOT NULL DEFAULT 'transactional' CHECK (stream IN ('transactional','marketing')),
  current_version_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, alias)
);
CREATE TABLE template_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  doc           jsonb NOT NULL,       -- canonical block tree (SPEC 11)
  source_format text NOT NULL DEFAULT 'json' CHECK (source_format IN ('json','mjml','html','react-email')),
  source_raw    text,
  mjml_cache    text,
  html_cache    text,
  variables     jsonb NOT NULL DEFAULT '[]',
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
ALTER TABLE templates ADD CONSTRAINT templates_current_fk FOREIGN KEY (current_version_id) REFERENCES template_versions(id);

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  email         text NOT NULL,        -- normalised (lowercased domain, trimmed)
  first_name    text,
  last_name     text,
  properties    jsonb NOT NULL DEFAULT '{}',
  timezone      text,
  consent       jsonb,                -- {at, ip, source, text} (consent ledger)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);
CREATE TABLE segments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  filter        jsonb,                -- NULL = static membership only
  UNIQUE (workspace_id, name)
);
CREATE TABLE segment_members (
  segment_id    uuid NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, contact_id)
);
CREATE TABLE topics (                   -- unsubscribe categories
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  key           text NOT NULL,        -- product | digest | account
  name          text NOT NULL,
  default_opt_in boolean NOT NULL DEFAULT true,
  can_unsubscribe boolean NOT NULL DEFAULT true,  -- false for account notices
  UNIQUE (workspace_id, key)
);
CREATE TABLE contact_topics (
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  topic_id      uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  opted_in      boolean NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, topic_id)
);

CREATE TABLE suppressions (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  email         text NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('hard_bounce','soft_bounce_limit','complaint','unsubscribe','manual','spam_trap')),
  source        text,
  email_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email)
);

-- Outbound mail. Doubles as the send queue (status + next_attempt_at + lease).
CREATE TABLE emails (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  api_key_id    uuid REFERENCES api_keys(id),
  domain_id     uuid REFERENCES domains(id),
  transport_id  uuid REFERENCES transports(id),
  stream        text NOT NULL CHECK (stream IN ('transactional','marketing')),
  env           text NOT NULL DEFAULT 'live' CHECK (env IN ('test','live')),
  source        text NOT NULL DEFAULT 'api' CHECK (source IN ('api','cli','mcp','broadcast','automation')),
  from_addr     text NOT NULL,
  to_addr       text NOT NULL,        -- one row per recipient (keeps VERP exact)
  cc            text[] NOT NULL DEFAULT '{}',
  reply_to      text,
  subject       text NOT NULL,
  template_id   uuid REFERENCES templates(id),
  template_vars jsonb,
  headers       jsonb NOT NULL DEFAULT '{}',
  tags          jsonb NOT NULL DEFAULT '[]',
  contact_id    uuid REFERENCES contacts(id),
  automation_run_id uuid,
  generation_id uuid,                 -- llm_generations.id when content was LLM-written
  idempotency_key text,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN
                  ('queued','pending_approval','sending','deferred','sent','delivered','bounced','failed','suppressed','cancelled')),
  policy_decisions jsonb NOT NULL DEFAULT '[]',
  scheduled_at  timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_age_at    timestamptz,          -- give up after this (24-72h; 1h for auth mail)
  locked_by     text,
  locked_until  timestamptz,
  rcpt_domain   text GENERATED ALWAYS AS (lower(split_part(to_addr, '@', 2))) STORED,
  provider_message_id text,
  message_id    text,                 -- RFC 5322 Message-ID
  last_error    text,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emails_due_idx ON emails (next_attempt_at) WHERE status IN ('queued','deferred');
CREATE INDEX emails_rcpt_domain_idx ON emails (rcpt_domain);
CREATE INDEX emails_workspace_created_idx ON emails (workspace_id, created_at DESC);
CREATE INDEX emails_contact_idx ON emails (contact_id, created_at DESC);
CREATE UNIQUE INDEX emails_idem_idx ON emails (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE email_bodies (             -- large, prunable
  email_id      uuid PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  html          text,
  text          text
);

-- Append-only. Provider-normalised event set: sent, delivered, delivery_delayed, bounced,
-- complained, opened, clicked, failed, suppressed, unsubscribed.
CREATE TABLE email_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  email_id      uuid NOT NULL REFERENCES emails(id),
  type          text NOT NULL,
  bounce_class  text CHECK (bounce_class IN ('hard','soft','block')),
  enhanced_code text,                 -- RFC 3463, e.g. 5.1.1
  diagnostic    text,
  link_id       uuid,
  is_bot        boolean NOT NULL DEFAULT false,
  provider_event_id text UNIQUE,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  outboxed_at   timestamptz           -- NULL until fanned out to webhooks (outbox)
);
CREATE INDEX email_events_email_idx ON email_events (email_id);
CREATE INDEX email_events_outbox_idx ON email_events (id) WHERE outboxed_at IS NULL;

-- Events API (trigger side of automations).
CREATE TABLE event_defs (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  schema        jsonb,
  description   text,
  PRIMARY KEY (workspace_id, name)
);
CREATE TABLE track_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  contact_id    uuid NOT NULL REFERENCES contacts(id),
  name          text NOT NULL,
  properties    jsonb NOT NULL DEFAULT '{}',
  idempotency_key text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  matched_at    timestamptz           -- NULL until the automation matcher ran
);
CREATE INDEX track_events_contact_idx ON track_events (contact_id, name, received_at DESC);
CREATE UNIQUE INDEX track_events_idem_idx ON track_events (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE automations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  trigger_event text NOT NULL,
  entry_rule    text NOT NULL DEFAULT 'once' CHECK (entry_rule IN ('once','always','after_days','if_no_active_run')),
  entry_days    integer,
  goal          jsonb,                -- exits the run when matched
  approval      text NOT NULL DEFAULT 'first_n:5',
  caps          jsonb NOT NULL DEFAULT '{}',
  current_version integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE automation_versions (      -- immutable once published
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  steps         jsonb NOT NULL,       -- array of {key,type,config,next}
  published_at  timestamptz,
  PRIMARY KEY (automation_id, version)
);
CREATE TABLE automation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES automations(id),
  version       integer NOT NULL,
  contact_id    uuid NOT NULL REFERENCES contacts(id),
  entry_key     text NOT NULL,        -- idempotent entry per trigger event
  state         text NOT NULL DEFAULT 'active' CHECK (state IN ('active','waiting','completed','exited','failed')),
  current_step  text,
  context       jsonb NOT NULL DEFAULT '{}',
  wait_event    text,                 -- set while in wait_for_event
  wait_filter   jsonb,
  next_wake_at  timestamptz,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  UNIQUE (automation_id, contact_id, entry_key)
);
CREATE INDEX automation_runs_wake_idx ON automation_runs (next_wake_at) WHERE state IN ('active','waiting');
CREATE INDEX automation_runs_wait_idx ON automation_runs (contact_id, wait_event) WHERE state = 'waiting';
CREATE TABLE automation_run_steps (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  step_key      text NOT NULL,
  result        jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now()
);

-- LLM generations: every call stored for audit, replay and cost.
CREATE TABLE llm_generations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  provider      text NOT NULL,
  model         text NOT NULL,
  automation_id uuid,
  context_hash  text NOT NULL,
  prompt_version text NOT NULL,
  output        jsonb,
  validator     jsonb NOT NULL,       -- {passed, issues[], spam_score}
  attempt       integer NOT NULL DEFAULT 1,
  used_fallback boolean NOT NULL DEFAULT false,
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd      numeric(12,6),
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  kind          text NOT NULL CHECK (kind IN ('email','broadcast','automation_first_send','policy_change','go_live')),
  subject_id    uuid,
  requested_by  uuid REFERENCES api_keys(id),
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  url           text NOT NULL,
  events        text[] NOT NULL DEFAULT '{*}',
  secret_enc    bytea NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- = webhook-id header
  endpoint_id   uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  last_status_code integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE idempotency_keys (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  key           text NOT NULL,
  request_hash  bytea NOT NULL,
  response      jsonb NOT NULL,
  status_code   integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)    -- rows older than 24h are purged
);

-- Warm-up stage lives in Postgres (must survive a Redis flush); counters live in Redis.
CREATE TABLE warmup_state (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  domain_id     uuid NOT NULL REFERENCES domains(id),
  rcpt_provider text NOT NULL,        -- gmail | yahoo | outlook | other
  stage         integer NOT NULL DEFAULT 1,
  started_at    timestamptz NOT NULL DEFAULT now(),
  paused_until  timestamptz,
  PRIMARY KEY (domain_id, rcpt_provider)
);

-- Append-only, hash-chained: row_hash = sha256(prev_hash || canonical(row)).
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  at            timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  actor_id      uuid,
  action        text NOT NULL,        -- tool / route name
  args          jsonb NOT NULL DEFAULT '{}',   -- secrets redacted
  decision      text NOT NULL,        -- auto | needs_approval | blocked | approved | rejected
  approval_id   uuid REFERENCES approvals(id),
  prev_hash     bytea,
  row_hash      bytea NOT NULL
);
CREATE INDEX audit_log_ws_idx ON audit_log (workspace_id, id DESC);

-- Generic job table for work that is not an email row (webhook fan-out, DMARC ingest,
-- blocklist polls, reaper). Same SKIP LOCKED claim as emails.
CREATE TABLE jobs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue         text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 10,
  locked_until  timestamptz,
  state         text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','running','done','dead')),
  last_error    text
);
CREATE INDEX jobs_ready_idx ON jobs (queue, run_at) WHERE state = 'ready';
