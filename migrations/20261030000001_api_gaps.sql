-- Dashboard API gaps: server-side search, approval reasons, domain diagnostics.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Emails `q` (to / from / subject contains, case-insensitive) and contacts `q` (email / name).
CREATE INDEX emails_to_trgm_idx ON emails USING gin (to_addr gin_trgm_ops);
CREATE INDEX emails_from_trgm_idx ON emails USING gin (from_addr gin_trgm_ops);
CREATE INDEX emails_subject_trgm_idx ON emails USING gin (subject gin_trgm_ops);
CREATE INDEX contacts_email_trgm_idx ON contacts USING gin (email gin_trgm_ops);
CREATE INDEX contacts_first_trgm_idx ON contacts USING gin (first_name gin_trgm_ops);
CREATE INDEX contacts_last_trgm_idx ON contacts USING gin (last_name gin_trgm_ops);

ALTER TABLE approvals ADD COLUMN reason text CHECK (reason IS NULL OR char_length(reason) <= 500);

ALTER TABLE domains ADD COLUMN last_checked_at timestamptz;
ALTER TABLE domain_records ADD COLUMN found text;  -- what DNS actually returned when the record is wrong
