//! Transport pinning and workspace isolation for the multi-sender routing: a queued email keeps the
//! transport chosen at enqueue (approval hold, schedule, broadcast rows), test keys never pin one, a
//! transport of another workspace is never accepted, and the transport / domain edits are gated.
//! Real Postgres (MAILCRAFT_TEST_PG, default :55550); skips when unreachable unless MAILCRAFT_REQUIRE_DB=1.
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use chrono::Utc;
use http_body_util::BodyExt;
use mailcraft_api::{
    keys::{insert_key, CreateKey},
    wiring, AppState, Config,
};
use mailcraft_automations::{Engine, EngineConfig, NoopPersonalizer};
use mailcraft_core::auth::{KeyEnv, Scope};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
use tower::ServiceExt;
use uuid::Uuid;

fn pg_url() -> String {
    std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55550/postgres".into())
}

async fn fresh_db() -> Option<PgPool> {
    let admin = match PgPool::connect(&pg_url()).await {
        Ok(p) => p,
        Err(e) => {
            assert!(
                std::env::var("MAILCRAFT_REQUIRE_DB").is_err(),
                "postgres required: {e}"
            );
            eprintln!("SKIP: postgres unreachable ({e})");
            return None;
        }
    };
    let name = format!("mc_snm_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let url = format!("{}/{name}", pg_url().rsplit_once('/').unwrap().0);
    let db = PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("../../migrations").run(&db).await.unwrap();
    Some(db)
}

struct Env {
    app: Router,
    st: AppState,
    db: PgPool,
    admin: String,
    stop: tokio::sync::watch::Sender<bool>,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

/// A set-up, live-enabled workspace; the send engine runs only when asked.
async fn env(run_engine: bool) -> Option<Env> {
    let db = fresh_db().await?;
    std::env::set_var("MAILCRAFT_EGRESS_IP", "203.0.113.10");
    let mut cfg = Config::from_env();
    cfg.rate_limit_per_min = 6000;
    cfg.unsub_secret = b"snd-unsub-secret".to_vec();
    let (st, engine) = wiring::assemble(db.clone(), None, "snd-test-secret-key-0123456789", cfg)
        .await
        .unwrap();
    let app = mailcraft_api::router(st.clone());
    let (stop, rx) = tokio::sync::watch::channel(false);
    if run_engine {
        tokio::spawn(engine.run(rx));
    }
    let (s, setup) = call(&app, "POST", "/v1/setup", None, Some(json!({}))).await;
    assert_eq!(s, StatusCode::CREATED, "{setup}");
    let admin = setup["data"]["admin_key"].as_str().unwrap().to_string();
    sqlx::query(
        "UPDATE workspaces SET live_enabled = true, legal_name = 'T', postal_address = '1 Main St'",
    )
    .execute(&db)
    .await
    .unwrap();
    Some(Env {
        app,
        st,
        db,
        admin,
        stop,
    })
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    key: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(k) = key {
        b = b.header("authorization", format!("Bearer {k}"));
    }
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl Env {
    async fn c(&self, m: &str, p: &str, b: Option<Value>) -> (StatusCode, Value) {
        call(&self.app, m, p, Some(&self.admin), b).await
    }

    /// Creates a transport on a local (never contacted) port; returns its id.
    async fn transport(&self, name: &str, config: Value) -> Uuid {
        let mut c = json!({"host": "127.0.0.1", "port": 1, "tls": "none"});
        c.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let (s, b) = self
            .c(
                "POST",
                "/v1/transports",
                Some(json!({"kind": "smtp-relay", "name": name, "config": c})),
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{b}");
        b["data"]["id"].as_str().unwrap().parse().unwrap()
    }

    /// A mailbox relay: `login` plus optional `aliases` / `display_names`.
    async fn mailbox(&self, name: &str, login: &str, extra: Value) -> Uuid {
        let mut c = json!({"username": login, "password": "pw", "mailbox_sender": true});
        c.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.transport(name, c).await
    }

    /// Adds a domain and (optionally) marks it verified.
    async fn domain(&self, name: &str, verified: bool) -> Uuid {
        let (s, b) = self
            .c("POST", "/v1/domains", Some(json!({"domain": name})))
            .await;
        assert_eq!(s, StatusCode::CREATED, "{b}");
        let id: Uuid = b["data"]["id"].as_str().unwrap().parse().unwrap();
        if verified {
            sqlx::query(
                "UPDATE domains SET status = 'verified', verified_at = now() WHERE id = $1",
            )
            .bind(id)
            .execute(&self.db)
            .await
            .unwrap();
        }
        id
    }

    async fn send(&self, body: Value) -> (StatusCode, Value) {
        let mut b = json!({"to": ["rcpt@example.org"], "subject": "s", "text": "t"});
        b.as_object_mut()
            .unwrap()
            .extend(body.as_object().unwrap().clone());
        self.c("POST", "/v1/emails", Some(b)).await
    }

    /// `(transport_id, domain_id, from_addr, routing decision)` of a queued email.
    async fn row(&self, send_response: &Value) -> (Option<Uuid>, Option<Uuid>, String, Value) {
        let id: Uuid = send_response["data"]["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let (t, d, f, dec): (Option<Uuid>, Option<Uuid>, String, Value) = sqlx::query_as(
            "SELECT transport_id, domain_id, from_addr, policy_decisions FROM emails WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&self.db)
        .await
        .unwrap();
        let routing = dec
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["rule"] == "routing")
            .cloned()
            .unwrap();
        (t, d, f, routing)
    }
}

fn code(b: &Value) -> &str {
    b["error"]["code"].as_str().unwrap_or("")
}
/// SMTP sink that keeps each MAIL FROM and DATA payload.
async fn smtp_sink() -> (u16, Arc<Mutex<Vec<(String, String)>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let got: Arc<Mutex<Vec<(String, String)>>> = Default::default();
    let store = got.clone();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let store = store.clone();
            tokio::spawn(async move {
                let (r, mut w) = s.into_split();
                let mut r = BufReader::new(r);
                let _ = w.write_all(b"220 sink ESMTP\r\n").await;
                let (mut from, mut data, mut in_data) = (String::new(), String::new(), false);
                let mut line = String::new();
                loop {
                    line.clear();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    if in_data {
                        if line == ".\r\n" {
                            store
                                .lock()
                                .unwrap()
                                .push((from.clone(), std::mem::take(&mut data)));
                            in_data = false;
                            let _ = w.write_all(b"250 2.0.0 queued as sink-1\r\n").await;
                        } else {
                            data.push_str(&line);
                        }
                        continue;
                    }
                    let up = line.to_ascii_uppercase();
                    let reply: &[u8] = if up.starts_with("EHLO") || up.starts_with("HELO") {
                        b"250-sink\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n"
                    } else if up.starts_with("AUTH") {
                        b"235 2.7.0 ok\r\n"
                    } else if up.starts_with("MAIL FROM:") {
                        from = line.trim().to_string();
                        b"250 ok\r\n"
                    } else if up.starts_with("DATA") {
                        in_data = true;
                        b"354 go\r\n"
                    } else if up.starts_with("QUIT") {
                        let _ = w.write_all(b"221 bye\r\n").await;
                        return;
                    } else {
                        b"250 ok\r\n"
                    };
                    let _ = w.write_all(reply).await;
                }
            });
        }
    });
    (port, got)
}

fn id_of(v: &Value) -> Uuid {
    v["data"]["id"].as_str().unwrap().parse().unwrap()
}

impl Env {
    /// A key of this workspace; returns its token.
    async fn key(&self, env: &str, scopes: &[&str], policy: Option<Value>) -> String {
        let mut b =
            json!({"name": format!("k-{}", Uuid::new_v4().simple()), "env": env, "scopes": scopes});
        if let Some(p) = policy {
            b["policy"] = p;
        }
        let (s, r) = self.c("POST", "/v1/keys", Some(b)).await;
        assert_eq!(s, StatusCode::CREATED, "{r}");
        r["data"]["token"].as_str().unwrap().to_string()
    }

    /// A mailbox relay whose SMTP host is the local sink on `port`.
    async fn relay_at(&self, name: &str, login: &str, port: u16) -> Uuid {
        self.mailbox(name, login, json!({"port": port})).await
    }

    /// A second workspace with a transport of its own: `(its admin token, that transport)`.
    async fn other_workspace(&self) -> (String, Uuid) {
        let ws: Uuid =
            sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ('other') RETURNING id")
                .fetch_one(&self.db)
                .await
                .unwrap();
        let mut conn = self.db.acquire().await.unwrap();
        let (_, tok) = insert_key(
            &mut conn,
            ws,
            &CreateKey {
                name: "other-admin".into(),
                env: KeyEnv::Live,
                scopes: vec![Scope::Read, Scope::Send, Scope::Manage, Scope::Admin],
                domain_id: None,
                policy: None,
                recipient_allowlist: None,
                daily_send_cap: None,
                minute_send_cap: None,
                expires_at: None,
            },
        )
        .await
        .unwrap();
        let (s, b) = call(
            &self.app,
            "POST",
            "/v1/transports",
            Some(&tok),
            Some(json!({"kind": "smtp-relay", "name": "theirs",
                        "config": {"host": "127.0.0.1", "port": 1, "tls": "none"}})),
        )
        .await;
        assert_eq!(s, StatusCode::CREATED, "{b}");
        (tok, id_of(&b))
    }

    /// A published template with this alias.
    async fn template(&self, alias: &str, stream: &str) {
        let (s, b) = self
            .c(
                "POST",
                "/v1/templates",
                Some(
                    json!({"name": alias, "stream": stream, "content": {"version": 1,
                    "subject": "News", "blocks": [{"type": "paragraph", "text": "Hello"}]}}),
                ),
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{b}");
        let (s, b) = self
            .c("POST", &format!("/v1/templates/{alias}/publish"), None)
            .await;
        assert_eq!(s, StatusCode::OK, "{b}");
    }

    async fn status_of(&self, id: Uuid) -> String {
        sqlx::query_scalar("SELECT status FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(&self.db)
            .await
            .unwrap()
    }

    /// `(status, transport_id, routing why)` of every row of a broadcast.
    async fn broadcast_rows(&self, id: Uuid) -> Vec<(String, Option<Uuid>, Option<String>)> {
        let rows: Vec<(String, Option<Uuid>, Value)> = sqlx::query_as(
            "SELECT status, transport_id, policy_decisions FROM emails WHERE broadcast_id = $1 ORDER BY to_addr",
        )
        .bind(id)
        .fetch_all(&self.db)
        .await
        .unwrap();
        rows.into_iter()
            .map(|(s, t, d)| {
                let why = d
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|x| x["rule"] == "routing")
                    .and_then(|x| x["why"].as_str().map(String::from));
                (s, t, why)
            })
            .collect()
    }

    async fn wait_status(&self, id: Uuid, want: &str) {
        let end = Instant::now() + Duration::from_secs(30);
        loop {
            let st = self.status_of(id).await;
            if st == want {
                return;
            }
            assert!(Instant::now() < end, "status stuck at {st}, wanted {want}");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

type Inbox = Arc<Mutex<Vec<(String, String)>>>;

async fn wait_for(inbox: &Inbox, n: usize) {
    let end = Instant::now() + Duration::from_secs(30);
    while inbox.lock().unwrap().len() < n {
        assert!(
            Instant::now() < end,
            "the sink got {} of {n} messages",
            inbox.lock().unwrap().len()
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn mail_from(inbox: &Inbox, i: usize) -> String {
    inbox.lock().unwrap()[i].0.clone()
}

/// Sends as `key` (any env) with the usual defaults.
async fn send_as(e: &Env, key: &str, body: Value) -> (StatusCode, Value) {
    let mut b = json!({"to": ["rcpt@example.org"], "subject": "s", "text": "t"});
    b.as_object_mut()
        .unwrap()
        .extend(body.as_object().unwrap().clone());
    call(&e.app, "POST", "/v1/emails", Some(key), Some(b)).await
}

// ------------------------------------------------------------------ (1) approval hold

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_approval_held_email_keeps_its_pinned_transport_after_approve() {
    let Some(e) = env(true).await else { return };
    let (pa, inbox_a) = smtp_sink().await;
    let (pb, inbox_b) = smtp_sink().await;
    let a = e.relay_at("relay-a", "a@one.com", pa).await;
    let b = e.relay_at("relay-b", "b@two.com", pb).await;
    let agent = e
        .key(
            "live",
            &["send", "read"],
            Some(json!({"send": "needs_approval"})),
        )
        .await;

    // `from` routes to relay A; an explicit pin on the second email says B
    let (s, routed) = send_as(&e, &agent, json!({"from": "a@one.com"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{routed}");
    let (s, explicit) = send_as(&e, &agent, json!({"from": "a@one.com", "transport_id": b})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{explicit}");
    for r in [&routed, &explicit] {
        assert_eq!(r["data"]["status"], "pending_approval", "{r}");
    }
    let (t1, _, _, w1) = e.row(&routed).await;
    let (t2, _, _, w2) = e.row(&explicit).await;
    assert_eq!(
        (t1, w1["why"].as_str(), t2, w2["why"].as_str()),
        (Some(a), Some("mailbox_relay"), Some(b), Some("explicit")),
        "the transport is chosen when the email is held, not when it is approved"
    );

    // held means held: nothing is sent, and the pinned transport cannot be deleted from under it
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(inbox_a.lock().unwrap().is_empty() && inbox_b.lock().unwrap().is_empty());
    assert_eq!(e.status_of(id_of(&explicit)).await, "pending_approval");
    let (s, d) = e.c("DELETE", &format!("/v1/transports/{b}"), None).await;
    assert_eq!(
        (s, code(&d)),
        (StatusCode::CONFLICT, "transport_in_use"),
        "{d}"
    );

    // approve the explicit one: it still goes through B, not through the relay its From routes to
    let decide = |r: &Value| {
        format!(
            "/v1/approvals/{}/decide",
            r["data"]["approval_id"].as_str().unwrap()
        )
    };
    let (s, d) = e
        .c(
            "POST",
            &decide(&explicit),
            Some(json!({"decision": "approve"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    assert_eq!(e.row(&explicit).await.0, Some(b));
    wait_for(&inbox_b, 1).await;
    e.wait_status(id_of(&explicit), "sent").await;
    assert!(
        inbox_a.lock().unwrap().is_empty(),
        "approve must not re-route"
    );
    assert!(
        mail_from(&inbox_b, 0).contains("<b@two.com>"),
        "{}",
        mail_from(&inbox_b, 0)
    );
    assert_eq!(e.row(&explicit).await.0, Some(b));

    // and the routed one still goes through A
    assert_eq!(e.status_of(id_of(&routed)).await, "pending_approval");
    let (s, d) = e
        .c(
            "POST",
            &decide(&routed),
            Some(json!({"decision": "approve"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    wait_for(&inbox_a, 1).await;
    e.wait_status(id_of(&routed), "sent").await;
    assert!(
        mail_from(&inbox_a, 0).contains("<a@one.com>"),
        "{}",
        mail_from(&inbox_a, 0)
    );
    assert_eq!(inbox_b.lock().unwrap().len(), 1);
    assert_eq!(e.row(&routed).await.0, Some(a));
}

// ------------------------------------------------------------------ (2) scheduled

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_scheduled_email_pins_its_transport_when_it_is_enqueued() {
    let Some(e) = env(true).await else { return };
    let (pa, inbox_a) = smtp_sink().await;
    let (pb, inbox_b) = smtp_sink().await;
    let a = e.relay_at("relay-a", "a@one.com", pa).await;
    let b = e.relay_at("relay-b", "b@two.com", pb).await;
    let at = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();

    let (s, routed) = e
        .send(json!({"from": "a@one.com", "scheduled_at": at}))
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{routed}");
    let (s, explicit) = e
        .send(json!({"from": "a@one.com", "scheduled_at": at, "transport_id": b}))
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{explicit}");
    // pinned now, an hour before it is due
    for (r, want) in [(&routed, a), (&explicit, b)] {
        assert_eq!(r["data"]["status"], "queued", "{r}");
        let (t, _, _, why) = e.row(r).await;
        assert_eq!(t, Some(want), "{why}");
        let at_row: Option<chrono::DateTime<Utc>> =
            sqlx::query_scalar("SELECT scheduled_at FROM emails WHERE id = $1")
                .bind(id_of(r))
                .fetch_one(&e.db)
                .await
                .unwrap();
        assert!(at_row.is_some_and(|t| t > Utc::now()), "{at_row:?}");
    }
    assert_eq!(
        e.row(&routed).await.3["why"],
        "mailbox_relay",
        "routed by From at enqueue"
    );
    assert_eq!(e.row(&explicit).await.3["why"], "explicit");
    // the pin protects the transport while the email waits
    let (s, d) = e.c("DELETE", &format!("/v1/transports/{a}"), None).await;
    assert_eq!(
        (s, code(&d)),
        (StatusCode::CONFLICT, "transport_in_use"),
        "{d}"
    );

    // not due: not sent
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(inbox_a.lock().unwrap().is_empty() && inbox_b.lock().unwrap().is_empty());

    // due: each goes through the transport pinned when it was scheduled
    for (r, inbox) in [(&explicit, &inbox_b), (&routed, &inbox_a)] {
        sqlx::query(
            "UPDATE emails SET scheduled_at = now(), next_attempt_at = now() WHERE id = $1",
        )
        .bind(id_of(r))
        .execute(&e.db)
        .await
        .unwrap();
        wait_for(inbox, 1).await;
        e.wait_status(id_of(r), "sent").await;
    }
    assert_eq!(
        (inbox_a.lock().unwrap().len(), inbox_b.lock().unwrap().len()),
        (1, 1)
    );
    assert!(mail_from(&inbox_b, 0).contains("<b@two.com>"));
    assert!(mail_from(&inbox_a, 0).contains("<a@one.com>"));
    assert_eq!(e.row(&routed).await.0, Some(a));
    assert_eq!(e.row(&explicit).await.0, Some(b));
}

// ------------------------------------------------------------------ (3) broadcast

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_broadcast_with_an_explicit_transport_pins_it_on_every_row() {
    let Some(e) = env(false).await else { return };
    let _default = e.transport("default-relay", json!({})).await;
    let zoho = e.mailbox("zoho", "news@one.com", json!({})).await;
    let other = e.transport("other", json!({})).await;
    e.template("news", "marketing").await;
    let rcpts = |tag: &str| -> Vec<Value> {
        (1..=3)
            .map(|i| json!({"email": format!("{tag}{i}@example.org")}))
            .collect()
    };

    // control: routed by From, every row is pinned to the mailbox relay
    let (s, b) = e
        .c(
            "POST",
            "/v1/broadcasts",
            Some(json!({"template_id": "news", "from": "news@one.com", "recipients": rcpts("c")})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let rows = e.broadcast_rows(id_of(&b)).await;
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|r| (r.1, r.2.as_deref()) == (Some(zoho), Some("mailbox_relay"))),
        "{rows:?}"
    );

    // explicit transport_id: wins over the From address on all rows
    let (s, b) = e
        .c(
            "POST",
            "/v1/broadcasts",
            Some(json!({"template_id": "news", "from": "news@one.com",
                        "transport_id": other, "recipients": rcpts("x")})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let rows = e.broadcast_rows(id_of(&b)).await;
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|r| (r.1, r.2.as_deref()) == (Some(other), Some("explicit"))),
        "{rows:?}"
    );

    // held for approval: the rows are pinned while held and stay pinned once approved
    let agent = e
        .key(
            "live",
            &["send", "read"],
            Some(json!({"send": "needs_approval"})),
        )
        .await;
    let (s, b) = call(
        &e.app,
        "POST",
        "/v1/broadcasts",
        Some(&agent),
        Some(json!({"template_id": "news", "from": "news@one.com",
                    "transport_id": other, "recipients": rcpts("h")})),
    )
    .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let held = id_of(&b);
    let rows = e.broadcast_rows(held).await;
    assert!(
        rows.iter()
            .all(|r| (r.0.as_str(), r.1) == ("pending_approval", Some(other))),
        "{rows:?}"
    );
    let ap = b["data"]["approval_id"].as_str().unwrap();
    let (s, d) = e
        .c(
            "POST",
            &format!("/v1/approvals/{ap}/decide"),
            Some(json!({"decision": "approve"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    let rows = e.broadcast_rows(held).await;
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|r| (r.0.as_str(), r.1, r.2.as_deref())
                == ("queued", Some(other), Some("explicit"))),
        "{rows:?}"
    );
}

// ------------------------------------------------------------------ (4) test keys

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_test_key_never_pins_a_transport() {
    let Some(e) = env(true).await else { return };
    let (port, inbox) = smtp_sink().await;
    let t = e.relay_at("relay", "a@one.com", port).await;
    e.template("news", "marketing").await;
    let test_key = e.key("test", &["send", "read"], None).await;
    let magic = |n: u32| format!("delivered+{n}@test.mailcraft.local");

    // a single send that names a real transport
    let (s, b) = send_as(&e, &test_key, json!({"to": [magic(1)], "transport_id": t})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let (pinned, dom, _, routing) = e.row(&b).await;
    assert_eq!(
        (pinned, dom, routing["decision"].as_str()),
        (None, None, Some("sandbox")),
        "{routing}"
    );
    // the dry run says so too
    let (s, d) = send_as(
        &e,
        &test_key,
        json!({"to": [magic(2)], "transport_id": t, "dry_run": true}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    assert_eq!(
        (
            d["data"]["would_send_via"].as_str(),
            d["data"]["transport"].is_null()
        ),
        (Some("sandbox"), true),
        "{d}"
    );
    // a batch item and a broadcast
    let (s, bt) = call(
        &e.app,
        "POST",
        "/v1/emails/batch",
        Some(&test_key),
        Some(
            json!({"emails": [{"to": [magic(3)], "subject": "s", "text": "t", "transport_id": t}]}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{bt}");
    let (s, bc) = call(
        &e.app,
        "POST",
        "/v1/broadcasts",
        Some(&test_key),
        Some(
            json!({"template_id": "news", "from": "noreply@test.mailcraft.local", "transport_id": t,
                    "recipients": [{"email": magic(4)}, {"email": magic(5)}]}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{bc}");
    let rows = e.broadcast_rows(id_of(&bc)).await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.1.is_none()), "{rows:?}");

    // the worker delivers all of them in the sandbox, never touches the relay, and pins nothing afterwards
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        let open: i64 =
            sqlx::query_scalar("SELECT count(*) FROM emails WHERE status <> 'delivered'")
                .fetch_one(&e.db)
                .await
                .unwrap();
        if open == 0 {
            break;
        }
        assert!(
            Instant::now() < end,
            "{open} emails never reached the sandbox"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let (n, pinned): (i64, i64) =
        sqlx::query_as("SELECT count(*), count(transport_id) FROM emails WHERE env = 'test'")
            .fetch_one(&e.db)
            .await
            .unwrap();
    assert_eq!((n, pinned), (4, 0));
    assert!(
        inbox.lock().unwrap().is_empty(),
        "a sandbox send reached the relay"
    );
    // so the relay is free to delete
    let (s, d) = e.c("DELETE", &format!("/v1/transports/{t}"), None).await;
    assert_eq!(s, StatusCode::OK, "{d}");
}

/// Installs a one-step automation sending through `transport` and starts a sandbox test run for it.
/// Returns the run, or `None` when the install itself refused the transport.
async fn sandbox_run(e: &Env, transport: Uuid) -> Option<Uuid> {
    let (s, b) = e
        .c(
            "POST",
            "/v1/automations",
            Some(json!({"name": format!("via-{transport}"), "trigger": "go", "steps": [
                {"key": "mail", "type": "send_email",
                 "config": {"template": "welcome", "from": "news@one.com", "transport_id": transport}}]})),
        )
        .await;
    if s != StatusCode::CREATED {
        assert!(s.is_client_error(), "{s} {b}");
        return None;
    }
    let test_key = e.key("test", &["send", "read"], None).await;
    let (s, r) = call(
        &e.app,
        "POST",
        &format!("/v1/automations/{}/test", id_of(&b)),
        Some(&test_key),
        Some(json!({"email": "delivered@test.mailcraft.local"})),
    )
    .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{r}");
    // what `wiring::serve` runs every second, with the same router
    Engine::new(
        e.db.clone(),
        Arc::new(NoopPersonalizer),
        EngineConfig::default(),
    )
    .router(Arc::new(e.st.clone()))
    .tick(Utc::now())
    .await
    .unwrap();
    Some(r["data"]["run_id"].as_str().unwrap().parse().unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_automation_test_run_sends_through_the_step_transport_in_the_sandbox() {
    let Some(e) = env(false).await else { return };
    let zoho = e.mailbox("zoho", "news@one.com", json!({})).await;
    e.template("welcome", "transactional").await;
    let run = sandbox_run(&e, zoho).await.expect("own transport installs");
    let (state, n): (String, i64) = sqlx::query_as(
        "SELECT r.state, (SELECT count(*) FROM emails WHERE automation_run_id = r.id) FROM automation_runs r WHERE r.id = $1",
    )
    .bind(run)
    .fetch_one(&e.db)
    .await
    .unwrap();
    assert_ne!(state, "failed");
    assert_eq!(n, 1);
    let env: String = sqlx::query_scalar("SELECT env FROM emails WHERE automation_run_id = $1")
        .bind(run)
        .fetch_one(&e.db)
        .await
        .unwrap();
    assert_eq!(env, "test");
}

/// A sandbox email reaches no transport, so none should be pinned on it (the API send path and the
/// broadcast path both leave `transport_id` NULL for test keys).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "bug: automations engine pins the routed transport on env='test' rows (crates/mailcraft-automations/src/engine.rs:1309); a sandbox automation email then makes DELETE /v1/transports/{id} answer 409 transport_in_use"]
async fn an_automation_sandbox_email_pins_no_transport() {
    let Some(e) = env(false).await else { return };
    let zoho = e.mailbox("zoho", "news@one.com", json!({})).await;
    e.template("welcome", "transactional").await;
    let run = sandbox_run(&e, zoho).await.expect("own transport installs");
    let (env, pinned): (String, Option<Uuid>) =
        sqlx::query_as("SELECT env, transport_id FROM emails WHERE automation_run_id = $1")
            .bind(run)
            .fetch_one(&e.db)
            .await
            .unwrap();
    assert_eq!((env.as_str(), pinned), ("test", None));
}

// ------------------------------------------------------------------ (5) another workspace's transport

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_transport_of_another_workspace_is_not_found_on_emails_and_broadcasts() {
    let Some(e) = env(false).await else { return };
    e.mailbox("zoho", "news@one.com", json!({})).await;
    e.template("news", "marketing").await;
    let (_, foreign) = e.other_workspace().await;
    let not_found = |s: StatusCode, b: &Value| {
        assert_eq!(
            (s, code(b), b["error"]["field"].as_str()),
            (StatusCode::NOT_FOUND, "not_found", Some("transport_id")),
            "{b}"
        );
    };

    let (s, b) = e
        .send(json!({"from": "news@one.com", "transport_id": foreign}))
        .await;
    not_found(s, &b);
    let (s, b) = e
        .send(json!({"from": "news@one.com", "transport_id": foreign, "dry_run": true}))
        .await;
    not_found(s, &b);
    // a batch reports it per item
    let (s, b) = e
        .c(
            "POST",
            "/v1/emails/batch",
            Some(json!({"emails": [
                {"from": "news@one.com", "to": ["r@example.org"], "subject": "s", "text": "t", "transport_id": foreign}]})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    assert_eq!(b["data"][0]["ok"], false, "{b}");
    assert_eq!(b["data"][0]["error"]["code"], "not_found", "{b}");

    for dry_run in [false, true] {
        let (s, b) = e
            .c(
                "POST",
                "/v1/broadcasts",
                Some(
                    json!({"template_id": "news", "from": "news@one.com", "transport_id": foreign,
                            "dry_run": dry_run, "recipients": [{"email": "a@example.org"}]}),
                ),
            )
            .await;
        not_found(s, &b);
    }

    // nothing was queued or created along the way
    let (emails, broadcasts): (i64, i64) =
        sqlx::query_as("SELECT (SELECT count(*) FROM emails), (SELECT count(*) FROM broadcasts)")
            .fetch_one(&e.db)
            .await
            .unwrap();
    assert_eq!((emails, broadcasts), (0, 0));
}

/// The step is only checked when it runs: the router (`SendRouter for AppState`) refuses a transport
/// that is not the workspace's, the run fails with that reason and no email is created.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_automation_step_naming_another_workspaces_transport_never_sends() {
    let Some(e) = env(false).await else { return };
    e.mailbox("zoho", "news@one.com", json!({})).await;
    e.template("welcome", "transactional").await;
    let (_, foreign) = e.other_workspace().await;
    let Some(run) = sandbox_run(&e, foreign).await else {
        return; // the install refused it up front: nothing to run
    };
    let state: String = sqlx::query_scalar("SELECT state FROM automation_runs WHERE id = $1")
        .bind(run)
        .fetch_one(&e.db)
        .await
        .unwrap();
    let log: Vec<Value> =
        sqlx::query_scalar("SELECT result FROM automation_run_steps WHERE run_id = $1")
            .bind(run)
            .fetch_all(&e.db)
            .await
            .unwrap();
    assert_eq!(state, "failed", "{log:?}");
    assert!(
        log.iter().any(|l| l["error"]
            .as_str()
            .is_some_and(|m| m.contains("not a transport of this workspace"))),
        "{log:?}"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM emails")
        .fetch_one(&e.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

/// Emails, broadcasts and `PATCH /v1/domains` all answer 404 for a transport of another workspace
/// when the request is made; an automation send step is only checked when a run reaches it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "bug: installing an automation whose send step names another workspace's transport_id answers 201 (crates/mailcraft-automations/src/def.rs:519 `install` checks the template, never the transport); the run fails later instead"]
async fn installing_a_send_step_with_another_workspaces_transport_is_rejected() {
    let Some(e) = env(false).await else { return };
    e.mailbox("zoho", "news@one.com", json!({})).await;
    e.template("welcome", "transactional").await;
    let (_, foreign) = e.other_workspace().await;
    let (s, b) = e
        .c(
            "POST",
            "/v1/automations",
            Some(json!({"name": "foreign", "trigger": "go", "steps": [
                {"key": "mail", "type": "send_email",
                 "config": {"template": "welcome", "from": "news@one.com", "transport_id": foreign}}]})),
        )
        .await;
    assert!(
        s == StatusCode::NOT_FOUND || s == StatusCode::UNPROCESSABLE_ENTITY,
        "{s} {b}"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM automations")
        .fetch_one(&e.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

// ------------------------------------------------------------------ (6) edits are gated

/// Addresses listed by `GET /v1/senders` (a relay's login and aliases).
async fn sender_addresses(e: &Env) -> Vec<String> {
    let (_, b) = e.c("GET", "/v1/senders", None).await;
    b["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["address"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transport_and_domain_edits_need_manage_and_stay_in_the_workspace() {
    let Some(e) = env(false).await else { return };
    let relay = e
        .mailbox("zoho", "a@one.com", json!({"aliases": ["al@one.com"]}))
        .await;
    let plain = e.transport("plain", json!({})).await;
    let dom = e.domain("two.com", true).await;
    let (other_admin, foreign) = e.other_workspace().await;
    let before = sender_addresses(&e).await;
    assert_eq!(before, vec!["a@one.com", "al@one.com"]);

    // read-only and send-only keys cannot edit a relay or bind a domain
    for scopes in [&["read"][..], &["read", "send"][..]] {
        let key = e.key("live", scopes, None).await;
        let (s, b) = call(
            &e.app,
            "PATCH",
            &format!("/v1/transports/{relay}"),
            Some(&key),
            Some(json!({"aliases": ["evil@one.com"]})),
        )
        .await;
        assert_eq!(
            (s, code(&b)),
            (StatusCode::FORBIDDEN, "forbidden_scope"),
            "{scopes:?} {b}"
        );
        let (s, b) = call(
            &e.app,
            "PATCH",
            &format!("/v1/domains/{dom}"),
            Some(&key),
            Some(json!({"transport_id": plain})),
        )
        .await;
        assert_eq!(
            (s, code(&b)),
            (StatusCode::FORBIDDEN, "forbidden_scope"),
            "{scopes:?} {b}"
        );
    }
    // and without any key
    let (s, _) = call(
        &e.app,
        "PATCH",
        &format!("/v1/transports/{relay}"),
        None,
        Some(json!({"aliases": []})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    // none of that changed anything
    assert_eq!(sender_addresses(&e).await, before);
    let (_, g) = e.c("GET", &format!("/v1/domains/{dom}"), None).await;
    assert!(g["data"]["transport_id"].is_null(), "{g}");

    // a domain cannot be bound to a transport of another workspace
    let (s, b) = e
        .c(
            "PATCH",
            &format!("/v1/domains/{dom}"),
            Some(json!({"transport_id": foreign})),
        )
        .await;
    assert_eq!(
        (s, code(&b), b["error"]["field"].as_str()),
        (StatusCode::NOT_FOUND, "not_found", Some("transport_id")),
        "{b}"
    );
    let (_, g) = e.c("GET", &format!("/v1/domains/{dom}"), None).await;
    assert!(g["data"]["transport_id"].is_null(), "{g}");

    // the other workspace cannot reach ours either: not our relay, not our domain (even to its own transport)
    let (s, _) = call(
        &e.app,
        "PATCH",
        &format!("/v1/transports/{relay}"),
        Some(&other_admin),
        Some(json!({"aliases": ["evil@one.com"]})),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = call(
        &e.app,
        "PATCH",
        &format!("/v1/domains/{dom}"),
        Some(&other_admin),
        Some(json!({"transport_id": foreign})),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // ... and ours cannot edit theirs
    let (s, _) = e
        .c(
            "PATCH",
            &format!("/v1/transports/{foreign}"),
            Some(json!({"aliases": []})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(sender_addresses(&e).await, before);
    let (_, g) = e.c("GET", &format!("/v1/domains/{dom}"), None).await;
    assert!(g["data"]["transport_id"].is_null(), "{g}");
    // no rejected edit was audited as done
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action IN ('transport.update','domain.update')",
    )
    .fetch_one(&e.db)
    .await
    .unwrap();
    assert_eq!(n, 0);
}
