-- WP4 (automations): indexes and a uniqueness rule the engine relies on. No table shape changes.

-- `install` upserts an automation by (workspace, name) and publishes a new version.
CREATE UNIQUE INDEX IF NOT EXISTS automations_ws_name_idx ON automations (workspace_id, name);

-- Matcher: events nobody matched yet.
CREATE INDEX IF NOT EXISTS track_events_unmatched_idx ON track_events (received_at) WHERE matched_at IS NULL;

-- Cancel-on-exit, frequency caps and per-automation caps look emails up by run / contact + source.
CREATE INDEX IF NOT EXISTS emails_automation_run_idx ON emails (automation_run_id) WHERE automation_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS emails_contact_source_idx ON emails (contact_id, created_at DESC) WHERE source = 'automation';

CREATE INDEX IF NOT EXISTS automation_run_steps_run_idx ON automation_run_steps (run_id, id);
CREATE INDEX IF NOT EXISTS automation_runs_contact_idx ON automation_runs (contact_id, automation_id);
