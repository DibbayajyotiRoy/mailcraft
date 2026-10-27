//! Volatile counters/flags: Redis when configured, in-process otherwise (SPEC 8.2).
//! Nothing here is needed for correctness; losing it costs accuracy for a window.
use redis::aio::ConnectionManager;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Limits {
    redis: Option<ConnectionManager>,
    mem: Mutex<HashMap<String, (i64, Instant)>>,
}

impl Limits {
    pub fn in_process() -> Self {
        Self::default()
    }
    pub async fn redis(url: &str) -> redis::RedisResult<Self> {
        let c = redis::Client::open(url)?;
        Ok(Self {
            redis: Some(ConnectionManager::new(c).await?),
            mem: Default::default(),
        })
    }
    pub fn has_redis(&self) -> bool {
        self.redis.is_some()
    }

    fn mem_incr(&self, key: &str, ttl: u64, by: i64) -> i64 {
        let mut m = self.mem.lock().unwrap();
        let now = Instant::now();
        if m.len() > 10_000 {
            m.retain(|_, v| v.1 > now);
        }
        let e = m
            .entry(key.into())
            .or_insert((0, now + Duration::from_secs(ttl)));
        if e.1 <= now {
            *e = (0, now + Duration::from_secs(ttl));
        }
        e.0 += by;
        e.0
    }

    /// INCR with a TTL set on first increment. Returns the new value.
    pub async fn incr(&self, key: &str, ttl: u64) -> i64 {
        if let Some(c) = &self.redis {
            let mut c = c.clone();
            let r: redis::RedisResult<(i64, bool)> = redis::pipe()
                .atomic()
                .incr(key, 1)
                .expire(key, ttl as i64)
                .arg("NX")
                .query_async(&mut c)
                .await;
            match r {
                Ok((v, _)) => return v,
                Err(e) => tracing::warn!(error = %e, "redis incr failed, using in-process counter"),
            }
        }
        self.mem_incr(key, ttl, 1)
    }

    pub async fn decr(&self, key: &str) {
        if let Some(c) = &self.redis {
            let mut c = c.clone();
            if redis::cmd("DECR")
                .arg(key)
                .query_async::<i64>(&mut c)
                .await
                .is_ok()
            {
                return;
            }
        }
        let mut m = self.mem.lock().unwrap();
        if let Some(e) = m.get_mut(key) {
            e.0 -= 1;
        }
    }

    pub async fn set_flag(&self, key: &str, ttl: u64) {
        if let Some(c) = &self.redis {
            let mut c = c.clone();
            if redis::cmd("SET")
                .arg(key)
                .arg(1)
                .arg("EX")
                .arg(ttl)
                .query_async::<()>(&mut c)
                .await
                .is_ok()
            {
                return;
            }
        }
        let mut m = self.mem.lock().unwrap();
        m.insert(key.into(), (1, Instant::now() + Duration::from_secs(ttl)));
    }

    pub async fn flag(&self, key: &str) -> bool {
        if let Some(c) = &self.redis {
            let mut c = c.clone();
            if let Ok(n) = redis::cmd("EXISTS")
                .arg(key)
                .query_async::<i64>(&mut c)
                .await
            {
                if n > 0 {
                    return true;
                }
            }
        }
        self.mem
            .lock()
            .unwrap()
            .get(key)
            .is_some_and(|v| v.1 > Instant::now())
    }

    /// `SET NX PX`: true when this caller got the lock (leader locks, e.g. `lock:reaper`).
    pub async fn try_lock(&self, key: &str, ttl: Duration) -> bool {
        if let Some(c) = &self.redis {
            let mut c = c.clone();
            let r: redis::RedisResult<Option<String>> = redis::cmd("SET")
                .arg(key)
                .arg(1)
                .arg("NX")
                .arg("PX")
                .arg(ttl.as_millis() as u64)
                .query_async(&mut c)
                .await;
            if let Ok(v) = r {
                return v.is_some();
            }
        }
        true // ponytail: without Redis every process runs the (idempotent) reaper
    }
}
