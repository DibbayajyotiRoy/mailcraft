-- Per-workspace daily LLM spend, charged atomically by mailcraft-llm's PgBudget.
CREATE TABLE llm_budget_usage (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day          date NOT NULL,                 -- UTC day
  tokens       bigint NOT NULL DEFAULT 0,
  cost_usd     double precision NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day)
);
