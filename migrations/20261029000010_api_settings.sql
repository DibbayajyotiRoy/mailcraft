-- API: dashboard settings (default_from, reply_to, llm_provider; secrets sealed, write-only).
ALTER TABLE workspaces ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
