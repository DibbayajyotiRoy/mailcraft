-- Per-domain routing: sends from this domain use this transport (NULL = the workspace default).
ALTER TABLE domains ADD COLUMN transport_id uuid REFERENCES transports(id) ON DELETE SET NULL;
