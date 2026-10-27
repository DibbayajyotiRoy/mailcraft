//! Per-tenant daily token/cost budget with atomic check-and-charge.
//!
//! Flow: `reserve` an estimate BEFORE the provider call (fails if it would exceed the cap,
//! and charges in the same atomic step), then `settle` with the actual usage afterwards
//! (a provider error settles with 0, refunding the reservation).
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("daily budget exceeded for tenant {tenant}: {reason}")]
pub struct BudgetExceeded {
    pub tenant: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy)]
pub struct BudgetLimits {
    pub max_tokens_per_day: u64,
    pub max_cost_usd_per_day: f64,
}

#[async_trait]
pub trait BudgetGuard: Send + Sync {
    /// Atomically charge the estimate if `used + estimate` stays within the limits.
    async fn reserve(
        &self,
        tenant: &str,
        est_tokens: u64,
        est_cost_usd: f64,
    ) -> Result<(), BudgetExceeded>;
    /// Replace the reservation with actual usage (adds `actual - estimate`, may be negative).
    async fn settle(
        &self,
        tenant: &str,
        est_tokens: u64,
        est_cost_usd: f64,
        actual_tokens: u64,
        actual_cost_usd: f64,
    );
}

pub struct NoBudget;
#[async_trait]
impl BudgetGuard for NoBudget {
    async fn reserve(&self, _: &str, _: u64, _: f64) -> Result<(), BudgetExceeded> {
        Ok(())
    }
    async fn settle(&self, _: &str, _: u64, _: f64, _: u64, _: f64) {}
}

/// In-memory impl for tests and single-process use. `day` is injected so UTC rollover is testable.
pub struct InMemoryBudget {
    limits: BudgetLimits,
    day: Box<dyn Fn() -> u64 + Send + Sync>,
    used: Mutex<HashMap<(String, u64), (i64, f64)>>,
}

impl InMemoryBudget {
    pub fn new(limits: BudgetLimits, day: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            limits,
            day: Box::new(day),
            used: Mutex::default(),
        }
    }
    /// Days since epoch (UTC).
    pub fn utc_day() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() / 86_400)
            .unwrap_or(0)
    }
    /// (tokens, usd) used today by `tenant`.
    pub fn used(&self, tenant: &str) -> (i64, f64) {
        self.used
            .lock()
            .unwrap()
            .get(&(tenant.to_string(), (self.day)()))
            .copied()
            .unwrap_or_default()
    }
}

#[async_trait]
impl BudgetGuard for InMemoryBudget {
    async fn reserve(
        &self,
        tenant: &str,
        est_tokens: u64,
        est_cost: f64,
    ) -> Result<(), BudgetExceeded> {
        let mut m = self.used.lock().unwrap();
        let e = m.entry((tenant.to_string(), (self.day)())).or_default();
        let (t, c) = (e.0 + est_tokens as i64, e.1 + est_cost);
        let reason = if t > self.limits.max_tokens_per_day as i64 {
            format!(
                "{t} tokens would exceed limit {}",
                self.limits.max_tokens_per_day
            )
        } else if c > self.limits.max_cost_usd_per_day {
            format!(
                "${c:.4} would exceed limit ${:.4}",
                self.limits.max_cost_usd_per_day
            )
        } else {
            *e = (t, c);
            return Ok(());
        };
        Err(BudgetExceeded {
            tenant: tenant.into(),
            reason,
        })
    }
    async fn settle(
        &self,
        tenant: &str,
        est_tokens: u64,
        est_cost: f64,
        actual_tokens: u64,
        actual_cost: f64,
    ) {
        let mut m = self.used.lock().unwrap();
        let e = m.entry((tenant.to_string(), (self.day)())).or_default();
        e.0 += actual_tokens as i64 - est_tokens as i64;
        e.1 += actual_cost - est_cost;
    }
}

/// Postgres-backed budget (table `llm_budget_usage`, see migrations/20261028000001_llm_budget.sql).
/// `tenant` is the workspace UUID as a string; an unparsable id fails closed.
pub struct PgBudget {
    pool: sqlx::PgPool,
    limits: BudgetLimits,
}

impl PgBudget {
    pub fn new(pool: sqlx::PgPool, limits: BudgetLimits) -> Self {
        Self { pool, limits }
    }
}

#[async_trait]
impl BudgetGuard for PgBudget {
    async fn reserve(
        &self,
        tenant: &str,
        est_tokens: u64,
        est_cost: f64,
    ) -> Result<(), BudgetExceeded> {
        let deny = |reason: String| BudgetExceeded {
            tenant: tenant.into(),
            reason,
        };
        let ws: uuid::Uuid = tenant
            .parse()
            .map_err(|_| deny("tenant is not a workspace uuid".into()))?;
        // One statement = atomic check-and-charge. The INSERT arm is guarded by the same
        // limit test (first charge of the day); the UPDATE arm by the WHERE clause.
        let row: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO llm_budget_usage AS u (workspace_id, day, tokens, cost_usd)
             SELECT $1, (now() AT TIME ZONE 'utc')::date, $2, $3 WHERE $2 <= $4 AND $3 <= $5
             ON CONFLICT (workspace_id, day) DO UPDATE
               SET tokens = u.tokens + $2, cost_usd = u.cost_usd + $3, updated_at = now()
               WHERE u.tokens + $2 <= $4 AND u.cost_usd + $3 <= $5
             RETURNING u.tokens",
        )
        .bind(ws)
        .bind(est_tokens as i64)
        .bind(est_cost)
        .bind(self.limits.max_tokens_per_day as i64)
        .bind(self.limits.max_cost_usd_per_day)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| deny(format!("budget store unavailable: {e}")))?;
        row.map(|_| ())
            .ok_or_else(|| deny("daily LLM token or USD cap reached".into()))
    }

    async fn settle(
        &self,
        tenant: &str,
        est_tokens: u64,
        est_cost: f64,
        actual_tokens: u64,
        actual_cost: f64,
    ) {
        let Ok(ws) = tenant.parse::<uuid::Uuid>() else {
            return;
        };
        let r = sqlx::query(
            "UPDATE llm_budget_usage SET tokens = tokens + $2, cost_usd = cost_usd + $3, updated_at = now()
             WHERE workspace_id = $1 AND day = (now() AT TIME ZONE 'utc')::date",
        )
        .bind(ws)
        .bind(actual_tokens as i64 - est_tokens as i64)
        .bind(actual_cost - est_cost)
        .execute(&self.pool)
        .await;
        if let Err(e) = r {
            eprintln!("llm budget settle failed: {e}"); // ponytail: no tracing dep here; reservation stays charged (safe side)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn caps_per_tenant_settles_and_resets_daily() {
        let day = Arc::new(AtomicU64::new(1));
        let d = day.clone();
        let b = InMemoryBudget::new(
            BudgetLimits {
                max_tokens_per_day: 100,
                max_cost_usd_per_day: 1.0,
            },
            move || d.load(Ordering::SeqCst),
        );
        b.reserve("a", 100, 0.0).await.unwrap();
        assert!(b.reserve("a", 1, 0.0).await.is_err());
        assert!(b.reserve("b", 1, 0.0).await.is_ok());
        b.settle("a", 100, 0.0, 40, 0.0).await; // refund 60
        b.reserve("a", 60, 0.0).await.unwrap();
        day.store(2, Ordering::SeqCst);
        assert!(b
            .reserve("a", 1, 1.5)
            .await
            .unwrap_err()
            .reason
            .contains("exceed"));
        b.reserve("a", 1, 0.5).await.unwrap();
    }
}
