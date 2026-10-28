-- Broadcasts: one template sent to a list. Every recipient is an ordinary `emails` row
-- (source = 'broadcast') linked by `broadcast_id`, so gates, caps, approvals and the worker are shared.

CREATE TABLE broadcasts (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  api_key_id    uuid REFERENCES api_keys(id),
  template_id   uuid NOT NULL REFERENCES templates(id),
  from_addr     text NOT NULL,
  subject       text NOT NULL DEFAULT '',   -- override; '' = the template's own subject
  stream        text NOT NULL CHECK (stream IN ('transactional','marketing')),
  env           text NOT NULL CHECK (env IN ('test','live')),
  total         integer NOT NULL,           -- rows queued (excludes `skipped`)
  skipped       jsonb NOT NULL DEFAULT '[]',-- [{email, reason, detail?}] left out at creation
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broadcasts_ws_created_idx ON broadcasts (workspace_id, created_at DESC, id);

ALTER TABLE emails ADD COLUMN broadcast_id uuid REFERENCES broadcasts(id);
CREATE INDEX emails_broadcast_idx ON emails (broadcast_id, id) WHERE broadcast_id IS NOT NULL;
