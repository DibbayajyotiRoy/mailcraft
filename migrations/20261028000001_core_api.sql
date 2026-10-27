-- core-api additions (WP1): per-key kill switch, approval decider key, webhook failure counter,
-- append-only audit log enforcement.

ALTER TABLE api_keys ADD COLUMN paused boolean NOT NULL DEFAULT false;  -- per-key kill switch
ALTER TABLE approvals ADD COLUMN decided_by_key uuid REFERENCES api_keys(id);
ALTER TABLE webhook_endpoints ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_endpoints ADD COLUMN description text;
CREATE INDEX approvals_status_idx ON approvals (workspace_id, status, created_at DESC);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- audit_log is append-only: no UPDATE / DELETE / TRUNCATE, even for the app role.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
