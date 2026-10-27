//! Warm-up pacer: per (sending identity, destination provider) daily caps from a ramp table.
//!
//! HEURISTIC: the ramp numbers are our own guidance (research/deliverability.md section 3.3),
//! loosely based on vendor doubling guidance (SendGrid: 50 on day 1, doubling). They are not rules.
//! Tune from real bounce/complaint data; back off manually when bounce >2%, complaints >0.1%.
use crate::provider::Provider;
use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

/// Counter store for warm-up caps, pause markers and per-destination throttles.
/// [`RedisCounters`] is the production impl (Lua, atomic); [`MemoryCounters`] is for tests/dev.
/// Redis losing its data costs accuracy for a day, not mail: the warm-up *stage* lives in Postgres.
#[async_trait]
pub trait CounterStore: Send + Sync {
    /// Atomically increment `key` if the current value is below `cap`. True if incremented.
    /// `ttl_secs` is applied when the key is created.
    async fn try_incr(&self, key: &str, cap: u64, ttl_secs: u64) -> bool;
    async fn used(&self, key: &str) -> u64;
    /// Pause marker (unix seconds until which sending is paused). Never shortens an existing pause.
    async fn set_until(&self, key: &str, until: u64);
    async fn get_until(&self, key: &str) -> Option<u64>;
}

#[derive(Default)]
pub struct MemoryCounters {
    counts: Mutex<HashMap<String, u64>>,
    pauses: Mutex<HashMap<String, u64>>,
}

#[async_trait]
impl CounterStore for MemoryCounters {
    async fn try_incr(&self, key: &str, cap: u64, _ttl: u64) -> bool {
        let mut m = self.counts.lock().unwrap();
        let c = m.entry(key.to_string()).or_insert(0);
        if *c < cap {
            *c += 1;
            true
        } else {
            false
        }
    }
    async fn used(&self, key: &str) -> u64 {
        *self.counts.lock().unwrap().get(key).unwrap_or(&0)
    }
    async fn set_until(&self, key: &str, until: u64) {
        let mut m = self.pauses.lock().unwrap();
        let e = m.entry(key.to_string()).or_insert(0);
        *e = (*e).max(until);
    }
    async fn get_until(&self, key: &str) -> Option<u64> {
        self.pauses.lock().unwrap().get(key).copied()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RampProfile {
    /// New/cold IP: 50,100,500,1k,2.5k,5k,10k,20k,40k,80k then +30%/day. HEURISTIC.
    Ip,
    /// New domain on a warm IP: 30/day, +25%/day. HEURISTIC.
    Domain,
}

const IP_TABLE: [u64; 10] = [
    50, 100, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 40_000, 80_000,
];

/// Daily cap for 1-based `day` of the ramp, clamped to `target`. Day 0 (before start) = 0.
pub fn daily_cap(profile: RampProfile, day: u32, target: u64) -> u64 {
    if day == 0 {
        return 0;
    }
    let raw = match profile {
        RampProfile::Ip if (day as usize) <= IP_TABLE.len() => IP_TABLE[day as usize - 1] as f64,
        RampProfile::Ip => IP_TABLE[9] as f64 * 1.3f64.powi((day - 10).min(200) as i32),
        RampProfile::Domain => 30.0 * 1.25f64.powi((day - 1).min(200) as i32),
    };
    (raw.min(target as f64)) as u64
}

#[derive(Clone, Debug)]
pub struct WarmupPlan {
    /// Unix seconds of day 1 (any time that day; days are UTC-aligned from this instant's day).
    pub start: u64,
    pub profile: RampProfile,
    /// Steady-state per-provider daily volume; the ramp never exceeds it.
    pub target_daily: u64,
    /// Hard cap for a brand-new tenant's first 7 days (applied on top of the ramp).
    pub first_week_cap: Option<u64>,
}

impl WarmupPlan {
    pub fn day(&self, now: u64) -> u32 {
        if now / DAY < self.start / DAY {
            0
        } else {
            (now / DAY - self.start / DAY + 1) as u32
        }
    }
    pub fn cap(&self, now: u64) -> u64 {
        let day = self.day(now);
        let c = daily_cap(self.profile, day, self.target_daily);
        match self.first_week_cap {
            Some(w) if (1..=7).contains(&day) => c.min(w),
            _ => c,
        }
    }
}

const DAY: u64 = 86_400;

/// Per-destination fixed-window throttle (e.g. at most N sends per minute to one recipient domain
/// or MX), on the same [`CounterStore`]. Fixed windows can burst 2x across a boundary; fine for a
/// politeness limit, not for a hard SLA.
pub struct Throttle<S: CounterStore> {
    pub store: S,
}

impl<S: CounterStore> Throttle<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }
    /// True if the send may proceed now. On false, retry at the next window start
    /// (`(now / window_secs + 1) * window_secs`) without counting an attempt.
    pub async fn allow(&self, destination: &str, limit: u64, window_secs: u64, now: u64) -> bool {
        let key = format!(
            "thr:{destination}:{window_secs}:{}",
            now / window_secs.max(1)
        );
        self.store
            .try_incr(&key, limit, window_secs.max(1) * 2)
            .await
    }
}

/// Redis implementation: one Lua script per operation, so the check-and-increment is atomic across
/// workers. Key shapes: `warm:{sender}:{provider}:{utc-day-number}`, `pause:{sender}:{provider}`,
/// `thr:{dest}:{window}:{bucket}`. Needs Redis 6.2+ (`SET .. EXAT`).
pub struct RedisCounters {
    conn: redis::aio::ConnectionManager,
    incr: redis::Script,
    pause: redis::Script,
    prefix: String,
}

impl RedisCounters {
    pub async fn connect(url: &str) -> redis::RedisResult<Self> {
        let conn = redis::aio::ConnectionManager::new(redis::Client::open(url)?).await?;
        Ok(Self::new(conn, "mc:"))
    }
    pub fn new(conn: redis::aio::ConnectionManager, prefix: &str) -> Self {
        Self {
            conn,
            prefix: prefix.into(),
            incr: redis::Script::new(
                r"local c = tonumber(redis.call('GET', KEYS[1]) or '0')
if c >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
if c == 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 1",
            ),
            pause: redis::Script::new(
                r"local c = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > c then redis.call('SET', KEYS[1], ARGV[1], 'EXAT', ARGV[1]) end
return 1",
            ),
        }
    }
    fn k(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }
}

#[async_trait]
impl CounterStore for RedisCounters {
    async fn try_incr(&self, key: &str, cap: u64, ttl_secs: u64) -> bool {
        let mut c = self.conn.clone();
        // Fail open: losing Redis must not stop mail (ARCHITECTURE: Redis is accuracy, not correctness).
        self.incr
            .key(self.k(key))
            .arg(cap)
            .arg(ttl_secs)
            .invoke_async::<i64>(&mut c)
            .await
            .map(|v| v == 1)
            .unwrap_or(true)
    }
    async fn used(&self, key: &str) -> u64 {
        let mut c = self.conn.clone();
        redis::cmd("GET")
            .arg(self.k(key))
            .query_async::<Option<u64>>(&mut c)
            .await
            .ok()
            .flatten()
            .unwrap_or(0)
    }
    async fn set_until(&self, key: &str, until: u64) {
        let mut c = self.conn.clone();
        let _ = self
            .pause
            .key(self.k(key))
            .arg(until)
            .invoke_async::<i64>(&mut c)
            .await;
    }
    async fn get_until(&self, key: &str) -> Option<u64> {
        let mut c = self.conn.clone();
        redis::cmd("GET")
            .arg(self.k(key))
            .query_async::<Option<u64>>(&mut c)
            .await
            .ok()
            .flatten()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Send now; `remaining` slots left today for this (sender, provider).
    Send { remaining: u64 },
    /// Daily cap reached (or ramp not started): spill to the next UTC day.
    DeferUntil(u64),
    /// A block was recorded for this (sender, provider).
    Paused { until: u64 },
}

pub struct Pacer<S: CounterStore> {
    pub store: S,
}

impl<S: CounterStore> Pacer<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// `sender` = sending domain or IP string.
    pub async fn try_acquire(
        &self,
        sender: &str,
        provider: &Provider,
        plan: &WarmupPlan,
        now: u64,
    ) -> Decision {
        if let Some(until) = self
            .store
            .get_until(&pause_key(sender, provider))
            .await
            .filter(|u| *u > now)
        {
            return Decision::Paused { until };
        }
        let cap = plan.cap(now);
        let key = format!("warm:{sender}:{}:{}", provider.key(), now / DAY);
        if self.store.try_incr(&key, cap, 2 * DAY).await {
            Decision::Send {
                remaining: cap.saturating_sub(self.store.used(&key).await),
            }
        } else {
            Decision::DeferUntil((now / DAY + 1) * DAY)
        }
    }

    /// Pause (sender, provider), e.g. on a block bounce. Never shortens an existing pause.
    pub async fn pause(&self, sender: &str, provider: &Provider, until: u64) {
        self.store
            .set_until(&pause_key(sender, provider), until)
            .await;
    }

    /// Apply a suppression-policy action; ignores non-pause actions.
    pub async fn apply(&self, a: &crate::suppression::Action) {
        if let crate::suppression::Action::PauseSending {
            sender,
            provider,
            until,
        } = a
        {
            self.pause(sender, provider, *until).await;
        }
    }
}

fn pause_key(sender: &str, provider: &Provider) -> String {
    format!("pause:{sender}:{}", provider.key())
}

#[cfg(test)]
mod tests {
    use super::*;
    const T0: u64 = 20_000 * DAY; // aligned to a UTC day start

    #[test]
    fn ramp_shape() {
        assert_eq!(daily_cap(RampProfile::Ip, 1, u64::MAX), 50);
        assert_eq!(daily_cap(RampProfile::Ip, 10, u64::MAX), 80_000);
        assert_eq!(daily_cap(RampProfile::Ip, 11, u64::MAX), 104_000);
        assert_eq!(daily_cap(RampProfile::Ip, 4, 300), 300, "clamped to target");
        assert_eq!(daily_cap(RampProfile::Domain, 1, u64::MAX), 30);
        assert_eq!(daily_cap(RampProfile::Domain, 0, u64::MAX), 0);
        let mut prev = 0;
        for d in 1..60 {
            let c = daily_cap(RampProfile::Ip, d, u64::MAX);
            assert!(c >= prev);
            prev = c;
        }
    }

    #[tokio::test]
    async fn caps_are_per_provider_and_roll_over() {
        let plan = WarmupPlan {
            start: T0,
            profile: RampProfile::Ip,
            target_daily: 1_000_000,
            first_week_cap: Some(60),
        };
        let p = Pacer::new(MemoryCounters::default());
        let gmail = Provider::Gmail;
        for i in 0..50 {
            assert!(
                matches!(
                    p.try_acquire("1.2.3.4", &gmail, &plan, T0 + 10).await,
                    Decision::Send { .. }
                ),
                "{i}"
            );
        }
        assert_eq!(
            p.try_acquire("1.2.3.4", &gmail, &plan, T0 + 11).await,
            Decision::DeferUntil(T0 + DAY)
        );
        // yahoo has its own bucket
        assert_eq!(
            p.try_acquire("1.2.3.4", &Provider::Yahoo, &plan, T0 + 11)
                .await,
            Decision::Send { remaining: 49 }
        );
        // day 2: cap 100 but first-week cap is 60
        let mut sent = 0;
        while matches!(
            p.try_acquire("1.2.3.4", &gmail, &plan, T0 + DAY + 5).await,
            Decision::Send { .. }
        ) {
            sent += 1;
        }
        assert_eq!(sent, 60);
        // before the plan starts nothing goes
        assert!(matches!(
            p.try_acquire("x", &gmail, &plan, T0 - 1).await,
            Decision::DeferUntil(_)
        ));
    }

    #[tokio::test]
    async fn pause_blocks_only_that_pair() {
        let plan = WarmupPlan {
            start: T0,
            profile: RampProfile::Ip,
            target_daily: 1_000_000,
            first_week_cap: None,
        };
        let p = Pacer::new(MemoryCounters::default());
        p.pause("1.2.3.4", &Provider::Microsoft, T0 + 600).await;
        assert_eq!(
            p.try_acquire("1.2.3.4", &Provider::Microsoft, &plan, T0 + 1)
                .await,
            Decision::Paused { until: T0 + 600 }
        );
        assert!(matches!(
            p.try_acquire("1.2.3.4", &Provider::Gmail, &plan, T0 + 1)
                .await,
            Decision::Send { .. }
        ));
        assert!(matches!(
            p.try_acquire("5.6.7.8", &Provider::Microsoft, &plan, T0 + 1)
                .await,
            Decision::Send { .. }
        ));
        assert!(matches!(
            p.try_acquire("1.2.3.4", &Provider::Microsoft, &plan, T0 + 601)
                .await,
            Decision::Send { .. }
        ));
    }
}
