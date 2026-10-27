//! Integration tests against a throwaway Postgres (and Redis for the cap/throttle test):
//!   docker run -d --rm --name mc-pg-engine -e POSTGRES_PASSWORD=x -p 55433:5432 postgres:17-alpine
//!   docker run -d --rm --name mc-redis-engine -p 56380:6379 redis:7-alpine
//! Override with MC_TEST_PG / MC_TEST_REDIS. Tests skip (loudly) when Postgres is unreachable.
use async_trait::async_trait;
use mailcraft_core::transport::{DeliveryResult, Outbound, Transport};
use mailcraft_engine::{Engine, EngineConfig, Limits, ResolvedTransport, StaticResolver};
use mailcraft_transport::{ClassifiedTransport, SendReceipt, TransportError};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

const MIGRATION: &str = include_str!("../../../migrations/20261027000001_init.sql");

fn pg_url() -> String {
    std::env::var("MC_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55433/postgres".into())
}
fn redis_url() -> String {
    std::env::var("MC_TEST_REDIS").unwrap_or_else(|_| "redis://127.0.0.1:56380".into())
}

/// A fresh database per test.
async fn db() -> Option<PgPool> {
    let admin = match PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&pg_url())
        .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("SKIP: postgres unreachable at {}: {e}", pg_url());
            return None;
        }
    };
    let name = format!("mc_t_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .unwrap();
    let url = format!("{}/{name}", pg_url().rsplit_once('/').unwrap().0);
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .connect(&url)
        .await
        .unwrap();
    sqlx::raw_sql(MIGRATION).execute(&pool).await.unwrap();
    Some(pool)
}

struct Fx {
    ws: Uuid,
    key: Uuid,
    domain: Uuid,
}

async fn fixture(pool: &PgPool, daily: Option<i32>, minute: Option<i32>) -> Fx {
    let ws: Uuid = sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ('t') RETURNING id")
        .fetch_one(pool)
        .await
        .unwrap();
    let key: Uuid = sqlx::query_scalar(
        "INSERT INTO api_keys (workspace_id, name, prefix, token_hash, env, scopes, daily_send_cap, minute_send_cap)
         VALUES ($1, 'k', 'mc_live_x', $2, 'live', '{send}', $3, $4) RETURNING id",
    )
    .bind(ws)
    .bind(Uuid::new_v4().as_bytes().to_vec())
    .bind(daily)
    .bind(minute)
    .fetch_one(pool)
    .await
    .unwrap();
    let domain: Uuid = sqlx::query_scalar(
        "INSERT INTO domains (workspace_id, name, return_path_host) VALUES ($1, 'mail.example.com', 'bounce.mail.example.com') RETURNING id",
    )
    .bind(ws)
    .fetch_one(pool)
    .await
    .unwrap();
    Fx { ws, key, domain }
}

async fn enqueue(pool: &PgPool, fx: &Fx, to: &str, env: &str) -> Uuid {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO emails (workspace_id, api_key_id, domain_id, stream, env, from_addr, to_addr, subject)
         VALUES ($1, $2, $3, 'transactional', $4, 'Ann <ann@mail.example.com>', $5, 'Hi') RETURNING id",
    )
    .bind(fx.ws)
    .bind(fx.key)
    .bind(fx.domain)
    .bind(env)
    .bind(to)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO email_bodies (email_id, html, text) VALUES ($1, '<p>hi</p>', 'hi')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn status(pool: &PgPool, id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM emails WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn events(pool: &PgPool, id: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT type FROM email_events WHERE email_id = $1 ORDER BY id")
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap()
}
async fn make_due(pool: &PgPool) {
    sqlx::query("UPDATE emails SET next_attempt_at = now() WHERE status = 'deferred'")
        .execute(pool)
        .await
        .unwrap();
}

/// Transport that replays scripted results (then succeeds) and records every call.
#[derive(Default)]
struct Scripted {
    script: Mutex<VecDeque<Result<SendReceipt, TransportError>>>,
    calls: Mutex<Vec<Uuid>>,
    last: Mutex<Option<(Vec<String>, String)>>,
    delay_ms: u64,
}
impl Scripted {
    fn new(script: Vec<Result<SendReceipt, TransportError>>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            ..Default::default()
        })
    }
    fn calls(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}
#[async_trait]
impl Transport for Scripted {
    fn id(&self) -> &'static str {
        "scripted"
    }
    async fn deliver(&self, m: &Outbound) -> DeliveryResult {
        mailcraft_transport::to_delivery_result(self.submit(m).await)
    }
}
#[async_trait]
impl ClassifiedTransport for Scripted {
    async fn submit_all(
        &self,
        m: &Outbound,
        rcpts: &[String],
    ) -> Result<SendReceipt, TransportError> {
        self.calls.lock().unwrap().push(m.email_id);
        *self.last.lock().unwrap() = Some((rcpts.to_vec(), String::from_utf8_lossy(&m.raw).into()));
        if self.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
        }
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(SendReceipt {
                provider_message_id: Some("p1".into()),
            }))
    }
}

fn engine(pool: &PgPool, t: Arc<Scripted>, name: &str) -> Engine {
    let r = ResolvedTransport {
        id: None,
        name: name.into(),
        transport: t,
    };
    Engine::new(pool.clone(), Arc::new(StaticResolver(r))).config(EngineConfig {
        dest_per_minute: 0,
        ..Default::default()
    })
}

fn ok() -> Result<SendReceipt, TransportError> {
    Ok(SendReceipt {
        provider_message_id: Some("p1".into()),
    })
}

#[tokio::test]
async fn sandbox_enqueue_claim_send_delivered_event() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let id = enqueue(&pool, &fx, "delivered@test.mailcraft.local", "test").await;
    let e = engine(&pool, Scripted::new(vec![]), "unused");
    assert_eq!(e.tick("w1").await.unwrap(), 1);
    assert_eq!(status(&pool, id).await, "delivered");
    assert_eq!(events(&pool, id).await, ["sent", "delivered"]);
    let unboxed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM email_events WHERE email_id = $1 AND outboxed_at IS NULL",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unboxed, 2, "events wait in the webhook outbox");
    assert_eq!(e.sandbox().inbox().len(), 1);
    let raw = String::from_utf8(e.sandbox().inbox()[0].raw.clone()).unwrap();
    assert!(raw.contains("Subject: Hi") && raw.contains("multipart/alternative"));
    assert_eq!(
        e.sandbox().inbox()[0].mail_from,
        format!("bounce+{}@bounce.mail.example.com", id.simple())
    );
    assert!(
        e.metrics
            .render()
            .contains("status=\"delivered\",transport=\"sandbox\",env=\"test\""),
        "{}",
        e.metrics.render()
    );
}

#[tokio::test]
async fn sandbox_magic_addresses() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let e = engine(&pool, Scripted::new(vec![]), "unused");

    let b = enqueue(&pool, &fx, "bounced+a@x.test", "test").await;
    let c = enqueue(&pool, &fx, "complained@x.test", "test").await;
    let s = enqueue(&pool, &fx, "suppressed@x.test", "test").await;
    let d = enqueue(&pool, &fx, "deferred@x.test", "test").await;
    e.tick("w1").await.unwrap();

    assert_eq!(status(&pool, b).await, "bounced");
    assert_eq!(events(&pool, b).await, ["bounced"]);
    let row =
        sqlx::query("SELECT bounce_class, enhanced_code FROM email_events WHERE email_id = $1")
            .bind(b)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (row.get::<String, _>(0), row.get::<String, _>(1)),
        ("hard".into(), "5.1.1".into())
    );
    let sup: i64 = sqlx::query_scalar("SELECT count(*) FROM suppressions WHERE email = 'bounced+a@x.test' AND reason = 'hard_bounce'").fetch_one(&pool).await.unwrap();
    assert_eq!(sup, 1);

    assert_eq!(status(&pool, c).await, "delivered");
    assert_eq!(events(&pool, c).await, ["sent", "delivered", "complained"]);
    assert_eq!(status(&pool, s).await, "suppressed");
    assert_eq!(events(&pool, s).await, ["suppressed"]);

    assert_eq!(status(&pool, d).await, "deferred");
    assert_eq!(events(&pool, d).await, ["delivery_delayed"]);
    make_due(&pool).await;
    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, d).await, "delivered");
}

#[tokio::test]
async fn temporary_failure_retries_on_schedule_then_sends() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let id = enqueue(&pool, &fx, "bob@example.org", "live").await;
    let t = Scripted::new(vec![
        Err(TransportError::Temporary("451 4.3.0 try later".into())),
        ok(),
    ]);
    let e = engine(&pool, t.clone(), "scripted");

    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, id).await, "deferred");
    let (attempts, secs): (i32, f64) = sqlx::query_as("SELECT attempts, extract(epoch FROM next_attempt_at - now())::float8 FROM emails WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(attempts, 1);
    assert!(
        (290.0..=370.0).contains(&secs),
        "first retry ~5m (+<=20% jitter), got {secs}"
    );
    assert_eq!(e.tick("w1").await.unwrap(), 0, "not due yet");

    make_due(&pool).await;
    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, id).await, "sent");
    assert_eq!(events(&pool, id).await, ["delivery_delayed", "sent"]);
    let (attempts, pmid): (i32, String) =
        sqlx::query_as("SELECT attempts, provider_message_id FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((attempts, pmid.as_str()), (2, "p1"));
    assert_eq!(t.calls(), 2);
}

#[tokio::test]
async fn temporary_past_max_age_gives_up() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let id = enqueue(&pool, &fx, "bob@example.org", "live").await;
    sqlx::query("UPDATE emails SET max_age_at = now() + interval '1 minute' WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let e = engine(
        &pool,
        Scripted::new(vec![Err(TransportError::Temporary("timeout".into()))]),
        "scripted",
    );
    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, id).await, "failed");
    assert_eq!(events(&pool, id).await, ["failed"]);
}

#[tokio::test]
async fn permanent_failure_is_final() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let a = enqueue(&pool, &fx, "a@example.org", "live").await;
    let b = enqueue(&pool, &fx, "b@example.org", "live").await;
    let t = Scripted::new(vec![
        Err(TransportError::Permanent(
            "ses 400 MessageRejected: bad".into(),
        )),
        Err(TransportError::Permanent(
            "550 5.7.1 blocked by policy".into(),
        )),
    ]);
    let e = engine(&pool, t.clone(), "scripted");
    e.tick("w1").await.unwrap();
    // row order within one batch is not fixed; check by event type.
    let ev_a = events(&pool, a).await;
    let ev_b = events(&pool, b).await;
    let all = [ev_a.clone(), ev_b.clone()].concat();
    assert!(
        all.contains(&"failed".to_string()) && all.contains(&"bounced".to_string()),
        "{all:?}"
    );
    make_due(&pool).await;
    assert_eq!(e.tick("w1").await.unwrap(), 0, "never retried");
    assert_eq!(t.calls(), 2);
    // 5.7.x is a block-class bounce: the recipient is NOT suppressed.
    let sup: i64 = sqlx::query_scalar("SELECT count(*) FROM suppressions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sup, 0);
    let failed: i64 = sqlx::query_scalar("SELECT count(*) FROM emails WHERE status = 'failed'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(failed, 1);
}

#[tokio::test]
async fn rate_limited_reschedules_without_burning_an_attempt() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let id = enqueue(&pool, &fx, "bob@example.org", "live").await;
    let t = Scripted::new(vec![Err(TransportError::RateLimited {
        msg: "slow down".into(),
        retry_after: Some(Duration::from_secs(3600)),
    })]);
    let e = engine(&pool, t, "scripted");
    e.tick("w1").await.unwrap();
    let (st, attempts, secs): (String, i32, f64) = sqlx::query_as("SELECT status, attempts, extract(epoch FROM next_attempt_at - now())::float8 FROM emails WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!((st.as_str(), attempts), ("deferred", 0));
    assert!((3590.0..=3620.0).contains(&secs), "{secs}");
}

#[tokio::test]
async fn auth_failure_pauses_transport_and_alerts() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let a = enqueue(&pool, &fx, "a@example.org", "live").await;
    let t = Scripted::new(vec![Err(TransportError::Auth("invalid_grant".into()))]);
    let e = engine(&pool, t.clone(), "gmail-x");
    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, a).await, "deferred", "message is not failed");
    let alerts: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT payload FROM jobs WHERE queue = 'alerts'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0]["kind"], "transport_paused");

    let b = enqueue(&pool, &fx, "b@example.org", "live").await;
    e.tick("w1").await.unwrap();
    assert_eq!(t.calls(), 1, "paused transport is not called again");
    assert_eq!(status(&pool, b).await, "deferred");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE queue = 'alerts'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1, "one alert per pause");
}

#[tokio::test]
async fn kill_switch_and_suppression_gate_at_dequeue() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let t = Scripted::new(vec![]);
    let e = engine(&pool, t.clone(), "scripted");

    let id = enqueue(&pool, &fx, "bob@example.org", "live").await;
    sqlx::query("UPDATE workspaces SET kill_switch = true")
        .execute(&pool)
        .await
        .unwrap();
    e.tick("w1").await.unwrap();
    assert_eq!(
        (status(&pool, id).await.as_str(), t.calls()),
        ("deferred", 0)
    );
    let attempts: i32 = sqlx::query_scalar("SELECT attempts FROM emails WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(attempts, 0, "gate pushes, does not count a retry");
    sqlx::query("UPDATE workspaces SET kill_switch = false")
        .execute(&pool)
        .await
        .unwrap();
    make_due(&pool).await;
    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, id).await, "sent");

    let s = enqueue(&pool, &fx, "Gone@Example.org", "live").await;
    sqlx::query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1, 'gone@example.org', 'unsubscribe')").bind(fx.ws).execute(&pool).await.unwrap();
    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, s).await, "suppressed");
    assert_eq!(events(&pool, s).await, ["suppressed"]);
    assert_eq!(t.calls(), 1);
}

#[tokio::test]
async fn reaper_requeues_expired_leases() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let id = enqueue(&pool, &fx, "bob@example.org", "live").await;
    sqlx::query("UPDATE emails SET status = 'sending', locked_by = 'dead', locked_until = now() - interval '1 minute', attempts = 1 WHERE id = $1").bind(id).execute(&pool).await.unwrap();
    let t = Scripted::new(vec![]);
    let e = engine(&pool, t, "scripted");
    assert_eq!(e.reap().await.unwrap(), 1);
    assert_eq!(status(&pool, id).await, "deferred");
    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, id).await, "sent");
    // A live lease is left alone.
    let id2 = enqueue(&pool, &fx, "c@example.org", "live").await;
    sqlx::query("UPDATE emails SET status = 'sending', locked_by = 'alive', locked_until = now() + interval '5 minutes' WHERE id = $1").bind(id2).execute(&pool).await.unwrap();
    assert_eq!(e.reap().await.unwrap(), 0);
}

#[tokio::test]
async fn a_late_worker_cannot_overwrite_a_reaped_row() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let id = enqueue(&pool, &fx, "bob@example.org", "live").await;
    let t = Arc::new(Scripted {
        delay_ms: 400,
        ..Default::default()
    });
    let e = Arc::new(engine(&pool, t, "scripted").config(EngineConfig {
        dest_per_minute: 0,
        lease: Duration::from_millis(100),
        ..Default::default()
    }));
    let e2 = e.clone();
    let h = tokio::spawn(async move { e2.tick("slow").await.unwrap() });
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(e.reap().await.unwrap(), 1, "lease expired mid-send");
    h.await.unwrap();
    // The slow worker's `sent` write was refused by the lease guard; the row stays requeued.
    assert_eq!(status(&pool, id).await, "deferred");
}

#[tokio::test]
async fn concurrent_workers_never_double_send_and_shutdown_is_graceful() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let mut ids = vec![];
    for i in 0..120 {
        ids.push(enqueue(&pool, &fx, &format!("u{i}@d{}.example.org", i % 7), "live").await);
    }
    let t = Arc::new(Scripted {
        delay_ms: 3,
        ..Default::default()
    });
    let e = Arc::new(engine(&pool, t.clone(), "scripted").config(EngineConfig {
        workers: 8,
        batch: 7,
        per_domain_batch: 3,
        poll: Duration::from_millis(20),
        dest_per_minute: 0,
        ..Default::default()
    }));
    let (tx, rx) = tokio::sync::watch::channel(false);
    let run = tokio::spawn(e.clone().run(rx));
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM emails WHERE status <> 'sent'")
            .fetch_one(&pool)
            .await
            .unwrap();
        if left == 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out, {left} unsent"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .expect("graceful shutdown")
        .unwrap();

    let mut count: HashMap<Uuid, usize> = HashMap::new();
    for id in t.calls.lock().unwrap().iter() {
        *count.entry(*id).or_default() += 1;
    }
    assert_eq!(count.len(), 120);
    assert!(
        count.values().all(|&n| n == 1),
        "double send: {:?}",
        count.iter().filter(|(_, n)| **n > 1).collect::<Vec<_>>()
    );
    let _ = ids;
}

async fn cap_scenario(pool: &PgPool, limits: Option<Arc<Limits>>, label: &str) {
    let fx = fixture(pool, Some(2), None).await;
    let t = Scripted::new(vec![]);
    let mut e = engine(pool, t.clone(), label);
    if let Some(l) = limits {
        e = e.limits(l);
    }
    for i in 0..4 {
        enqueue(pool, &fx, &format!("u{i}@example.org"), "live").await;
    }
    e.tick("w1").await.unwrap();
    assert_eq!(t.calls(), 2, "{label}: daily cap of 2 enforced at dequeue");
    let (sent, deferred): (i64, i64) = sqlx::query_as("SELECT count(*) FILTER (WHERE status='sent'), count(*) FILTER (WHERE status='deferred') FROM emails").fetch_one(pool).await.unwrap();
    assert_eq!((sent, deferred), (2, 2));
    let attempts: i64 = sqlx::query_scalar(
        "SELECT coalesce(sum(attempts),0)::bigint FROM emails WHERE status='deferred'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(attempts, 0, "capped rows keep their attempt count");
}

#[tokio::test]
async fn key_daily_cap_with_redis() {
    let Some(pool) = db().await else { return };
    let Ok(l) = Limits::redis(&redis_url()).await else {
        return eprintln!("SKIP: redis unreachable");
    };
    cap_scenario(&pool, Some(Arc::new(l)), "redis").await;
}

#[tokio::test]
async fn key_daily_cap_falls_back_to_postgres_without_redis() {
    let Some(pool) = db().await else { return };
    cap_scenario(&pool, None, "nopg-redis").await;
}

#[tokio::test]
async fn per_destination_throttle_pushes_rows() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let t = Scripted::new(vec![]);
    let egress = format!("thr-{}", Uuid::new_v4().simple());
    let r = ResolvedTransport {
        id: None,
        name: egress,
        transport: t.clone(),
    };
    let mut e = Engine::new(pool.clone(), Arc::new(StaticResolver(r))).config(EngineConfig {
        dest_per_minute: 2,
        per_domain_batch: 10,
        ..Default::default()
    });
    if let Ok(l) = Limits::redis(&redis_url()).await {
        e = e.limits(Arc::new(l));
    }
    for i in 0..5 {
        enqueue(&pool, &fx, &format!("u{i}@slow.example.org"), "live").await;
    }
    let other = enqueue(&pool, &fx, "x@other.example.org", "live").await;
    e.tick("w1").await.unwrap();
    // Window rollover between tick and assertion is possible but the 2/min cap holds within one tick.
    assert_eq!(
        t.calls(),
        3,
        "2 to slow.example.org + 1 to other.example.org"
    );
    assert_eq!(status(&pool, other).await, "sent");
    assert!(e
        .metrics
        .render()
        .contains("mailcraft_throttle_delays_total"));
}

#[tokio::test]
async fn cc_recipients_are_in_the_envelope_suppressed_ones_dropped_and_bcc_never_in_headers() {
    let Some(pool) = db().await else { return };
    let fx = fixture(&pool, None, None).await;
    let id = enqueue(&pool, &fx, "bob@example.org", "live").await;
    sqlx::query(
        "UPDATE emails SET cc = '{\"Cy <cy@example.org>\",gone@example.org}' WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1, 'gone@example.org', 'hard_bounce')")
        .bind(fx.ws)
        .execute(&pool)
        .await
        .unwrap();
    let t = Scripted::new(vec![]);
    let e = engine(&pool, t.clone(), "scripted");
    e.tick("w1").await.unwrap();
    assert_eq!(status(&pool, id).await, "sent");
    let (rcpts, raw) = t.last.lock().unwrap().clone().unwrap();
    assert_eq!(rcpts, ["bob@example.org", "cy@example.org"]);
    assert!(raw.contains("cy@example.org") && !raw.contains("gone@example.org"));
    assert!(!raw.to_lowercase().contains("bcc:"));
}
