//! Integration tests on a throwaway Postgres:
//!   docker run -d --rm --name mc-pg-auto -e POSTGRES_PASSWORD=x -p 55434:5432 postgres:17-alpine
//! Override with MAILCRAFT_TEST_PG. Tests skip (loudly) when no server is reachable,
//! unless MAILCRAFT_REQUIRE_DB is set.
use chrono::{DateTime, Duration, Utc};
use mailcraft_automations::*;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::sync::Arc;
use uuid::Uuid;

struct Fx {
    pool: PgPool,
    ws: Uuid,
    engine: Engine,
}

fn t0() -> DateTime<Utc> {
    "2026-10-27T14:00:00Z".parse().unwrap() // Tuesday, inside the UTC fallback window (13-17)
}

fn mins(n: i64) -> Duration {
    Duration::minutes(n)
}

async fn setup() -> Option<Fx> {
    setup_with(Arc::new(NoopPersonalizer)).await
}

async fn setup_with(p: Arc<dyn Personalizer>) -> Option<Fx> {
    let admin = std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55432/postgres".into());
    let admin_pool = match PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect(&admin)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            assert!(
                std::env::var("MAILCRAFT_REQUIRE_DB").is_err(),
                "postgres required but unreachable: {e}"
            );
            eprintln!("SKIP: postgres unreachable at {admin}: {e}");
            return None;
        }
    };
    let db = format!("mc_t_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db}"))
        .execute(&admin_pool)
        .await
        .unwrap();
    let url = match admin.rsplit_once('/') {
        Some((base, _)) => format!("{base}/{db}"),
        None => unreachable!(),
    };
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate::Migrator::new(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../migrations"
    )))
    .await
    .unwrap()
    .run(&pool)
    .await
    .unwrap();
    let ws: Uuid = sqlx::query_scalar("INSERT INTO workspaces (name, legal_name, postal_address, live_enabled) VALUES ('Acme','Acme Inc','1 Main St', true) RETURNING id")
        .fetch_one(&pool)
        .await
        .unwrap();
    for (name, stream) in [
        ("tx.example.com", "transactional"),
        ("mail.example.com", "marketing"),
    ] {
        sqlx::query("INSERT INTO domains (workspace_id, name, stream, status, return_path_host) VALUES ($1,$2,$3,'verified',$4)")
            .bind(ws).bind(name).bind(stream).bind(format!("bounce.{name}")).execute(&pool).await.unwrap();
    }
    for (k, n, d, u) in [
        ("product", "Product & tips", true, true),
        ("digest", "Digest", false, true),
        ("account", "Account", true, false),
    ] {
        contacts::upsert_topic(&pool, ws, k, n, d, u).await.unwrap();
    }
    template(&pool, ws, "welcome", "marketing", json!({"version":1,"subject":"Welcome {{ first_name }}","blocks":[
        {"type":"heading","text":"Hi {{ first_name }}"},{"type":"slot","name":"intro","fallback":"Thanks for joining."}]})).await;
    template(
        &pool,
        ws,
        "plain",
        "marketing",
        json!({"version":1,"subject":"Hello","blocks":[{"type":"paragraph","text":"x"}]}),
    )
    .await;
    template(
        &pool,
        ws,
        "alert",
        "transactional",
        json!({"version":1,"subject":"Heads up","blocks":[{"type":"paragraph","text":"x"}]}),
    )
    .await;
    template(
        &pool,
        ws,
        "nofallback",
        "marketing",
        json!({"version":1,"subject":"s","blocks":[{"type":"slot","name":"x"}]}),
    )
    .await;
    let engine = Engine::new(pool.clone(), p, EngineConfig::default());
    Some(Fx { pool, ws, engine })
}

async fn template(pool: &PgPool, ws: Uuid, alias: &str, stream: &str, doc: Value) {
    let tid: Uuid = sqlx::query_scalar("INSERT INTO templates (workspace_id, alias, name, stream) VALUES ($1,$2,$2,$3) RETURNING id")
        .bind(ws).bind(alias).bind(stream).fetch_one(pool).await.unwrap();
    let vid: Uuid = sqlx::query_scalar("INSERT INTO template_versions (template_id, version, doc, published_at) VALUES ($1,1,$2,now()) RETURNING id")
        .bind(tid).bind(doc).fetch_one(pool).await.unwrap();
    sqlx::query("UPDATE templates SET current_version_id = $2 WHERE id = $1")
        .bind(tid)
        .bind(vid)
        .execute(pool)
        .await
        .unwrap();
}

fn def(name: &str, steps: Value, extra: Value) -> Definition {
    let mut d = json!({"name": name, "status": "active", "approval": "never", "steps": steps});
    d.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(d).unwrap()
}

fn send(key: &str, tpl: &str, topic: &str, next: Option<&str>) -> Value {
    let mut s = json!({"key":key,"type":"send_email","config":{"template":tpl,"topic":topic}});
    if let Some(n) = next {
        s["next"] = json!(n);
    }
    s
}

fn ev(name: &str, email: &str, props: Value, key: Option<&str>) -> TrackInput {
    TrackInput {
        name: name.into(),
        contact: ContactInput {
            email: email.into(),
            first_name: Some("Ana".into()),
            ..Default::default()
        },
        properties: props,
        idempotency_key: key.map(Into::into),
        suppress_entry: false,
    }
}

async fn emails(pool: &PgPool, email: &str) -> Vec<(String, String, String)> {
    sqlx::query(
        "SELECT subject, status, stream FROM emails WHERE to_addr = $1 ORDER BY created_at, id",
    )
    .bind(email)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| (r.get(0), r.get(1), r.get(2)))
    .collect()
}

async fn run_of(
    pool: &PgPool,
    auto: Uuid,
) -> (String, Option<String>, Option<DateTime<Utc>>, Value) {
    let r = sqlx::query("SELECT state, current_step, next_wake_at, context FROM automation_runs WHERE automation_id = $1 ORDER BY started_at DESC LIMIT 1")
        .bind(auto).fetch_one(pool).await.unwrap();
    (r.get(0), r.get(1), r.get(2), r.get(3))
}

macro_rules! fx {
    () => {
        match setup().await {
            Some(f) => f,
            None => return,
        }
    };
}

#[tokio::test]
async fn event_enroll_delay_condition_send() {
    let f = fx!();
    let d = def(
        "welcome flow",
        json!([
        {"key":"t","type":"trigger","config":{"event":"signed_up"},"next":"wait"},
        {"key":"wait","type":"delay","config":{"duration":"5m"},"next":"is_pro"},
        {"key":"is_pro","type":"condition","config":{"rule":{"field":"event.plan","op":"eq","value":"pro"}},"next":{"true":"mail","false":"end"}},
        send("mail", "welcome", "product", None),
        {"key":"end","type":"exit"}]),
        json!({}),
    );
    let (auto, v) = install(&f.pool, f.ws, &d).await.unwrap();
    assert_eq!(v, 1);

    let tr = f
        .engine
        .ingest(
            f.ws,
            ev(
                "signed_up",
                "Ana@Example.COM",
                json!({"plan":"pro"}),
                Some("evt-1"),
            ),
            t0(),
        )
        .await
        .unwrap();
    assert!(!tr.duplicate);
    // redelivery of the same event id does not double-enter
    let dup = f
        .engine
        .ingest(
            f.ws,
            ev(
                "signed_up",
                "Ana@example.com",
                json!({"plan":"pro"}),
                Some("evt-1"),
            ),
            t0(),
        )
        .await
        .unwrap();
    assert!(dup.duplicate && dup.event_id == tr.event_id);
    let runs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM automation_runs WHERE automation_id = $1")
            .bind(auto)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(runs, 1);

    f.engine.tick(t0()).await.unwrap();
    let (state, step, wake, _) = run_of(&f.pool, auto).await;
    assert_eq!(
        (state.as_str(), step.as_deref(), wake),
        ("active", Some("is_pro"), Some(t0() + mins(5)))
    );
    f.engine.tick(t0() + mins(4)).await.unwrap();
    assert!(
        emails(&f.pool, "Ana@example.com").await.is_empty(),
        "delay not elapsed"
    );

    f.engine.tick(t0() + mins(6)).await.unwrap();
    let sent = emails(&f.pool, "Ana@example.com").await;
    assert_eq!(
        sent,
        vec![("Welcome Ana".into(), "queued".into(), "marketing".into())]
    );
    let (state, ..) = run_of(&f.pool, auto).await;
    assert_eq!(state, "completed");
    let row = sqlx::query("SELECT source, from_addr, automation_run_id IS NOT NULL, template_id IS NOT NULL, template_vars->>'first_name', tags FROM emails")
        .fetch_one(&f.pool).await.unwrap();
    assert_eq!(row.get::<String, _>(0), "automation");
    assert_eq!(row.get::<String, _>(1), "hello@mail.example.com");
    assert!(row.get::<bool, _>(2) && row.get::<bool, _>(3));
    assert_eq!(row.get::<String, _>(4), "Ana");
    // a later tick never re-sends
    f.engine.tick(t0() + mins(60)).await.unwrap();
    assert_eq!(emails(&f.pool, "Ana@example.com").await.len(), 1);

    // false branch: nothing is sent
    f.engine
        .ingest(
            f.ws,
            ev("signed_up", "bob@example.com", json!({"plan":"free"}), None),
            t0(),
        )
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    f.engine.tick(t0() + mins(10)).await.unwrap();
    assert!(emails(&f.pool, "bob@example.com").await.is_empty());
    // entry rule `once`
    f.engine
        .ingest(
            f.ws,
            ev(
                "signed_up",
                "Ana@example.com",
                json!({"plan":"pro"}),
                Some("evt-2"),
            ),
            t0() + mins(70),
        )
        .await
        .unwrap();
    let runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM automation_runs WHERE automation_id = $1 AND contact_id = $2",
    )
    .bind(auto)
    .bind(tr.contact_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(runs, 1);
}

#[tokio::test]
async fn wait_for_event_event_and_timeout_branches() {
    let f = fx!();
    let d = def(
        "wait flow",
        json!([
        {"key":"t","type":"trigger","config":{"event":"onboarding_completed"},"next":"w"},
        {"key":"w","type":"wait_for_event","config":{"event":"first_request_made","timeout":"2d","filter":{"field":"event.ok","op":"eq","value":true}},"next":{"event":"done","timeout":"nudge"}},
        send("nudge", "welcome", "product", Some("done")),
        {"key":"done","type":"exit"}]),
        json!({}),
    );
    let (auto, _) = install(&f.pool, f.ws, &d).await.unwrap();

    f.engine
        .ingest(
            f.ws,
            ev("onboarding_completed", "slow@example.com", json!({}), None),
            t0(),
        )
        .await
        .unwrap();
    f.engine
        .ingest(
            f.ws,
            ev("onboarding_completed", "fast@example.com", json!({}), None),
            t0(),
        )
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM automation_runs WHERE state = 'waiting' AND wait_event = 'first_request_made'").fetch_one(&f.pool).await.unwrap();
    assert_eq!(waiting, 2);

    // an event failing the wait filter does not wake the run
    f.engine
        .ingest(
            f.ws,
            ev(
                "first_request_made",
                "fast@example.com",
                json!({"ok":false}),
                None,
            ),
            t0() + Duration::hours(1),
        )
        .await
        .unwrap();
    let waiting: i64 =
        sqlx::query_scalar("SELECT count(*) FROM automation_runs WHERE state = 'waiting'")
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(waiting, 2);
    // the matching event wakes immediately and takes the `event` edge (no mail)
    f.engine
        .ingest(
            f.ws,
            ev(
                "first_request_made",
                "fast@example.com",
                json!({"ok":true}),
                None,
            ),
            t0() + Duration::hours(2),
        )
        .await
        .unwrap();
    f.engine.tick(t0() + Duration::hours(2)).await.unwrap();
    assert!(emails(&f.pool, "fast@example.com").await.is_empty());

    // a premature tick (before the deadline) leaves the slow run waiting
    f.engine.tick(t0() + Duration::days(1)).await.unwrap();
    assert!(emails(&f.pool, "slow@example.com").await.is_empty());
    let (state, ..) = sqlx::query("SELECT state FROM automation_runs r JOIN contacts c ON c.id = r.contact_id WHERE c.email = 'slow@example.com'")
        .fetch_one(&f.pool).await.map(|r| (r.get::<String, _>(0),)).unwrap();
    assert_eq!(state, "waiting");
    // timeout: the `timeout` edge sends the nudge
    f.engine
        .tick(t0() + Duration::days(2) + mins(1))
        .await
        .unwrap();
    f.engine
        .tick(t0() + Duration::days(2) + mins(2))
        .await
        .unwrap();
    assert_eq!(
        emails(&f.pool, "slow@example.com").await.len(),
        1,
        "timeout branch sends"
    );
    let (state, ..) = run_of(&f.pool, auto).await;
    assert!(state == "exited" || state == "completed");
}

#[tokio::test]
async fn frequency_cap_defers_then_sends_then_drops() {
    let f = fx!();
    let flow = |name: &str, ev: &str, extra: Value| {
        def(
            name,
            json!([{"key":"t","type":"trigger","config":{"event":ev},"next":"m"}, send("m", "plain", "product", None)]),
            extra,
        )
    };
    let (a, _) = install(&f.pool, f.ws, &flow("A", "ev_a", json!({})))
        .await
        .unwrap();
    let (b, _) = install(&f.pool, f.ws, &flow("B", "ev_b", json!({})))
        .await
        .unwrap();
    let (c, _) = install(
        &f.pool,
        f.ws,
        &flow(
            "C",
            "ev_c",
            json!({"caps":{"frequency":{"min_gap_hours":240}}}),
        ),
    )
    .await
    .unwrap();

    f.engine
        .ingest(f.ws, ev("ev_a", "cap@example.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert_eq!(emails(&f.pool, "cap@example.com").await.len(), 1);

    // B fires an hour later: blocked by the 1/48h cap and held until the gap passes
    let t1 = t0() + Duration::hours(1);
    f.engine
        .ingest(f.ws, ev("ev_b", "cap@example.com", json!({}), None), t1)
        .await
        .unwrap();
    f.engine.tick(t1).await.unwrap();
    assert_eq!(
        emails(&f.pool, "cap@example.com").await.len(),
        1,
        "cap blocks"
    );
    let (state, step, wake, _) = run_of(&f.pool, b).await;
    assert_eq!(
        (state.as_str(), step.as_deref(), wake),
        ("active", Some("m"), Some(t0() + Duration::hours(48)))
    );
    let gate: String = sqlx::query_scalar(
        "SELECT result->>'gate' FROM automation_run_steps WHERE result->>'decision' = 'deferred'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(gate, "frequency_cap");
    // still blocked just before; released at +48h (14:00Z Thursday is inside the window)
    f.engine.tick(t0() + Duration::hours(47)).await.unwrap();
    assert_eq!(emails(&f.pool, "cap@example.com").await.len(), 1);
    f.engine.tick(t0() + Duration::hours(48)).await.unwrap();
    assert_eq!(
        emails(&f.pool, "cap@example.com").await.len(),
        2,
        "released after the gap"
    );

    // C needs a 10 day gap, which exceeds the 3 day max defer: held, then dropped (never sent)
    let t2 = t0() + Duration::hours(49);
    f.engine
        .ingest(f.ws, ev("ev_c", "cap@example.com", json!({}), None), t2)
        .await
        .unwrap();
    f.engine.tick(t2).await.unwrap();
    let (_, _, wake, _) = run_of(&f.pool, c).await;
    assert_eq!(wake, Some(t2 + Duration::days(3)));
    f.engine.tick(t2 + Duration::days(3)).await.unwrap();
    let (state, ..) = run_of(&f.pool, c).await;
    assert_eq!(state, "completed");
    assert_eq!(
        emails(&f.pool, "cap@example.com").await.len(),
        2,
        "dropped, not sent"
    );
    let dropped: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM automation_run_steps WHERE result->>'decision' = 'dropped'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(dropped, 1);
    let _ = a;
}

#[tokio::test]
async fn weekly_cap_and_account_mail_exempt() {
    let f = fx!();
    let flow = |name: &str, ev: &str, tpl: &str, topic: &str, exempt: bool| {
        let mut s = send("m", tpl, topic, None);
        s["config"]["cap_exempt"] = json!(exempt);
        def(
            name,
            json!([{"key":"t","type":"trigger","config":{"event":ev},"next":"m"}, s]),
            json!({"caps":{"frequency":{"min_gap_hours":0,"max_per_7d":2}},"entry_rule":"always"}),
        )
    };
    install(
        &f.pool,
        f.ws,
        &flow("digest", "d", "plain", "product", false),
    )
    .await
    .unwrap();
    install(&f.pool, f.ws, &flow("acct", "a", "alert", "account", true))
        .await
        .unwrap();
    for i in 0..3 {
        let t = t0() + mins(i);
        f.engine
            .ingest(f.ws, ev("d", "w@example.com", json!({}), None), t)
            .await
            .unwrap();
        f.engine.tick(t).await.unwrap();
    }
    assert_eq!(
        emails(&f.pool, "w@example.com").await.len(),
        2,
        "3rd within 7 days is held"
    );
    f.engine
        .ingest(
            f.ws,
            ev("a", "w@example.com", json!({}), None),
            t0() + mins(3),
        )
        .await
        .unwrap();
    f.engine.tick(t0() + mins(3)).await.unwrap();
    let all = emails(&f.pool, "w@example.com").await;
    assert_eq!(all.len(), 3);
    assert_eq!(
        all[2].2, "transactional",
        "account mail is exempt and keeps its own stream"
    );
}

#[tokio::test]
async fn quiet_hours_defer_by_timezone_with_utc_fallback() {
    let f = fx!();
    let d = def(
        "q",
        json!([{"key":"t","type":"trigger","config":{"event":"go"},"next":"m"}, send("m", "plain", "product", None)]),
        json!({"entry_rule":"always"}),
    );
    let (auto, _) = install(&f.pool, f.ws, &d).await.unwrap();

    // 12:00Z Tuesday = 21:00 in Tokyo: deferred to Wednesday 09:00 JST (00:00Z)
    let tokyo = TrackInput {
        contact: ContactInput {
            email: "jp@example.com".into(),
            timezone: Some("Asia/Tokyo".into()),
            ..Default::default()
        },
        ..ev("go", "", json!({}), None)
    };
    let now = "2026-10-27T12:00:00Z".parse::<DateTime<Utc>>().unwrap();
    f.engine.ingest(f.ws, tokyo, now).await.unwrap();
    f.engine.tick(now).await.unwrap();
    assert!(emails(&f.pool, "jp@example.com").await.is_empty());
    let want: DateTime<Utc> = "2026-10-28T00:00:00Z".parse().unwrap();
    let wake: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT next_wake_at FROM automation_runs r JOIN contacts c ON c.id = r.contact_id WHERE c.email = 'jp@example.com'")
        .fetch_one(&f.pool).await.unwrap();
    assert_eq!(wake, Some(want));
    f.engine.tick(want - mins(1)).await.unwrap();
    assert!(emails(&f.pool, "jp@example.com").await.is_empty());
    f.engine.tick(want).await.unwrap();
    assert_eq!(emails(&f.pool, "jp@example.com").await.len(), 1);

    // no timezone: UTC 13:00-17:00 fallback; 09:00Z waits for 13:00Z
    let early = "2026-10-27T09:00:00Z".parse::<DateTime<Utc>>().unwrap();
    f.engine
        .ingest(f.ws, ev("go", "nz@example.com", json!({}), None), early)
        .await
        .unwrap();
    f.engine.tick(early).await.unwrap();
    assert!(emails(&f.pool, "nz@example.com").await.is_empty());
    f.engine.tick(early + Duration::hours(4)).await.unwrap();
    assert_eq!(emails(&f.pool, "nz@example.com").await.len(), 1);
    let _ = auto;
}

#[tokio::test]
async fn goal_exits_run_and_cancels_pending_mail() {
    let f = fx!();
    let d = def(
        "goal",
        json!([
        {"key":"t","type":"trigger","config":{"event":"signed_up"},"next":"w"},
        {"key":"w","type":"delay","config":{"duration":"1h"},"next":"m"},
        send("m", "plain", "product", None)]),
        json!({"goal":{"events":["first_request_made"]}}),
    );
    let (auto, _) = install(&f.pool, f.ws, &d).await.unwrap();
    f.engine
        .ingest(
            f.ws,
            ev("signed_up", "g@example.com", json!({}), None),
            t0(),
        )
        .await
        .unwrap();
    f.engine
        .ingest(
            f.ws,
            ev("signed_up", "h@example.com", json!({}), None),
            t0(),
        )
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    f.engine
        .ingest(
            f.ws,
            ev("first_request_made", "g@example.com", json!({}), None),
            t0() + mins(30),
        )
        .await
        .unwrap();
    f.engine.tick(t0() + mins(61)).await.unwrap();
    assert!(
        emails(&f.pool, "g@example.com").await.is_empty(),
        "goal reached before the send"
    );
    assert_eq!(
        emails(&f.pool, "h@example.com").await.len(),
        1,
        "other contacts unaffected"
    );
    let reason: Value = sqlx::query_scalar("SELECT context->'exit_reason' FROM automation_runs r JOIN contacts c ON c.id = r.contact_id WHERE c.email = 'g@example.com'").fetch_one(&f.pool).await.unwrap();
    assert_eq!(reason, json!("goal"));
    let _ = auto;

    // a queued (unsent) email of an exiting run is cancelled
    let d2 = def(
        "goal2",
        json!([
        {"key":"t","type":"trigger","config":{"event":"s2"},"next":"m"}, send("m", "plain", "product", Some("w")),
        {"key":"w","type":"delay","config":{"duration":"2d"},"next":"end"},{"key":"end","type":"exit"}]),
        json!({"goal":{"event":"done"}}),
    );
    install(&f.pool, f.ws, &d2).await.unwrap();
    f.engine
        .ingest(f.ws, ev("s2", "k@example.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    f.engine
        .ingest(
            f.ws,
            ev("done", "k@example.com", json!({}), None),
            t0() + mins(5),
        )
        .await
        .unwrap();
    assert_eq!(emails(&f.pool, "k@example.com").await[0].1, "cancelled");
}

#[tokio::test]
async fn topic_optout_suppression_and_kill_switch() {
    let f = fx!();
    let d = def(
        "gates",
        json!([
        {"key":"t","type":"trigger","config":{"event":"go"},"next":"m"}, send("m", "plain", "product", None)]),
        json!({"entry_rule":"always"}),
    );
    let acct = def(
        "gates-acct",
        json!([
        {"key":"t","type":"trigger","config":{"event":"go"},"next":"m"}, {"key":"m","type":"send_email","config":{"template":"alert","topic":"account","cap_exempt":true}}]),
        json!({"entry_rule":"always"}),
    );
    install(&f.pool, f.ws, &d).await.unwrap();
    install(&f.pool, f.ws, &acct).await.unwrap();

    let t = f
        .engine
        .ingest(f.ws, ev("go", "u@example.com", json!({}), None), t0())
        .await
        .unwrap();
    // unsubscribe from product before the tick
    contacts::set_topic(&f.pool, f.ws, t.contact_id, "product", false, t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    let all = emails(&f.pool, "u@example.com").await;
    assert_eq!(all.len(), 1, "only the account mail goes out: {all:?}");
    assert_eq!(all[0].0, "Heads up");

    // suppression beats everything, including account mail
    sqlx::query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,'s@example.com','hard_bounce')").bind(f.ws).execute(&f.pool).await.unwrap();
    f.engine
        .ingest(f.ws, ev("go", "s@example.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert!(emails(&f.pool, "s@example.com").await.is_empty());

    // kill switch holds sends in place and releases them afterwards
    sqlx::query("UPDATE workspaces SET kill_switch = true")
        .execute(&f.pool)
        .await
        .unwrap();
    f.engine
        .ingest(f.ws, ev("go", "k@example.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert!(emails(&f.pool, "k@example.com").await.is_empty());
    sqlx::query("UPDATE workspaces SET kill_switch = false")
        .execute(&f.pool)
        .await
        .unwrap();
    f.engine.tick(t0() + mins(16)).await.unwrap();
    assert_eq!(emails(&f.pool, "k@example.com").await.len(), 2);
}

#[tokio::test]
async fn backfill_suppresses_existing_contacts() {
    let f = fx!();
    let mut d = def(
        "backfilled",
        json!([{"key":"t","type":"trigger","config":{"event":"signed_up"},"next":"m"}, send("m", "plain", "product", None)]),
        json!({}),
    );
    d.status = Some("draft".into());
    let (auto, _) = install(&f.pool, f.ws, &d).await.unwrap();
    // history exists before the automation goes live
    f.engine
        .track(
            f.ws,
            ev("signed_up", "old@example.com", json!({}), None),
            t0() - Duration::days(30),
        )
        .await
        .unwrap();
    let hist = TrackInput {
        suppress_entry: true,
        ..ev("signed_up", "older@example.com", json!({}), None)
    };
    f.engine
        .track(f.ws, hist, t0() - Duration::days(60))
        .await
        .unwrap();
    f.engine.activate(auto, true, t0()).await.unwrap();
    f.engine
        .ingest(
            f.ws,
            ev("signed_up", "new@example.com", json!({}), None),
            t0(),
        )
        .await
        .unwrap();
    // an old contact does something again: still no entry
    f.engine
        .ingest(
            f.ws,
            ev("signed_up", "old@example.com", json!({}), None),
            t0(),
        )
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert!(emails(&f.pool, "old@example.com").await.is_empty());
    assert!(emails(&f.pool, "older@example.com").await.is_empty());
    assert_eq!(emails(&f.pool, "new@example.com").await.len(), 1);
}

#[tokio::test]
async fn segments_evaluate_in_sql_and_trigger_entry() {
    let f = fx!();
    for (email, plan, n) in [
        ("a@x.com", "pro", 5),
        ("b@x.com", "free", 50),
        ("c@x.com", "pro", 1),
    ] {
        let c = contacts::upsert_contact(
            &f.pool,
            f.ws,
            &ContactInput {
                email: email.into(),
                properties: Some(json!({"plan": plan, "requests": n, "tags": ["beta"]})),
                timezone: None,
                ..Default::default()
            },
            t0(),
        )
        .await
        .unwrap();
        if email == "c@x.com" {
            contacts::set_topic(&f.pool, f.ws, c.id, "product", false, t0())
                .await
                .unwrap();
        }
    }
    let rule: Rule = serde_json::from_value(json!({"and":[
        {"field":"properties.plan","op":"eq","value":"pro"},
        {"field":"properties.requests","op":"gte","value":2},
        {"field":"topic:product","op":"eq","value":true},
        {"field":"properties.tags","op":"contains","value":"beta"}]}))
    .unwrap();
    let hit = contacts::matching_contacts(&f.pool, f.ws, &rule)
        .await
        .unwrap();
    assert_eq!(hit.len(), 1);
    let or: Rule = serde_json::from_value(json!({"or":[{"field":"email","op":"in","value":["b@x.com","c@x.com"]},{"not":{"field":"properties.plan","op":"exists"}}]})).unwrap();
    assert_eq!(
        contacts::matching_contacts(&f.pool, f.ws, &or)
            .await
            .unwrap()
            .len(),
        2
    );
    assert!(contacts::matching_contacts(
        &f.pool,
        f.ws,
        &serde_json::from_value(json!({"field":"password","op":"eq","value":1})).unwrap()
    )
    .await
    .is_err());

    // segment-entry trigger
    contacts::create_segment(&f.pool, f.ws, "pros", Some(&rule))
        .await
        .unwrap();
    let d = def(
        "seg",
        json!([{"key":"t","type":"trigger","config":{"segment":"pros"},"next":"m"}, send("m", "plain", "product", None)]),
        json!({}),
    );
    install(&f.pool, f.ws, &d).await.unwrap();
    f.engine.tick(t0()).await.unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert_eq!(emails(&f.pool, "a@x.com").await.len(), 1);
    assert!(
        emails(&f.pool, "b@x.com").await.is_empty() && emails(&f.pool, "c@x.com").await.is_empty()
    );
    f.engine.tick(t0() + Duration::hours(1)).await.unwrap();
    assert_eq!(
        emails(&f.pool, "a@x.com").await.len(),
        1,
        "entering once, not every tick"
    );
}

#[tokio::test]
async fn update_contact_and_add_to_segment_steps() {
    let f = fx!();
    let d = def(
        "upd",
        json!([
        {"key":"t","type":"trigger","config":{"event":"hosts"},"next":"u"},
        {"key":"u","type":"update_contact","config":{"set":{"hosts_count":"$event.n","timezone":"Europe/Berlin","stage":"active"}},"next":"s"},
        {"key":"s","type":"add_to_segment","config":{"segment":"multi-host"}}]),
        json!({}),
    );
    install(&f.pool, f.ws, &d).await.unwrap();
    let t = f
        .engine
        .ingest(f.ws, ev("hosts", "m@x.com", json!({"n": 3}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    let c = contacts::get_contact(&f.pool, t.contact_id).await.unwrap();
    assert_eq!(c.properties["hosts_count"], json!(3));
    assert_eq!(c.properties["stage"], json!("active"));
    assert_eq!(c.timezone.as_deref(), Some("Europe/Berlin"));
    let members: i64 = sqlx::query_scalar("SELECT count(*) FROM segment_members m JOIN segments s ON s.id = m.segment_id WHERE s.name = 'multi-host'").fetch_one(&f.pool).await.unwrap();
    assert_eq!(members, 1);
}

struct Gen;
#[async_trait::async_trait]
impl Personalizer for Gen {
    async fn personalize(
        &self,
        r: PersonalizeRequest,
    ) -> std::result::Result<Personalized, PersonalizeError> {
        assert_eq!(r.slots[0].name, "intro");
        assert_eq!(r.context["first_name"], json!("Ana"));
        Ok(Personalized {
            subject: Some("Hello from the model".into()),
            slots: [("intro".to_string(), "Custom intro.".to_string())].into(),
            generation_id: Some(Uuid::new_v4()),
            ..Default::default()
        })
    }
}

#[tokio::test]
async fn llm_send_uses_personalizer_and_noop_falls_back() {
    let steps = json!([{"key":"t","type":"trigger","config":{"event":"go"},"next":"m"},
        {"key":"m","type":"send_email","config":{"template":"welcome","topic":"product","mode":"llm","instructions":"be brief"}}]);
    // publish is refused when a slot has no fallback
    let f = fx!();
    let bad = def(
        "bad",
        json!([{"key":"t","type":"trigger","config":{"event":"go"},"next":"m"},
        {"key":"m","type":"send_email","config":{"template":"nofallback","mode":"llm"}}]),
        json!({}),
    );
    let e = install(&f.pool, f.ws, &bad).await.unwrap_err().to_string();
    assert!(e.contains("fallback"), "{e}");
    let missing = def(
        "missing",
        json!([{"key":"t","type":"trigger","config":{"event":"go"},"next":"m"}, send("m", "nope", "product", None)]),
        json!({}),
    );
    assert!(install(&f.pool, f.ws, &missing).await.is_err());

    install(&f.pool, f.ws, &def("llm", steps.clone(), json!({})))
        .await
        .unwrap();
    f.engine
        .ingest(f.ws, ev("go", "n@x.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    let r = sqlx::query(
        "SELECT subject, template_vars->'slots'->>'intro', generation_id IS NULL FROM emails",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        (
            r.get::<String, _>(0),
            r.get::<String, _>(1),
            r.get::<bool, _>(2)
        ),
        ("Welcome Ana".into(), "Thanks for joining.".into(), true),
        "no-op personalizer = fallback copy"
    );

    let g = setup_with(Arc::new(Gen)).await.unwrap();
    install(&g.pool, g.ws, &def("llm", steps, json!({})))
        .await
        .unwrap();
    g.engine
        .ingest(g.ws, ev("go", "n@x.com", json!({}), None), t0())
        .await
        .unwrap();
    g.engine.tick(t0()).await.unwrap();
    let r = sqlx::query(
        "SELECT subject, template_vars->'slots'->>'intro', generation_id IS NOT NULL FROM emails",
    )
    .fetch_one(&g.pool)
    .await
    .unwrap();
    assert_eq!(
        (
            r.get::<String, _>(0),
            r.get::<String, _>(1),
            r.get::<bool, _>(2)
        ),
        ("Hello from the model".into(), "Custom intro.".into(), true)
    );
}

#[tokio::test]
async fn approval_policy_holds_first_sends_and_failures_back_off() {
    let f = fx!();
    let mut d = def(
        "appr",
        json!([{"key":"t","type":"trigger","config":{"event":"go"},"next":"m"}, send("m", "plain", "product", None)]),
        json!({"entry_rule":"always"}),
    );
    d.approval = "first_n:1".into();
    install(&f.pool, f.ws, &d).await.unwrap();
    f.engine
        .ingest(f.ws, ev("go", "p1@x.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine
        .ingest(f.ws, ev("go", "p2@x.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    let a = emails(&f.pool, "p1@x.com").await;
    let b = emails(&f.pool, "p2@x.com").await;
    let statuses: Vec<&str> = a.iter().chain(&b).map(|e| e.1.as_str()).collect();
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == "pending_approval")
            .count(),
        1,
        "{statuses:?}"
    );
    assert_eq!(statuses.iter().filter(|s| **s == "queued").count(), 1);
    let approvals: i64 = sqlx::query_scalar("SELECT count(*) FROM approvals WHERE kind = 'automation_first_send' AND status = 'pending'").fetch_one(&f.pool).await.unwrap();
    assert_eq!(approvals, 1);

    // a failing step backs off and ends in `failed` after max attempts
    let broken = def(
        "broken",
        json!([{"key":"t","type":"trigger","config":{"event":"boom"},"next":"m"}, send("m", "plain", "nosuchtopic", None)]),
        json!({}),
    );
    let (auto, _) = install(&f.pool, f.ws, &broken).await.unwrap();
    f.engine
        .ingest(f.ws, ev("boom", "z@x.com", json!({}), None), t0())
        .await
        .unwrap();
    let mut now = t0();
    for _ in 0..5 {
        f.engine.tick(now).await.unwrap();
        now += Duration::hours(1);
    }
    let (state, ..) = run_of(&f.pool, auto).await;
    assert_eq!(state, "failed");
    let err: String = sqlx::query_scalar("SELECT result->>'error' FROM automation_run_steps WHERE result->>'decision' = 'error' LIMIT 1").fetch_one(&f.pool).await.unwrap();
    assert!(err.contains("nosuchtopic"), "{err}");
}

#[tokio::test]
async fn example_pack_installs() {
    let f = fx!();
    let dir =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/lifecycle-pack");
    let pack: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("pack.json")).unwrap()).unwrap();
    for t in pack["topics"].as_array().unwrap() {
        contacts::upsert_topic(
            &f.pool,
            f.ws,
            t["key"].as_str().unwrap(),
            t["name"].as_str().unwrap(),
            t["default_opt_in"].as_bool().unwrap(),
            t["can_unsubscribe"].as_bool().unwrap(),
        )
        .await
        .unwrap();
    }
    for alias in pack["templates_needed"].as_array().unwrap() {
        template(&f.pool, f.ws, alias.as_str().unwrap(), "marketing", json!({"version":1,"subject":"Hi {{ first_name }}","blocks":[{"type":"slot","name":"intro","fallback":"Hello."}]})).await;
    }
    let mut n = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap() == "pack.json" {
            continue;
        }
        let j: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for a in j["automations"].as_array().unwrap() {
            let d: Definition = serde_json::from_value(a.clone())
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            install(&f.pool, f.ws, &d)
                .await
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            n += 1;
        }
    }
    assert!(n >= 12, "J1-J12 produce at least 12 automations, got {n}");
}

struct Counting(std::sync::atomic::AtomicUsize);
#[async_trait::async_trait]
impl Personalizer for Counting {
    async fn personalize(
        &self,
        _: PersonalizeRequest,
    ) -> std::result::Result<Personalized, PersonalizeError> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Personalized::default())
    }
}

#[tokio::test]
async fn not_live_workspace_mail_is_test_env_and_skips_quiet_hours() {
    let f = fx!();
    let d = def(
        "env",
        json!([{"key":"t","type":"trigger","config":{"event":"go"},"next":"m"}, send("m", "plain", "product", None)]),
        json!({"entry_rule":"always"}),
    );
    install(&f.pool, f.ws, &d).await.unwrap();
    let early = "2026-10-27T09:00:00Z".parse::<DateTime<Utc>>().unwrap(); // outside 13-17Z

    // live workspace: env=live, still waits for the window
    f.engine
        .ingest(f.ws, ev("go", "live@x.com", json!({}), None), early)
        .await
        .unwrap();
    f.engine.tick(early).await.unwrap();
    assert!(emails(&f.pool, "live@x.com").await.is_empty());
    f.engine.tick(early + Duration::hours(4)).await.unwrap();
    let env: String = sqlx::query_scalar("SELECT env FROM emails WHERE to_addr = 'live@x.com'")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(env, "live");

    // not live: sandbox env, sent immediately
    sqlx::query("UPDATE workspaces SET live_enabled = false")
        .execute(&f.pool)
        .await
        .unwrap();
    f.engine
        .ingest(f.ws, ev("go", "test@x.com", json!({}), None), early)
        .await
        .unwrap();
    f.engine.tick(early).await.unwrap();
    let env: String = sqlx::query_scalar("SELECT env FROM emails WHERE to_addr = 'test@x.com'")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(env, "test");
}

#[tokio::test]
async fn missing_from_fails_fast_without_calling_the_llm() {
    let c = Arc::new(Counting(Default::default()));
    let f = setup_with(c.clone()).await.unwrap();
    sqlx::query("DELETE FROM domains")
        .execute(&f.pool)
        .await
        .unwrap();
    let steps = json!([{"key":"t","type":"trigger","config":{"event":"go"},"next":"m"},
        {"key":"m","type":"send_email","config":{"template":"welcome","topic":"product","mode":"llm"}}]);
    let (auto, _) = install(&f.pool, f.ws, &def("nofrom", steps, json!({})))
        .await
        .unwrap();
    f.engine
        .ingest(f.ws, ev("go", "n@x.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert_eq!(
        c.0.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "no LLM call for a config error"
    );
    let (state, ..) = run_of(&f.pool, auto).await;
    assert_eq!(state, "failed", "permanent error: no backoff retries");
    let err: String = sqlx::query_scalar(
        "SELECT result->>'error' FROM automation_run_steps WHERE result->>'decision' = 'error'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(err.contains("no `from`"), "{err}");
}

#[tokio::test]
async fn contact_timezone_column_filled_from_properties_and_validated() {
    let f = fx!();
    let up = |tz: Option<&str>, props: Value| ContactInput {
        email: "tz@x.com".into(),
        timezone: tz.map(Into::into),
        properties: Some(props),
        ..Default::default()
    };
    let c = contacts::upsert_contact(
        &f.pool,
        f.ws,
        &up(None, json!({"timezone":"Asia/Tokyo"})),
        t0(),
    )
    .await
    .unwrap();
    assert_eq!(c.timezone.as_deref(), Some("Asia/Tokyo"));
    let c = contacts::upsert_contact(&f.pool, f.ws, &up(Some("Europe/Berlin"), json!({})), t0())
        .await
        .unwrap();
    assert_eq!(c.timezone.as_deref(), Some("Europe/Berlin"));
    assert!(
        contacts::upsert_contact(&f.pool, f.ws, &up(Some("Mars/Base"), json!({})), t0())
            .await
            .is_err()
    );
    assert!(
        contacts::upsert_contact(&f.pool, f.ws, &up(None, json!({"timezone":"nope"})), t0())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_send_step_may_name_its_template_by_id_or_alias() {
    let f = fx!();
    let id: Uuid = sqlx::query_scalar("SELECT id FROM templates WHERE alias = 'plain'")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let steps = |tpl: &str| json!([{"key":"t","type":"trigger","config":{"event":"go"},"next":"m"}, send("m", tpl, "product", None)]);
    // an unknown id is refused at install, like an unknown alias
    let e = install(
        &f.pool,
        f.ws,
        &def("bad", steps(&Uuid::new_v4().to_string()), json!({})),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(e.contains("does not exist"), "{e}");
    // the id installs, and the engine resolves it at send time
    install(
        &f.pool,
        f.ws,
        &def("by-id", steps(&id.to_string()), json!({})),
    )
    .await
    .unwrap();
    f.engine
        .ingest(f.ws, ev("go", "id@x.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert_eq!(
        emails(&f.pool, "id@x.com").await,
        vec![("Hello".into(), "queued".into(), "marketing".into())]
    );
}

#[tokio::test]
async fn test_run_starts_on_a_draft_and_follows_the_key_env() {
    let f = fx!();
    let steps = json!([
        {"key":"t","type":"trigger","config":{"event":"go"},"next":"c"},
        {"key":"c","type":"condition","config":{"rule":{"field":"event.plan","op":"eq","value":"pro"}},"next":{"true":"m","false":"end"}},
        send("m", "plain", "product", None),
        {"key":"end","type":"exit"}]);
    let (auto, _) = install(
        &f.pool,
        f.ws,
        &def(
            "drafty",
            steps,
            json!({"status":"draft","approval":"first_n:5"}),
        ),
    )
    .await
    .unwrap();
    let input = |email: &str| ContactInput {
        email: email.into(),
        ..Default::default()
    };

    // a real event does not enter a draft
    f.engine
        .ingest(
            f.ws,
            ev("go", "real@x.com", json!({"plan":"pro"}), None),
            t0(),
        )
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert!(emails(&f.pool, "real@x.com").await.is_empty());

    // a test-key run sends from the draft, into the sandbox, past the approval policy and frequency caps
    for _ in 0..2 {
        f.engine
            .start_test_run(
                f.ws,
                auto,
                input("t@x.com"),
                json!({"plan":"pro"}),
                "test",
                t0(),
            )
            .await
            .unwrap();
    }
    f.engine.tick(t0()).await.unwrap();
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT env, status FROM emails WHERE to_addr = 't@x.com'")
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(rows, vec![("test".into(), "queued".into()); 2]);
    let (state, ..) = run_of(&f.pool, auto).await;
    assert_eq!(state, "completed");

    // event properties drive the branch
    f.engine
        .start_test_run(
            f.ws,
            auto,
            input("free@x.com"),
            json!({"plan":"free"}),
            "test",
            t0(),
        )
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert!(emails(&f.pool, "free@x.com").await.is_empty());

    // a live-key run in a live workspace is a real send, so the approval policy still holds it
    let (run, _) = f
        .engine
        .start_test_run(
            f.ws,
            auto,
            input("l@x.com"),
            json!({"plan":"pro"}),
            "live",
            t0(),
        )
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    let row: (String, String) =
        sqlx::query_as("SELECT env, status FROM emails WHERE to_addr = 'l@x.com'")
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(row, ("live".into(), "pending_approval".into()));
    let flagged: bool =
        sqlx::query_scalar("SELECT context ? 'test' FROM automation_runs WHERE id = $1")
            .bind(run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(flagged);
    // the kill switch still stops a test run
    sqlx::query("UPDATE workspaces SET kill_switch = true")
        .execute(&f.pool)
        .await
        .unwrap();
    f.engine
        .start_test_run(
            f.ws,
            auto,
            input("k@x.com"),
            json!({"plan":"pro"}),
            "test",
            t0(),
        )
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert!(emails(&f.pool, "k@x.com").await.is_empty());
}

/// A `SendRouter` pins the transport and may rewrite From; without one a step's own `transport_id` is used.
struct Pin(Uuid);
#[async_trait::async_trait]
impl SendRouter for Pin {
    async fn route(
        &self,
        _ws: Uuid,
        from: &str,
        _explicit: Option<Uuid>,
    ) -> Result<(String, Option<Uuid>)> {
        Ok((format!("\"Acme\" <{from}>"), Some(self.0)))
    }
}

#[tokio::test]
async fn send_steps_pin_the_routed_transport_and_from() {
    let f = fx!();
    let tr = |name: &'static str| {
        let pool = f.pool.clone();
        let ws = f.ws;
        async move {
            sqlx::query_scalar::<_, Uuid>("INSERT INTO transports (workspace_id, kind, name, config_enc) VALUES ($1,'smtp-relay',$2,'\\x00') RETURNING id")
                .bind(ws).bind(name).fetch_one(&pool).await.unwrap()
        }
    };
    let (own, routed) = (tr("own").await, tr("routed").await);
    let d = def(
        "routing",
        json!([
        {"key":"t","type":"trigger","config":{"event":"go"},"next":"m"},
        {"key":"m","type":"send_email","config":{"template":"plain","topic":"product","from":"a@tx.example.com","transport_id":own}}]),
        json!({"entry_rule":"always"}),
    );
    install(&f.pool, f.ws, &d).await.unwrap();
    let row = |email: &'static str| {
        let pool = f.pool.clone();
        async move {
            sqlx::query_as::<_, (Option<Uuid>, String)>(
                "SELECT transport_id, from_addr FROM emails WHERE to_addr = $1",
            )
            .bind(email)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    // no router: the step's own transport_id, From as written
    f.engine
        .ingest(f.ws, ev("go", "u1@example.com", json!({}), None), t0())
        .await
        .unwrap();
    f.engine.tick(t0()).await.unwrap();
    assert_eq!(
        row("u1@example.com").await,
        (Some(own), "a@tx.example.com".to_string())
    );
    // with a router: its choice wins
    let routed_engine = Engine::new(
        f.pool.clone(),
        Arc::new(NoopPersonalizer),
        EngineConfig::default(),
    )
    .router(Arc::new(Pin(routed)));
    routed_engine
        .ingest(f.ws, ev("go", "u2@example.com", json!({}), None), t0())
        .await
        .unwrap();
    routed_engine.tick(t0()).await.unwrap();
    assert_eq!(
        row("u2@example.com").await,
        (Some(routed), "\"Acme\" <a@tx.example.com>".to_string())
    );
}
