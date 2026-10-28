-- Contact sources: mailcraft pulls its contacts from another product's HTTP API (docs/CONTACT-SOURCES.md).
-- Lists: a manual segment (filter IS NULL) that remembers where its members came from.

CREATE TABLE contact_sources (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  url              text NOT NULL,
  key_enc          bytea NOT NULL,          -- SecretBox(api key), AAD = id
  enabled          boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL DEFAULT 15 CHECK (interval_minutes BETWEEN 1 AND 1440),
  full_sync_hours  integer NOT NULL DEFAULT 24 CHECK (full_sync_hours BETWEEN 0 AND 720),  -- 0 = never read everything again
  last_full_at     timestamptz,             -- when a run last read the whole source
  watermark        timestamptz,             -- where the next incremental run resumes (minus an overlap)
  last_run_at      timestamptz,
  last_status      text CHECK (last_status IN ('ok','error')),
  last_error       text,
  last_counts      jsonb,                   -- {created, updated, skipped, deleted, fetched, reasons}
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- A contact pulled from a source keeps the source's id for it, so a re-sync updates instead of duplicating.
ALTER TABLE contacts
  ADD COLUMN external_source_id uuid REFERENCES contact_sources(id) ON DELETE SET NULL,
  ADD COLUMN external_id text;
CREATE UNIQUE INDEX contacts_external_idx ON contacts (external_source_id, external_id) WHERE external_source_id IS NOT NULL;

ALTER TABLE suppressions DROP CONSTRAINT suppressions_reason_check;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_reason_check
  CHECK (reason IN ('hard_bounce','soft_bounce_limit','complaint','unsubscribe','manual','spam_trap','source_deleted','source_suspended'));

ALTER TABLE segments
  ADD COLUMN description text CHECK (description IS NULL OR char_length(description) <= 500),
  ADD COLUMN origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','import','source')),
  ADD COLUMN source_id uuid REFERENCES contact_sources(id) ON DELETE SET NULL,   -- NULL + origin 'source' = detached
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX segments_source_idx ON segments (source_id) WHERE source_id IS NOT NULL;
-- "which lists is this contact in" (badges) and "contacts of this list" share the PK; this is the reverse side.
CREATE INDEX segment_members_contact_idx ON segment_members (contact_id);
