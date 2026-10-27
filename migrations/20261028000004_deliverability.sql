-- WP3 mailcraft-deliverability: persist the DNS plan per domain and widen domain_records for the
-- records the planner can emit (MTA-STS, TLS-RPT). Additive; the init schema is untouched.

-- The full planner output (records, direct-TXT alternatives, warnings, created_unix) so `verify`
-- can re-check without re-planning, and so rotation can append records.
CREATE TABLE domain_plans (
  domain_id   uuid PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  plan        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE domain_records DROP CONSTRAINT domain_records_record_check;
ALTER TABLE domain_records ADD CONSTRAINT domain_records_record_check
  CHECK (record IN ('DKIM','SPF','DMARC','ReturnPath','Tracking','MX','MTASTS','TLSRPT'));
-- planner purpose (dkim_cname, return_path_mx, ...): the stable key for status updates.
ALTER TABLE domain_records ADD COLUMN purpose text;
CREATE UNIQUE INDEX domain_records_purpose_idx ON domain_records (domain_id, purpose, name) WHERE purpose IS NOT NULL;

-- Exactly one active key per (domain, algorithm); a standby is the pre-published next selector.
CREATE UNIQUE INDEX dkim_keys_one_active_idx ON dkim_keys (domain_id, algorithm) WHERE state = 'active';
