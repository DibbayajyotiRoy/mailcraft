-- Dashboard automations editor: archived automations (hidden, never run), and the event-name suggestions query.
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_status_check;
ALTER TABLE automations ADD CONSTRAINT automations_status_check CHECK (status IN ('draft','active','paused','archived'));
CREATE INDEX IF NOT EXISTS track_events_ws_received_idx ON track_events (workspace_id, received_at DESC);
