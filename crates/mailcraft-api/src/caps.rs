//! Redis counters (fast path) with Postgres as the authoritative fallback (SPEC 8.2).
//! A flushed or absent Redis costs accuracy for a window, never correctness of the cap:
//! a fresh counter is re-seeded from Postgres before it is trusted.
use chrono::{DurationRound, TimeDelta, Utc};
use redis::AsyncCommands;

use crate::{
    auth::{too_many, ApiKey},
    error::ApiError,
    state::AppState,
};

pub async fn rate_limit(st: &AppState, key: &ApiKey) -> Result<(), ApiError> {
    let Some(mut r) = st.redis.clone() else {
        return Ok(());
    };
    let k = format!("rl:{}:{}", key.id, Utc::now().timestamp() / 60);
    let n: Result<i64, _> = r.incr(&k, 1).await;
    match n {
        Ok(n) => {
            if n == 1 {
                let _: Result<(), _> = r.expire(&k, 70).await;
            }
            if n > st.config.rate_limit_per_min {
                return Err(too_many(
                    "rate_limited",
                    format!(
                        "more than {} requests per minute for this key",
                        st.config.rate_limit_per_min
                    ),
                    "back off and retry after the Retry-After header",
                ));
            }
        }
        Err(e) => tracing::warn!(error = %e, "redis rate limit unavailable"),
    }
    Ok(())
}

/// Counters taken for one request; `release` returns them if the send does not go ahead.
#[derive(Default)]
pub struct Reservation {
    taken: Vec<(String, i64)>,
}

impl Reservation {
    pub async fn release(self, st: &AppState) {
        if let Some(mut r) = st.redis.clone() {
            for (k, n) in self.taken {
                let _: Result<i64, _> = r.decr(k, n).await;
            }
        }
    }
}

async fn pg_count(
    st: &AppState,
    key: &ApiKey,
    since: chrono::DateTime<Utc>,
) -> Result<i64, ApiError> {
    Ok(
        sqlx::query_scalar(
            "SELECT count(*) FROM emails WHERE api_key_id = $1 AND created_at >= $2",
        )
        .bind(key.id)
        .bind(since)
        .fetch_one(&st.db)
        .await?,
    )
}

/// Reserves `n` sends against the key's daily and per-minute caps.
pub async fn reserve(st: &AppState, key: &ApiKey, n: i64) -> Result<Reservation, ApiError> {
    let now = Utc::now();
    let day = now.duration_trunc(TimeDelta::days(1)).unwrap_or(now);
    let minute = now.duration_trunc(TimeDelta::minutes(1)).unwrap_or(now);
    let windows = [
        (
            key.daily_cap,
            format!("cap:{}:{}", key.id, now.format("%Y%m%d")),
            48 * 3600,
            day,
            "daily",
            false,
        ),
        (
            key.minute_cap,
            format!("cap:{}:m:{}", key.id, now.format("%Y%m%d%H%M")),
            70,
            minute,
            "per-minute",
            true,
        ),
    ];
    let mut res = Reservation::default();
    for (cap, rkey, ttl, since, label, retryable) in windows {
        let Some(cap) = cap.map(i64::from) else {
            continue;
        };
        let used = match st.redis.clone() {
            Some(mut r) => match r.incr::<_, _, i64>(&rkey, n).await {
                Ok(mut v) => {
                    res.taken.push((rkey.clone(), n));
                    if v == n {
                        // Fresh (or flushed) counter: seed with what Postgres already knows.
                        let _: Result<(), _> = r.expire(&rkey, ttl).await;
                        let seen = pg_count(st, key, since).await?;
                        if seen > 0 {
                            v = r.incr(&rkey, seen).await.unwrap_or(v + seen);
                            res.taken.push((rkey.clone(), seen));
                        }
                    }
                    v
                }
                Err(e) => {
                    tracing::warn!(error = %e, "redis cap counter unavailable, using Postgres");
                    pg_count(st, key, since).await? + n
                }
            },
            None => pg_count(st, key, since).await? + n,
        };
        if used > cap {
            res.release(st).await;
            let mut e = too_many(
                "send_cap_exceeded",
                format!("this key's {label} send cap of {cap} would be exceeded"),
                "wait for the window to reset, or ask an admin to raise the cap (agents cannot)",
            );
            e.0.retryable = retryable;
            return Err(e);
        }
    }
    Ok(res)
}
