//! In-process end-to-end: the fully wired server (`wiring::assemble`: real services, engine,
//! finalizer, transports) against real Postgres, with a tiny SMTP sink as the "relay".
//!
//! * sandbox path: first-run setup -> test send to `delivered@test.mailcraft.local` -> `delivered`,
//!   an `email_events` row, and an `email.delivered` webhook delivery row.
//! * live path: smtp-relay transport (config sealed in Postgres) -> domain with generated DKIM keys
//!   -> go-live -> send -> the sink receives a message whose DKIM signature VERIFIES against the
//!   domain's published public key (mail-auth).
//!
//! Needs Postgres (MAILCRAFT_TEST_PG); fails instead of skipping when MAILCRAFT_REQUIRE_DB=1.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use http_body_util::BodyExt;
use mail_auth::{
    dkim::DomainKey,
    dns::{Parameters, ResolverCache, TxtRecord, TxtRecordParser},
    AuthenticatedMessage, DkimResult, MessageAuthenticator,
};
use mailcraft_api::{wiring, Config};
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
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55432/postgres".into())
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
    let name = format!("mc_e2e_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let url = format!("{}/{name}", pg_url().rsplit_once('/').unwrap().0);
    let db = PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("../../migrations").run(&db).await.unwrap();
    Some(db)
}

/// Minimal SMTP server: accepts everything, keeps each DATA payload.
async fn smtp_sink() -> (u16, Arc<Mutex<Vec<Vec<u8>>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let got: Arc<Mutex<Vec<Vec<u8>>>> = Default::default();
    let store = got.clone();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let store = store.clone();
            tokio::spawn(async move {
                let (r, mut w) = s.into_split();
                let mut r = BufReader::new(r);
                let _ = w.write_all(b"220 sink ESMTP\r\n").await;
                let (mut data, mut in_data) = (Vec::new(), false);
                let mut line = String::new();
                loop {
                    line.clear();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    if in_data {
                        if line == ".\r\n" {
                            store.lock().unwrap().push(std::mem::take(&mut data));
                            in_data = false;
                            let _ = w.write_all(b"250 2.0.0 queued as sink-1\r\n").await;
                        } else {
                            // un-dot-stuff: a leading ".." is a literal "."
                            let l = if line.starts_with("..") {
                                &line[1..]
                            } else {
                                &line[..]
                            };
                            data.extend_from_slice(l.as_bytes());
                        }
                        continue;
                    }
                    let up = line.to_ascii_uppercase();
                    let reply: &[u8] = if up.starts_with("EHLO") || up.starts_with("HELO") {
                        b"250-sink\r\n250 8BITMIME\r\n"
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

async fn wait<F, Fut>(what: &str, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let end = Instant::now() + Duration::from_secs(30);
    while Instant::now() < end {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("timed out waiting for {what}");
}

/// In-memory TXT cache standing in for DNS (the domain's published DKIM key).
#[derive(Default)]
struct Txt(Mutex<HashMap<Box<str>, TxtRecord>>);
impl ResolverCache<Box<str>, TxtRecord> for Txt {
    fn get<Q>(&self, k: &Q) -> Option<TxtRecord>
    where
        Box<str>: std::borrow::Borrow<Q>,
        Q: std::hash::Hash + Eq + ?Sized,
    {
        self.0.lock().unwrap().get(k).cloned()
    }
    fn remove<Q>(&self, k: &Q) -> Option<TxtRecord>
    where
        Box<str>: std::borrow::Borrow<Q>,
        Q: std::hash::Hash + Eq + ?Sized,
    {
        self.0.lock().unwrap().remove(k)
    }
    fn insert(&self, k: Box<str>, v: TxtRecord, _: Instant) {
        self.0.lock().unwrap().insert(k, v);
    }
}
struct Dns(Txt);
impl mail_auth::dns::DnsCache for Dns {
    type Txt = Txt;
    type Mx = mail_auth::dns::NoCache;
    type Ipv4 = mail_auth::dns::NoCache;
    type Ipv6 = mail_auth::dns::NoCache;
    type Ptr = mail_auth::dns::NoCache;
    fn txt(&self) -> Option<&Txt> {
        Some(&self.0)
    }
    fn mx(&self) -> Option<&Self::Mx> {
        None
    }
    fn ipv4(&self) -> Option<&Self::Ipv4> {
        None
    }
    fn ipv6(&self) -> Option<&Self::Ipv6> {
        None
    }
    fn ptr(&self) -> Option<&Self::Ptr> {
        None
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sandbox_and_live_through_the_wired_server() {
    let Some(db) = fresh_db().await else { return };
    // SPF for the return path needs a sending IP (a documentation address here).
    std::env::set_var("MAILCRAFT_EGRESS_IP", "203.0.113.10");
    let key = "e2e-test-secret-key-0123456789";
    let mut cfg = Config::from_env();
    cfg.rate_limit_per_min = 6000;
    cfg.allow_private_webhooks = true;
    cfg.unsub_secret = b"e2e-unsub-secret".to_vec();
    let (st, engine) = wiring::assemble(db.clone(), None, key, cfg).await.unwrap();
    let app = mailcraft_api::router(st.clone());
    let (stop, rx) = tokio::sync::watch::channel(false);
    tokio::spawn(engine.run(rx.clone()));
    tokio::spawn(mailcraft_api::run_background(st.clone(), rx));

    // --- first-run setup (once) ---
    let (s, setup) = call(&app, "POST", "/v1/setup", None, Some(json!({}))).await;
    assert_eq!(s, StatusCode::CREATED, "{setup}");
    let admin = setup["data"]["admin_key"].as_str().unwrap().to_string();
    let test = setup["data"]["test_key"].as_str().unwrap().to_string();
    let (s, again) = call(&app, "POST", "/v1/setup", None, Some(json!({}))).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(again["error"]["code"], "invalid_state");

    // --- sandbox: delivered + event + webhook ---
    let (s, _) = call(
        &app,
        "POST",
        "/v1/webhooks",
        Some(&admin),
        Some(json!({"url": "http://127.0.0.1:9/hook", "events": ["email.*"]})),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, sent) = call(
        &app,
        "POST",
        "/v1/emails",
        Some(&test),
        Some(
            json!({"to": ["delivered@test.mailcraft.local"], "subject": "hi", "text": "It works"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{sent}");
    let eid: Uuid = sent["data"]["id"].as_str().unwrap().parse().unwrap();
    wait("sandbox email delivered", || async {
        let st: String = sqlx::query_scalar("SELECT status FROM emails WHERE id = $1")
            .bind(eid)
            .fetch_one(&db)
            .await
            .unwrap();
        st == "delivered"
    })
    .await;
    let (_, ev) = call(
        &app,
        "GET",
        &format!("/v1/emails/{eid}/events"),
        Some(&test),
        None,
    )
    .await;
    let types: Vec<&str> = ev["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert!(types.contains(&"delivered"), "{types:?}");
    wait("email.delivered webhook delivery row", || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM webhook_deliveries WHERE event_type = 'email.delivered'",
        )
        .fetch_one(&db)
        .await
        .unwrap()
            > 0
    })
    .await;

    // test keys never reach a transport, even when one exists
    let (port, inbox) = smtp_sink().await;
    let (s, t) = call(&app, "POST", "/v1/transports", Some(&admin), Some(json!({"kind": "smtp-relay", "name": "sink", "config": {"host": "127.0.0.1", "port": port, "tls": "none"}}))).await;
    assert_eq!(s, StatusCode::CREATED, "{t}");
    assert!(
        t["data"]["config"].get("password").is_none(),
        "secrets are write-only"
    );
    let (_, _) = call(
        &app,
        "POST",
        "/v1/emails",
        Some(&test),
        Some(json!({"to": ["delivered@test.mailcraft.local"], "subject": "again", "text": "x"})),
    )
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        inbox.lock().unwrap().is_empty(),
        "a test-key email reached the SMTP transport"
    );

    // --- live: domain with DKIM keys, go-live, send through the relay ---
    let (s, dom) = call(
        &app,
        "POST",
        "/v1/domains",
        Some(&admin),
        Some(json!({"domain": "mail.e2e.test"})),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{dom}");
    assert!(dom["data"]["records"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["record"] == "DKIM"));
    sqlx::query(
        "UPDATE domains SET status = 'verified', verified_at = now() WHERE name = 'mail.e2e.test'",
    )
    .execute(&db)
    .await
    .unwrap();
    let (_, gl) = call(
        &app,
        "POST",
        "/v1/go-live-requests",
        Some(&admin),
        Some(json!({"note": "e2e"})),
    )
    .await;
    let ap = gl["data"]["approval_id"].as_str().unwrap().to_string();
    let (s, _) = call(
        &app,
        "POST",
        &format!("/v1/approvals/{ap}/decide"),
        Some(&admin),
        Some(json!({"decision": "approve"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, live) = call(&app, "POST", "/v1/emails", Some(&admin), Some(json!({"from": "hello@mail.e2e.test", "to": ["rcpt@example.org"], "subject": "live", "text": "via the relay"}))).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{live}");
    wait("the SMTP sink to receive the message", || async {
        !inbox.lock().unwrap().is_empty()
    })
    .await;
    let raw = inbox.lock().unwrap()[0].clone();

    // The signature verifies against the public key stored for the domain.
    let (sel, pk): (String, String) = sqlx::query_as(
        "SELECT k.selector, k.public_key FROM dkim_keys k JOIN domains d ON d.id = k.domain_id WHERE d.name = 'mail.e2e.test' AND k.state = 'active'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let dns = Dns(Txt::default());
    let rec = format!("v=DKIM1; k=rsa; p={}", pk.trim());
    assert!(
        B64.decode(pk.trim()).is_ok(),
        "stored public key is base64 SPKI"
    );
    dns.0.insert(
        format!("{sel}._domainkey.mail.e2e.test.").into(),
        TxtRecord::from(DomainKey::parse(rec.as_bytes()).unwrap()),
        Instant::now() + Duration::from_secs(3600),
    );
    let auth = MessageAuthenticator::new_cloudflare().unwrap();
    let msg = AuthenticatedMessage::parse(&raw).unwrap();
    let out = auth
        .verify_dkim(Parameters::new(&msg).with_cache(&dns))
        .await;
    assert!(
        !out.is_empty(),
        "no DKIM-Signature on the relayed message:\n{}",
        String::from_utf8_lossy(&raw)
    );
    assert_eq!(out[0].result(), &DkimResult::Pass, "DKIM did not verify");
    assert_eq!(out[0].signature().unwrap().d, "mail.e2e.test");
    let text = String::from_utf8_lossy(&raw);
    assert!(
        text.contains("Feedback-ID:") && text.contains("Message-ID:"),
        "{text}"
    );

    let (_, e) = call(
        &app,
        "GET",
        &format!("/v1/emails/{}", live["data"]["id"].as_str().unwrap()),
        Some(&admin),
        None,
    )
    .await;
    assert_eq!(e["data"]["status"], "sent");
    let _ = stop.send(true);
}

/// A broadcast row goes through the same worker as any email: the per-recipient variables render
/// ("Hi Ada" / the `default` fallback), the unsubscribe footer is injected, outcomes feed the counts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn broadcast_rows_render_per_recipient_in_the_worker() {
    let Some(db) = fresh_db().await else { return };
    let mut cfg = Config::from_env();
    cfg.rate_limit_per_min = 6000;
    cfg.unsub_secret = b"e2e-unsub-secret".to_vec();
    let (st, engine) = wiring::assemble(db.clone(), None, "e2e-test-secret-key-0123456789", cfg)
        .await
        .unwrap();
    let app = mailcraft_api::router(st.clone());
    let (stop, rx) = tokio::sync::watch::channel(false);
    tokio::spawn(engine.run(rx));
    let (_, setup) = call(&app, "POST", "/v1/setup", None, Some(json!({}))).await;
    let (admin, test) = (
        setup["data"]["admin_key"].as_str().unwrap().to_string(),
        setup["data"]["test_key"].as_str().unwrap().to_string(),
    );
    sqlx::query("UPDATE workspaces SET postal_address = '1 Main St'")
        .execute(&db)
        .await
        .unwrap();
    let tpl = json!({"name": "news", "stream": "marketing", "content": {"version": 1,
        "subject": "News for {{ first_name | default(\"you\") }}",
        "blocks": [{"type": "paragraph", "text": "Hi {{ first_name | default(\"there\") }} at {{ data.company | default('your team') }}"}]}});
    assert_eq!(
        call(&app, "POST", "/v1/templates", Some(&admin), Some(tpl))
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/v1/templates/news/publish",
            Some(&admin),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let (s, b) = call(&app, "POST", "/v1/broadcasts", Some(&test), Some(json!({
        "template_id": "news", "from": "dev@acme.io",
        "recipients": [
            {"email": "delivered@test.mailcraft.local", "first_name": "Ada", "data": {"company": "Acme"}},
            {"email": "bounced@test.mailcraft.local"}]}))).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let bid: Uuid = b["data"]["id"].as_str().unwrap().parse().unwrap();
    wait("both rows reach an outcome", || async {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM emails WHERE broadcast_id = $1 AND status IN ('delivered','bounced')")
            .bind(bid)
            .fetch_one(&db)
            .await
            .unwrap();
        n == 2
    })
    .await;
    type Sent = (String, String, String);
    let rows: Vec<Sent> = sqlx::query_as(
        "SELECT e.to_addr, e.subject, b.html FROM emails e JOIN email_bodies b ON b.email_id = e.id \
         WHERE e.broadcast_id = $1 ORDER BY e.to_addr",
    )
    .bind(bid)
    .fetch_all(&db)
    .await
    .unwrap();
    assert!(
        rows[0].1 == "News for you" && rows[0].2.contains("Hi there at your team"),
        "{rows:?}"
    );
    assert!(
        rows[1].1 == "News for Ada" && rows[1].2.contains("Hi Ada at Acme"),
        "{rows:?}"
    );
    assert!(rows
        .iter()
        .all(|r| r.2.contains("Unsubscribe") && r.2.contains("/u/")));
    let (_, d) = call(
        &app,
        "GET",
        &format!("/v1/broadcasts/{bid}"),
        Some(&test),
        None,
    )
    .await;
    assert_eq!(d["data"]["counts"]["delivered"], 1, "{d}");
    assert_eq!(d["data"]["counts"]["bounced"], 1, "{d}");
    assert_eq!(d["data"]["status"], "done");
    let _ = stop.send(true);
}
