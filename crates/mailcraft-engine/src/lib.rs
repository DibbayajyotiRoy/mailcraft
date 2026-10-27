//! Queue worker skeleton. Postgres is the queue (SPEC section 8, `emails` + `jobs`).
use mailcraft_core::transport::Transport;
use std::{sync::Arc, time::Duration};

/// Claim due rows without blocking other workers. The lease (`locked_until`) lets a
/// reaper requeue rows from crashed workers. Partial index: `emails_due_idx`.
pub const CLAIM_SQL: &str = "\
UPDATE emails SET status = 'sending', locked_by = $1, locked_until = now() + interval '5 minutes', attempts = attempts + 1
WHERE id IN (
  SELECT id FROM emails
  WHERE status IN ('queued','deferred') AND next_attempt_at <= now()
  ORDER BY next_attempt_at
  FOR UPDATE SKIP LOCKED
  LIMIT $2)
RETURNING id";

pub struct Worker {
    pub pool: sqlx::PgPool,
    pub transport: Arc<dyn Transport>,
    pub id: String,
    pub batch: i64,
    pub poll: Duration,
}

impl Worker {
    /// One claim pass. Skeleton: claims rows, does not yet render/send (engine work package).
    pub async fn tick(&self) -> Result<usize, sqlx::Error> {
        let rows = sqlx::query(CLAIM_SQL)
            .bind(&self.id)
            .bind(self.batch)
            .fetch_all(&self.pool)
            .await?;
        tracing::debug!(
            claimed = rows.len(),
            transport = self.transport.id(),
            "tick"
        );
        Ok(rows.len())
    }

    pub async fn run(&self) -> Result<(), sqlx::Error> {
        loop {
            if self.tick().await? == 0 {
                tokio::time::sleep(self.poll).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn claim_uses_skip_locked() {
        assert!(super::CLAIM_SQL.contains("FOR UPDATE SKIP LOCKED"));
    }
}
