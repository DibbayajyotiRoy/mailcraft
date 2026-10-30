//! Integration tests against real Postgres and Redis.
//! Defaults match the throwaway containers from the task brief; override with
//! MAILCRAFT_TEST_PG / MAILCRAFT_TEST_REDIS. If Postgres is unreachable the tests skip, unless
//! MAILCRAFT_REQUIRE_DB=1 (CI), where they fail.
use std::{collections::HashMap, sync::Arc};

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use mailcraft_api::{
    audit,
    keys::{insert_key, CreateKey},
    router, webhooks, AppState, Config,
};
use mailcraft_core::{
    auth::{KeyEnv, Scope},
    crypto::SecretBox,
    services::{AddDomain, DomainService, DomainView},
    webhook,
};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use tower::ServiceExt;
use uuid::Uuid;

struct Ctx {
    app: Router,
    st: AppState,
    ws: Uuid,
    admin: String,
    redis_url: String,
}

fn pg_url() -> String {
    std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55432/postgres".into())
}

async fn setup_with(cfg: impl FnOnce(&mut Config)) -> Option<Ctx> {
    let admin_pool = match PgPool::connect(&pg_url()).await {
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
    let name = format!("mc_{}", Uuid::new_v4().simple());
    admin_pool
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let url = pg_url();
    let url = format!("{}/{name}", url.rsplit_once('/').unwrap().0);
    let db = PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("../../migrations").run(&db).await.unwrap();
    let ws: Uuid = sqlx::query_scalar(
        "INSERT INTO workspaces (name, live_enabled) VALUES ('t', false) RETURNING id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let redis_url =
        std::env::var("MAILCRAFT_TEST_REDIS").unwrap_or_else(|_| "redis://127.0.0.1:56379".into());
    let redis = match redis::Client::open(redis_url.clone()) {
        Ok(c) => c.get_connection_manager().await.ok(),
        Err(_) => None,
    };
    let mut config = Config {
        rate_limit_per_min: 600,
        metrics_token: None,
        allow_private_webhooks: true,
        ..Config::from_env()
    };
    cfg(&mut config);
    let st = AppState::new(
        db.clone(),
        redis,
        SecretBox::from_key(&[9u8; 32]).unwrap(),
        config,
    );
    let mut c = db.acquire().await.unwrap();
    let (_, admin) = insert_key(
        &mut c,
        ws,
        &spec(
            "admin",
            KeyEnv::Live,
            &[Scope::Read, Scope::Send, Scope::Manage, Scope::Admin],
        ),
    )
    .await
    .unwrap();
    drop(c);
    Some(Ctx {
        app: router(st.clone()),
        st,
        ws,
        admin,
        redis_url,
    })
}

async fn setup() -> Option<Ctx> {
    setup_with(|_| {}).await
}

macro_rules! ctx {
    () => {
        match setup().await {
            Some(c) => c,
            None => return,
        }
    };
}

fn spec(name: &str, env: KeyEnv, scopes: &[Scope]) -> CreateKey {
    CreateKey {
        name: name.into(),
        env,
        scopes: scopes.to_vec(),
        domain_id: None,
        policy: None,
        recipient_allowlist: None,
        daily_send_cap: None,
        minute_send_cap: None,
        expires_at: None,
    }
}

impl Ctx {
    async fn key(&self, s: CreateKey) -> String {
        let mut c = self.st.db.acquire().await.unwrap();
        insert_key(&mut c, self.ws, &s).await.unwrap().1
    }
    async fn call(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        extra: &[(&str, &str)],
        body: Option<Value>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        call_on(&self.app, method, path, token, extra, body).await
    }
    async fn verify_domain(&self, name: &str) -> Uuid {
        sqlx::query_scalar("INSERT INTO domains (workspace_id, name, status, return_path_host) VALUES ($1,$2,'verified',$3) RETURNING id")
            .bind(self.ws)
            .bind(name)
            .bind(format!("bounce.{name}"))
            .fetch_one(&self.st.db)
            .await
            .unwrap()
    }
    async fn count_emails(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM emails")
            .fetch_one(&self.st.db)
            .await
            .unwrap()
    }
}

async fn call_on(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    extra: &[(&str, &str)],
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn test_mail(to: &str) -> Value {
    json!({"to": [to], "subject": "hi", "text": "hello"})
}

fn code(b: &Value) -> &str {
    b["error"]["code"].as_str().unwrap_or("")
}

// ----------------------------------------------------------------- contract

#[tokio::test]
async fn every_openapi_route_is_mounted() {
    // Lazy pool: nothing here touches the database, auth fails first.
    let db = PgPool::connect_lazy("postgres://x:x@127.0.0.1:1/x").unwrap();
    let st = AppState::new(
        db,
        None,
        SecretBox::from_key(&[1u8; 32]).unwrap(),
        Config::from_env(),
    );
    let app = router(st);
    let spec = include_str!("../../../openapi.yaml");
    let (mut path, mut checked) = (String::new(), 0);
    for line in spec.lines() {
        if line.starts_with("  /") && line.trim_end().ends_with(':') {
            path = line.trim().trim_end_matches(':').to_string();
        } else if let Some(m) = ["get", "post", "put", "patch", "delete"]
            .iter()
            .find(|m| line.starts_with(&format!("    {m}:")))
        {
            if [
                "/healthz",
                "/readyz",
                "/metrics",
                "/openapi.yaml",
                "/u/{token}",
                "/ingest/raw",
                "/ingest/ses",
                "/v1/setup",
            ]
            .contains(&path.as_str())
            {
                continue;
            }
            let uri = path
                .replace("{id}", &Uuid::nil().to_string())
                .replace("{version}", "1")
                .replace("{run}", &Uuid::nil().to_string());
            let (s, _, b) = call_on(&app, &m.to_uppercase(), &uri, None, &[], None).await;
            assert_eq!(
                s,
                StatusCode::UNAUTHORIZED,
                "{m} {path} is documented but not mounted"
            );
            assert_eq!(code(&b), "unauthenticated");
            checked += 1;
        }
    }
    assert!(checked >= 40, "parsed only {checked} operations");
}

#[tokio::test]
async fn envelope_request_id_and_errors() {
    let Some(c) = setup().await else { return };
    let (s, h, b) = c.call("GET", "/v1/nope", None, &[], None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(code(&b), "not_found");
    assert!(b["error"]["doc_url"]
        .as_str()
        .unwrap()
        .ends_with("not_found.md"));
    assert!(b["request_id"].as_str().unwrap().starts_with("req_"));
    assert_eq!(h["x-request-id"], b["request_id"].as_str().unwrap());
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&c.admin),
            &[],
            Some(json!({"to": "nope"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(code(&b), "invalid_request");
    assert!(b["error"]["hint"].is_string());
    let (_, _, ok) = c
        .call("GET", "/v1/account/status", Some(&c.admin), &[], None)
        .await;
    assert_eq!(ok["ok"], true);
    assert!(ok["request_id"].is_string());
}

#[tokio::test]
async fn health_ready_metrics() {
    let c = ctx!();
    assert_eq!(
        c.call("GET", "/healthz", None, &[], None).await.0,
        StatusCode::OK
    );
    let (s, _, b) = c.call("GET", "/readyz", None, &[], None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["checks"]["postgres"], "ok");
    c.call("GET", "/v1/account/status", Some(&c.admin), &[], None)
        .await;
    let res = c
        .app
        .clone()
        .oneshot(Request::get("/metrics").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let text =
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(text.contains("mailcraft_http_requests_total"));
    assert!(text.contains("mailcraft_kill_switch"));
}

#[tokio::test]
async fn metrics_token_is_enforced() {
    let Some(c) = setup_with(|c| c.metrics_token = Some("s3cret".into())).await else {
        return;
    };
    let (s, ..) = c.call("GET", "/metrics", None, &[], None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, ..) = c.call("GET", "/metrics", Some("s3cret"), &[], None).await;
    assert_eq!(s, StatusCode::OK);
}

// --------------------------------------------------------------- auth/scopes

#[tokio::test]
async fn auth_scopes_revoke_expiry() {
    let c = ctx!();
    for tok in [
        None,
        Some("garbage"),
        Some("mc_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ] {
        assert_eq!(
            c.call("GET", "/v1/emails", tok, &[], None).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let ro = c.key(spec("ro", KeyEnv::Test, &[Scope::Read])).await;
    assert_eq!(
        c.call("GET", "/v1/emails", Some(&ro), &[], None).await.0,
        StatusCode::OK
    );
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&ro),
            &[],
            Some(test_mail("delivered@test.mailcraft.local")),
        )
        .await;
    assert_eq!((s, code(&b)), (StatusCode::FORBIDDEN, "forbidden_scope"));
    // revoked
    let (_, _, k) = c
        .call(
            "POST",
            "/v1/keys",
            Some(&c.admin),
            &[],
            Some(json!({"name":"a","env":"test","scopes":["read"]})),
        )
        .await;
    let (tok, id) = (
        k["data"]["token"].as_str().unwrap().to_string(),
        k["data"]["id"].as_str().unwrap().to_string(),
    );
    assert_eq!(
        c.call("GET", "/v1/emails", Some(&tok), &[], None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        c.call(
            "DELETE",
            &format!("/v1/keys/{id}"),
            Some(&c.admin),
            &[],
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        c.call("GET", "/v1/emails", Some(&tok), &[], None).await.0,
        StatusCode::UNAUTHORIZED
    );
    // expired
    let mut s = spec("exp", KeyEnv::Test, &[Scope::Read]);
    s.expires_at = Some(chrono::Utc::now() - chrono::Duration::seconds(5));
    let exp = c.key(s).await;
    assert_eq!(
        c.call("GET", "/v1/emails", Some(&exp), &[], None).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn key_crud_never_leaks_or_escalates() {
    let c = ctx!();
    let (s, _, k) = c.call("POST", "/v1/keys", Some(&c.admin), &[], Some(json!({"name":"agent","env":"test","scopes":["send","read"],"policy":{"send":"needs_approval"},"daily_send_cap":10}))).await;
    assert_eq!(s, StatusCode::CREATED);
    let token = k["data"]["token"].as_str().unwrap();
    assert!(token.starts_with("mc_test_") && token.len() == 40);
    // stored hashed, never plaintext
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_keys WHERE token_hash = digest($1, 'sha256')")
            .bind(token)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert_eq!(n, 1);
    let (_, _, list) = c.call("GET", "/v1/keys", Some(&c.admin), &[], None).await;
    assert!(!list.to_string().contains(token));
    // cannot mint admin, bad policy, bad allowlist
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/keys",
            Some(&c.admin),
            &[],
            Some(json!({"name":"x","env":"live","scopes":["admin"]})),
        )
        .await;
    assert_eq!((s, code(&b)), (StatusCode::FORBIDDEN, "forbidden_scope"));
    let (s, ..) = c
        .call(
            "POST",
            "/v1/keys",
            Some(&c.admin),
            &[],
            Some(json!({"name":"x","env":"live","scopes":["read"],"policy":{"send":"yolo"}})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, ..) = c.call("POST", "/v1/keys", Some(&c.admin), &[], Some(json!({"name":"x","env":"live","scopes":["read"],"recipient_allowlist":["not an address"]}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // the agent key cannot touch keys at all
    assert_eq!(
        c.call("GET", "/v1/keys", Some(token), &[], None).await.0,
        StatusCode::FORBIDDEN
    );
    // patch
    let id = k["data"]["id"].as_str().unwrap();
    let (s, _, p) = c
        .call(
            "PATCH",
            &format!("/v1/keys/{id}"),
            Some(&c.admin),
            &[],
            Some(json!({"daily_send_cap": 3})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(p["data"]["daily_send_cap"], 3);
}

// ------------------------------------------------------------- idempotency

#[tokio::test]
async fn idempotency_replay_conflict_and_race() {
    let c = ctx!();
    let k = c
        .key(spec("t", KeyEnv::Test, &[Scope::Send, Scope::Read]))
        .await;
    let body = test_mail("delivered@test.mailcraft.local");
    let h = [("idempotency-key", "abc-1")];
    let (s1, h1, b1) = c
        .call("POST", "/v1/emails", Some(&k), &h, Some(body.clone()))
        .await;
    let (s2, h2, b2) = c
        .call("POST", "/v1/emails", Some(&k), &h, Some(body.clone()))
        .await;
    assert_eq!((s1, s2), (StatusCode::ACCEPTED, StatusCode::ACCEPTED));
    assert_eq!(b1["data"]["id"], b2["data"]["id"]);
    assert!(h1.get("idempotent-replay").is_none());
    assert_eq!(h2["idempotent-replay"], "true");
    assert_eq!(c.count_emails().await, 1);
    let (s3, _, b3) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&k),
            &h,
            Some(test_mail("bounced@test.mailcraft.local")),
        )
        .await;
    assert_eq!(
        (s3, code(&b3)),
        (StatusCode::CONFLICT, "idempotency_key_reused")
    );
    assert_eq!(c.count_emails().await, 1);
    // concurrent duplicates produce one send
    let tasks: Vec<_> = (0..6)
        .map(|_| {
            let (app, k, body) = (c.app.clone(), k.clone(), body.clone());
            tokio::spawn(async move {
                call_on(
                    &app,
                    "POST",
                    "/v1/emails",
                    Some(&k),
                    &[("idempotency-key", "race-1")],
                    Some(body),
                )
                .await
            })
        })
        .collect();
    for t in tasks {
        let (s, _, b) = t.await.unwrap();
        assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    }
    assert_eq!(c.count_emails().await, 2);
    // key too long
    let long = "x".repeat(300);
    let (s, ..) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[("idempotency-key", &long)],
            Some(body.clone()),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // expired claims are reusable
    sqlx::query(
        "UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = 'abc-1'",
    )
    .execute(&c.st.db)
    .await
    .unwrap();
    let (s, h, _) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[("idempotency-key", "abc-1")],
            Some(test_mail("bounced@test.mailcraft.local")),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert!(h.get("idempotent-replay").is_none());
}

// -------------------------------------------------------------- test mode

#[tokio::test]
async fn test_mode_sandbox_and_magic_addresses() {
    let c = ctx!();
    let k = c
        .key(spec("t", KeyEnv::Test, &[Scope::Send, Scope::Read]))
        .await;
    for (addr, outcome) in [
        ("delivered@test.mailcraft.local", "delivered"),
        ("bounced+x@test.mailcraft.local", "bounced"),
        ("complained@test.mailcraft.local", "complained"),
        ("suppressed@test.mailcraft.local", "suppressed"),
        ("deferred@test.mailcraft.local", "deferred"),
    ] {
        let (s, _, b) = c
            .call("POST", "/v1/emails", Some(&k), &[], Some(test_mail(addr)))
            .await;
        assert_eq!(s, StatusCode::ACCEPTED, "{b}");
        let id = b["data"]["id"].as_str().unwrap();
        let (env, dec): (String, Value) =
            sqlx::query_as("SELECT env, policy_decisions FROM emails WHERE id = $1::uuid")
                .bind(id)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!(env, "test");
        let route = dec
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["rule"] == "routing")
            .unwrap();
        assert_eq!(route["decision"], "sandbox");
        assert_eq!(route["recipients"][0]["simulate"], outcome);
    }
    // a real recipient is refused with a test key, nothing queued
    let before = c.count_emails().await;
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[],
            Some(test_mail("ceo@example.org")),
        )
        .await;
    assert_eq!(
        (s, code(&b)),
        (StatusCode::FORBIDDEN, "test_key_live_recipient")
    );
    assert_eq!(c.count_emails().await, before);
    // `from` defaults for test keys; live key needs it
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&c.admin),
            &[],
            Some(test_mail("a@example.org")),
        )
        .await;
    assert_eq!(
        (s, b["error"]["field"].as_str()),
        (StatusCode::BAD_REQUEST, Some("from"))
    );
}

#[tokio::test]
async fn validation_rejects_header_injection_and_reserved_headers() {
    let c = ctx!();
    let k = c.key(spec("t", KeyEnv::Test, &[Scope::Send])).await;
    for body in [
        json!({"to":["delivered@test.mailcraft.local"],"subject":"a\r\nBcc: x@y.com","text":"x"}),
        json!({"to":["delivered@test.mailcraft.local\r\nBcc: x@y.com"],"subject":"a","text":"x"}),
        json!({"to":["delivered@test.mailcraft.local"],"subject":"a","text":"x","headers":{"Bcc":"x@y.com"}}),
        json!({"to":["delivered@test.mailcraft.local"],"subject":"a","text":"x","headers":{"X-A":"v\nBcc: z"}}),
        json!({"to":["delivered@test.mailcraft.local"],"subject":"a"}),
        json!({"to":[],"subject":"a","text":"x"}),
        json!({"to":["delivered@test.mailcraft.local"],"subject":"a","text":"x","bogus":1}),
    ] {
        let (s, _, b) = c
            .call("POST", "/v1/emails", Some(&k), &[], Some(body.clone()))
            .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{body} -> {b}");
    }
    assert_eq!(c.count_emails().await, 0);
}

#[tokio::test]
async fn dry_run_stores_nothing() {
    let c = ctx!();
    let k = c.key(spec("t", KeyEnv::Test, &[Scope::Send])).await;
    let mut m = test_mail("delivered@test.mailcraft.local");
    m["dry_run"] = json!(true);
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[("idempotency-key", "dry")],
            Some(m),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["data"]["would_send_via"], "sandbox");
    assert_eq!(b["data"]["rendered"]["subject"], "hi");
    assert_eq!(c.count_emails().await, 0);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM idempotency_keys")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

// ------------------------------------------------------- live-mode gating

#[tokio::test]
async fn live_requires_go_live_verified_domain_allowlist_and_suppression() {
    let c = ctx!();
    let mut s = spec("live", KeyEnv::Live, &[Scope::Send, Scope::Read]);
    s.recipient_allowlist = Some(vec!["ana@example.org".into(), "@corp.io".into()]);
    let k = c.key(s).await;
    let mail =
        json!({"from":"Acme <hi@mail.acme.dev>","to":["ana@example.org"],"subject":"s","text":"t"});
    // 1. workspace not live
    let (st_, _, b) = c
        .call("POST", "/v1/emails", Some(&k), &[], Some(mail.clone()))
        .await;
    assert_eq!(
        (st_, code(&b)),
        (StatusCode::FORBIDDEN, "blocked_by_policy")
    );
    sqlx::query("UPDATE workspaces SET live_enabled = true")
        .execute(&c.st.db)
        .await
        .unwrap();
    // 2. domain unverified
    let (st_, _, b) = c
        .call("POST", "/v1/emails", Some(&k), &[], Some(mail.clone()))
        .await;
    assert_eq!(
        (st_, code(&b)),
        (StatusCode::UNPROCESSABLE_ENTITY, "domain_not_verified")
    );
    c.verify_domain("mail.acme.dev").await;
    // 3. allowlist
    let mut other = mail.clone();
    other["to"] = json!(["bob@evil.test"]);
    let (st_, _, b) = c
        .call("POST", "/v1/emails", Some(&k), &[], Some(other))
        .await;
    assert_eq!(
        (st_, code(&b)),
        (StatusCode::FORBIDDEN, "recipient_not_allowed")
    );
    // 4. suppression
    sqlx::query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,'ana@example.org','hard_bounce')").bind(c.ws).execute(&c.st.db).await.unwrap();
    let (st_, _, b) = c
        .call("POST", "/v1/emails", Some(&k), &[], Some(mail.clone()))
        .await;
    assert_eq!(
        (st_, code(&b)),
        (StatusCode::UNPROCESSABLE_ENTITY, "recipient_suppressed")
    );
    sqlx::query("DELETE FROM suppressions")
        .execute(&c.st.db)
        .await
        .unwrap();
    // 5. marketing no longer requires compliance info
    let mut m = mail.clone();
    m["stream"] = json!("marketing");
    let (st_, _, b) = c.call("POST", "/v1/emails", Some(&k), &[], Some(m)).await;
    assert_eq!(st_, StatusCode::ACCEPTED, "{b}");
    assert_eq!(b["data"]["status"], "queued");
    // 6. finally ok, queued live with the verified domain id
    let (st_, _, b) = c
        .call("POST", "/v1/emails", Some(&k), &[], Some(mail))
        .await;
    assert_eq!(st_, StatusCode::ACCEPTED, "{b}");
    assert_eq!(b["data"]["status"], "queued");
    let (env, dom, status): (String, Option<Uuid>, String) =
        sqlx::query_as("SELECT env, domain_id, status FROM emails WHERE stream = 'transactional'")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert_eq!(
        (env.as_str(), dom.is_some(), status.as_str()),
        ("live", true, "queued")
    );
}

#[tokio::test]
async fn template_and_scheduling() {
    let c = ctx!();
    let k = c
        .key(spec("t", KeyEnv::Test, &[Scope::Send, Scope::Read]))
        .await;
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[],
            Some(json!({"to":["delivered@test.mailcraft.local"],"template":{"id":"missing"}})),
        )
        .await;
    assert_eq!((s, code(&b)), (StatusCode::NOT_FOUND, "not_found"));
    let tid: Uuid = sqlx::query_scalar("INSERT INTO templates (workspace_id, alias, name) VALUES ($1,'welcome','Welcome') RETURNING id").bind(c.ws).fetch_one(&c.st.db).await.unwrap();
    let at = chrono::Utc::now() + chrono::Duration::hours(2);
    let (s, _, b) = c.call("POST", "/v1/emails", Some(&k), &[], Some(json!({"to":["delivered@test.mailcraft.local"],"template":{"id":"welcome","variables":{"n":1}},"scheduled_at":at}))).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let (t, vars, next): (Option<Uuid>, Option<Value>, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT template_id, template_vars, next_attempt_at FROM emails")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert_eq!(t, Some(tid));
    assert_eq!(vars.unwrap()["n"], 1);
    assert!((next - at).num_seconds().abs() < 2);
}

// ---------------------------------------------------- policy and approvals

#[tokio::test]
async fn needs_approval_flow_and_agents_cannot_decide() {
    let c = ctx!();
    let mut s = spec(
        "agent",
        KeyEnv::Test,
        &[Scope::Send, Scope::Read, Scope::Manage],
    );
    s.policy = Some(json!({"send":"needs_approval"}));
    let agent = c.key(s).await;
    let (st_, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&agent),
            &[],
            Some(test_mail("delivered@test.mailcraft.local")),
        )
        .await;
    assert_eq!(st_, StatusCode::ACCEPTED);
    assert_eq!(b["data"]["status"], "pending_approval");
    let ap = b["data"]["approval_id"].as_str().unwrap().to_string();
    let eid = b["data"]["id"].as_str().unwrap().to_string();
    // pending mail is not claimable by the worker
    let status: String = sqlx::query_scalar("SELECT status FROM emails WHERE id = $1::uuid")
        .bind(&eid)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(status, "pending_approval");
    // agent can read, never decide
    let (st_, _, g) = c
        .call(
            "GET",
            &format!("/v1/approvals/{ap}"),
            Some(&agent),
            &[],
            None,
        )
        .await;
    assert_eq!(
        (st_, g["data"]["status"].as_str()),
        (StatusCode::OK, Some("pending"))
    );
    assert_eq!(g["data"]["payload"]["preview"]["subject"], "hi");
    let (st_, _, b) = c
        .call(
            "POST",
            &format!("/v1/approvals/{ap}/decide"),
            Some(&agent),
            &[],
            Some(json!({"decision":"approve"})),
        )
        .await;
    assert_eq!((st_, code(&b)), (StatusCode::FORBIDDEN, "forbidden_scope"));
    // human approves
    let (st_, ..) = c
        .call(
            "POST",
            &format!("/v1/approvals/{ap}/decide"),
            Some(&c.admin),
            &[],
            Some(json!({"decision":"approve"})),
        )
        .await;
    assert_eq!(st_, StatusCode::OK);
    let status: String = sqlx::query_scalar("SELECT status FROM emails WHERE id = $1::uuid")
        .bind(&eid)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(status, "queued");
    let (st_, _, b) = c
        .call(
            "POST",
            &format!("/v1/approvals/{ap}/decide"),
            Some(&c.admin),
            &[],
            Some(json!({"decision":"reject"})),
        )
        .await;
    assert_eq!(
        (st_, code(&b)),
        (StatusCode::CONFLICT, "approval_already_decided")
    );
    // reject path cancels
    let (_, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&agent),
            &[],
            Some(test_mail("bounced@test.mailcraft.local")),
        )
        .await;
    let (ap2, e2) = (
        b["data"]["approval_id"].as_str().unwrap().to_string(),
        b["data"]["id"].as_str().unwrap().to_string(),
    );
    c.call(
        "POST",
        &format!("/v1/approvals/{ap2}/decide"),
        Some(&c.admin),
        &[],
        Some(json!({"decision":"reject"})),
    )
    .await;
    let status: String = sqlx::query_scalar("SELECT status FROM emails WHERE id = $1::uuid")
        .bind(&e2)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(status, "cancelled");
    let (_, _, l) = c
        .call(
            "GET",
            "/v1/approvals?status=pending",
            Some(&agent),
            &[],
            None,
        )
        .await;
    assert_eq!(l["data"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn blocked_policy_denies_and_is_audited() {
    let c = ctx!();
    let mut s = spec("b", KeyEnv::Test, &[Scope::Send]);
    s.policy = Some(json!({"send":"blocked"}));
    let k = c.key(s).await;
    let (st_, _, b) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[],
            Some(test_mail("delivered@test.mailcraft.local")),
        )
        .await;
    assert_eq!(
        (st_, code(&b)),
        (StatusCode::FORBIDDEN, "blocked_by_policy")
    );
    assert_eq!(c.count_emails().await, 0);
    let (_, _, a) = c.call("GET", "/v1/audit", Some(&c.admin), &[], None).await;
    assert!(a["data"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["decision"] == "blocked" && r["action"] == "email.send"));
}

#[tokio::test]
async fn go_live_request_flow() {
    let c = ctx!();
    let agent = c
        .key(spec("a", KeyEnv::Test, &[Scope::Manage, Scope::Read]))
        .await;
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/go-live-requests",
            Some(&agent),
            &[],
            Some(json!({"note":"ready"})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let ap = b["data"]["approval_id"].as_str().unwrap();
    assert_eq!(
        c.call(
            "POST",
            &format!("/v1/approvals/{ap}/decide"),
            Some(&agent),
            &[],
            Some(json!({"decision":"approve"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    c.call(
        "POST",
        &format!("/v1/approvals/{ap}/decide"),
        Some(&c.admin),
        &[],
        Some(json!({"decision":"approve"})),
    )
    .await;
    let live: bool = sqlx::query_scalar("SELECT live_enabled FROM workspaces")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert!(live);
}

#[tokio::test]
async fn policy_proposal_needs_human_approval() {
    let c = ctx!();
    let agent = c.key(spec("a", KeyEnv::Test, &[Scope::Manage])).await;
    let (_, _, k) = c
        .call(
            "POST",
            "/v1/keys",
            Some(&c.admin),
            &[],
            Some(json!({"name":"t","env":"test","scopes":["send"]})),
        )
        .await;
    let kid = k["data"]["id"].as_str().unwrap();
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/policy/proposals",
            Some(&agent),
            &[],
            Some(json!({"key_id": kid, "policy": {"send":"blocked"}})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let pol: Value = sqlx::query_scalar("SELECT policy FROM api_keys WHERE id = $1::uuid")
        .bind(kid)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(pol, json!({}), "a proposal changes nothing by itself");
    let ap = b["data"]["approval_id"].as_str().unwrap();
    c.call(
        "POST",
        &format!("/v1/approvals/{ap}/decide"),
        Some(&c.admin),
        &[],
        Some(json!({"decision":"approve"})),
    )
    .await;
    let pol: Value = sqlx::query_scalar("SELECT policy FROM api_keys WHERE id = $1::uuid")
        .bind(kid)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(pol, json!({"send":"blocked"}));
}

// ------------------------------------------------------------ kill switch

#[tokio::test]
async fn kill_switch_global_and_per_key() {
    let c = ctx!();
    let agent = c
        .key(spec(
            "a",
            KeyEnv::Test,
            &[Scope::Send, Scope::Manage, Scope::Read],
        ))
        .await;
    let other = c.key(spec("o", KeyEnv::Test, &[Scope::Send])).await;
    let mail = test_mail("delivered@test.mailcraft.local");
    // an agent may engage the global switch...
    let (s, ..) = c
        .call(
            "POST",
            "/v1/kill-switch",
            Some(&agent),
            &[],
            Some(json!({"on": true})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, b) = c
        .call("POST", "/v1/emails", Some(&other), &[], Some(mail.clone()))
        .await;
    assert_eq!((s, code(&b)), (StatusCode::FORBIDDEN, "kill_switch_active"));
    // ...but not disengage it
    let (s, ..) = c
        .call(
            "POST",
            "/v1/kill-switch",
            Some(&agent),
            &[],
            Some(json!({"on": false})),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, ..) = c
        .call(
            "POST",
            "/v1/kill-switch",
            Some(&c.admin),
            &[],
            Some(json!({"on": false})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        c.call("POST", "/v1/emails", Some(&other), &[], Some(mail.clone()))
            .await
            .0,
        StatusCode::ACCEPTED
    );
    // per key
    let oid: Uuid = sqlx::query_scalar("SELECT id FROM api_keys WHERE name = 'o'")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    c.call(
        "POST",
        "/v1/kill-switch",
        Some(&agent),
        &[],
        Some(json!({"on": true, "key_id": oid})),
    )
    .await;
    let (s, _, b) = c
        .call("POST", "/v1/emails", Some(&other), &[], Some(mail.clone()))
        .await;
    assert_eq!((s, code(&b)), (StatusCode::FORBIDDEN, "kill_switch_active"));
    assert_eq!(
        c.call("POST", "/v1/emails", Some(&agent), &[], Some(mail.clone()))
            .await
            .0,
        StatusCode::ACCEPTED,
        "other keys unaffected"
    );
    let (_, _, st_) = c
        .call("GET", "/v1/kill-switch", Some(&agent), &[], None)
        .await;
    assert_eq!(st_["data"]["paused_keys"][0], oid.to_string());
    c.call(
        "POST",
        "/v1/kill-switch",
        Some(&c.admin),
        &[],
        Some(json!({"on": false, "key_id": oid})),
    )
    .await;
    assert_eq!(
        c.call("POST", "/v1/emails", Some(&other), &[], Some(mail))
            .await
            .0,
        StatusCode::ACCEPTED
    );
}

// -------------------------------------------------------------------- caps

#[tokio::test]
async fn daily_cap_uses_redis_and_survives_a_redis_flush() {
    let c = ctx!();
    if c.st.redis.is_none() {
        eprintln!("SKIP: redis unavailable");
        return;
    }
    let mut s = spec("capped", KeyEnv::Test, &[Scope::Send]);
    s.daily_send_cap = Some(3);
    let k = c.key(s).await;
    let two = json!({"to":["delivered@test.mailcraft.local","bounced@test.mailcraft.local"],"subject":"s","text":"t"});
    assert_eq!(
        c.call("POST", "/v1/emails", Some(&k), &[], Some(two.clone()))
            .await
            .0,
        StatusCode::ACCEPTED
    );
    // Redis loses its counters: Postgres is consulted before the fresh counter is trusted.
    let mut r = redis::Client::open(c.redis_url.clone())
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap();
    // Only this key's counters: FLUSHDB would reset other tests' rate limits in the shared Redis.
    let id: Uuid = sqlx::query_scalar("SELECT id FROM api_keys WHERE name = 'capped'")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    let keys: Vec<String> = redis::cmd("KEYS")
        .arg(format!("cap:{id}:*"))
        .query_async(&mut r)
        .await
        .unwrap();
    for k in keys {
        let _: () = redis::cmd("DEL").arg(k).query_async(&mut r).await.unwrap();
    }
    let (s, h, b) = c.call("POST", "/v1/emails", Some(&k), &[], Some(two)).await;
    assert_eq!(
        (s, code(&b)),
        (StatusCode::TOO_MANY_REQUESTS, "send_cap_exceeded"),
        "{b}"
    );
    assert!(!b["error"]["retryable"].as_bool().unwrap());
    let _ = h;
    assert_eq!(c.count_emails().await, 2, "rejected request queued nothing");
    // one more recipient still fits (2 of 3 used)
    assert_eq!(
        c.call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[],
            Some(test_mail("delivered@test.mailcraft.local"))
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let (s, ..) = c
        .call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[],
            Some(test_mail("delivered@test.mailcraft.local")),
        )
        .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn caps_fall_back_to_postgres_without_redis() {
    let Some(mut c) = setup().await else { return };
    c.st.redis = None;
    c.app = router(c.st.clone());
    let mut s = spec("m", KeyEnv::Test, &[Scope::Send]);
    s.minute_send_cap = Some(2);
    let k = c.key(s).await;
    let m = test_mail("delivered@test.mailcraft.local");
    for _ in 0..2 {
        assert_eq!(
            c.call("POST", "/v1/emails", Some(&k), &[], Some(m.clone()))
                .await
                .0,
            StatusCode::ACCEPTED
        );
    }
    let (s, h, b) = c.call("POST", "/v1/emails", Some(&k), &[], Some(m)).await;
    assert_eq!(
        (s, code(&b)),
        (StatusCode::TOO_MANY_REQUESTS, "send_cap_exceeded")
    );
    assert!(
        b["error"]["retryable"].as_bool().unwrap(),
        "minute caps are retryable"
    );
    assert_eq!(h["retry-after"], "60");
}

#[tokio::test]
async fn api_rate_limit() {
    let Some(c) = setup_with(|c| c.rate_limit_per_min = 3).await else {
        return;
    };
    if c.st.redis.is_none() {
        return;
    }
    let k = c.key(spec("r", KeyEnv::Test, &[Scope::Read])).await;
    let mut seen = Vec::new();
    for _ in 0..5 {
        seen.push(c.call("GET", "/v1/emails", Some(&k), &[], None).await.0);
    }
    assert_eq!(&seen[..3], &[StatusCode::OK; 3]);
    assert_eq!(seen[4], StatusCode::TOO_MANY_REQUESTS);
}

// ------------------------------------------------------------------- batch

#[tokio::test]
async fn batch_is_index_aligned_with_per_item_errors() {
    let c = ctx!();
    let k = c.key(spec("t", KeyEnv::Test, &[Scope::Send])).await;
    let body = json!({"emails":[
        test_mail("delivered@test.mailcraft.local"),
        test_mail("real@example.org"),
        {"to":["bounced@test.mailcraft.local"],"subject":"x"},
        test_mail("complained@test.mailcraft.local"),
    ]});
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/emails/batch",
            Some(&k),
            &[("idempotency-key", "b1")],
            Some(body.clone()),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let d = b["data"].as_array().unwrap();
    assert_eq!(d.len(), 4);
    assert_eq!(d[0]["ok"], true);
    assert_eq!(d[1]["error"]["code"], "test_key_live_recipient");
    assert_eq!(d[2]["error"]["code"], "invalid_request");
    assert_eq!(d[3]["ok"], true);
    assert_eq!(c.count_emails().await, 2);
    let (s, h, _) = c
        .call(
            "POST",
            "/v1/emails/batch",
            Some(&k),
            &[("idempotency-key", "b1")],
            Some(body),
        )
        .await;
    assert_eq!(
        (s, h["idempotent-replay"].to_str().unwrap()),
        (StatusCode::ACCEPTED, "true")
    );
    assert_eq!(c.count_emails().await, 2);
    let (s, ..) = c
        .call(
            "POST",
            "/v1/emails/batch",
            Some(&k),
            &[],
            Some(json!({"emails": []})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn email_get_list_cancel_events() {
    let c = ctx!();
    let k = c
        .key(spec("t", KeyEnv::Test, &[Scope::Send, Scope::Read]))
        .await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        let (_, _, b) = c
            .call(
                "POST",
                "/v1/emails",
                Some(&k),
                &[],
                Some(test_mail("delivered@test.mailcraft.local")),
            )
            .await;
        ids.push(b["data"]["id"].as_str().unwrap().to_string());
    }
    let (_, _, p1) = c
        .call("GET", "/v1/emails?limit=2", Some(&k), &[], None)
        .await;
    assert_eq!(p1["data"].as_array().unwrap().len(), 2);
    let cur = p1["next_cursor"].as_str().unwrap();
    let (_, _, p2) = c
        .call(
            "GET",
            &format!("/v1/emails?limit=2&cursor={cur}"),
            Some(&k),
            &[],
            None,
        )
        .await;
    assert_eq!(p2["data"].as_array().unwrap().len(), 1);
    assert!(p2["next_cursor"].is_null());
    assert_eq!(p2["data"][0]["id"], ids[0]);
    let (s, _, g) = c
        .call(
            "GET",
            &format!("/v1/emails/{}", ids[0]),
            Some(&k),
            &[],
            None,
        )
        .await;
    assert_eq!(
        (s, g["data"]["status"].as_str()),
        (StatusCode::OK, Some("queued"))
    );
    assert_eq!(
        c.call(
            "POST",
            &format!("/v1/emails/{}/cancel", ids[0]),
            Some(&k),
            &[],
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        c.call(
            "POST",
            &format!("/v1/emails/{}/cancel", ids[0]),
            Some(&k),
            &[],
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        c.call(
            "GET",
            &format!("/v1/emails/{}/events", ids[0]),
            Some(&k),
            &[],
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        c.call(
            "GET",
            &format!("/v1/emails/{}", Uuid::new_v4()),
            Some(&k),
            &[],
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    // another workspace cannot see it
    let ws2: Uuid =
        sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ('other') RETURNING id")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    let mut conn = c.st.db.acquire().await.unwrap();
    let (_, tok2) = insert_key(&mut conn, ws2, &spec("x", KeyEnv::Test, &[Scope::Read]))
        .await
        .unwrap();
    assert_eq!(
        c.call(
            "GET",
            &format!("/v1/emails/{}", ids[1]),
            Some(&tok2),
            &[],
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

// ------------------------------------------------------------- audit chain

#[tokio::test]
async fn audit_chain_verifies_and_detects_tampering() {
    let c = ctx!();
    let k = c
        .key(spec("t", KeyEnv::Test, &[Scope::Send, Scope::Manage]))
        .await;
    for _ in 0..3 {
        c.call(
            "POST",
            "/v1/emails",
            Some(&k),
            &[],
            Some(test_mail("delivered@test.mailcraft.local")),
        )
        .await;
    }
    c.call(
        "POST",
        "/v1/kill-switch",
        Some(&k),
        &[],
        Some(json!({"on": true})),
    )
    .await;
    c.call(
        "POST",
        "/v1/kill-switch",
        Some(&c.admin),
        &[],
        Some(json!({"on": false})),
    )
    .await;
    let (s, _, v) = c
        .call("GET", "/v1/audit/verify", Some(&c.admin), &[], None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["data"]["ok"], true);
    assert!(v["data"]["checked"].as_u64().unwrap() >= 5);
    // the app role cannot rewrite history
    let e = sqlx::query("UPDATE audit_log SET action = 'x'")
        .execute(&c.st.db)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("append-only"), "{e}");
    assert!(sqlx::query("DELETE FROM audit_log")
        .execute(&c.st.db)
        .await
        .is_err());
    assert!(sqlx::query("TRUNCATE audit_log")
        .execute(&c.st.db)
        .await
        .is_err());
    // a superuser bypassing the trigger is still caught by the chain
    let mut tx = c.st.db.begin().await.unwrap();
    tx.execute("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update")
        .await
        .unwrap();
    tx.execute("UPDATE audit_log SET decision = 'auto' WHERE id = (SELECT id FROM audit_log ORDER BY id OFFSET 2 LIMIT 1)").await.unwrap();
    tx.execute("UPDATE audit_log SET args = '{\"forged\":true}' WHERE id = (SELECT id FROM audit_log ORDER BY id OFFSET 3 LIMIT 1)").await.unwrap();
    tx.execute("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (_, _, v) = c
        .call("GET", "/v1/audit/verify", Some(&c.admin), &[], None)
        .await;
    assert_eq!(v["data"]["ok"], false);
    let bad: i64 = v["data"]["first_bad_id"].as_i64().unwrap();
    let expect: i64 = sqlx::query_scalar("SELECT id FROM audit_log ORDER BY id OFFSET 3 LIMIT 1")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(bad, expect);
    let rep = audit::verify(&c.st.db, c.ws).await.unwrap();
    assert!(!rep.ok);
    // non-admin cannot run verify
    assert_eq!(
        c.call("GET", "/v1/audit/verify", Some(&k), &[], None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn audit_redacts_secrets_and_serialises_concurrent_writers() {
    let c = ctx!();
    let futs = (0..8).map(|i| {
        let st = c.st.clone();
        let ws = c.ws;
        async move {
            audit::append_standalone(
                &st.db,
                ws,
                audit::Actor::System,
                audit::Entry {
                    action: "t",
                    args: json!({"i": i, "api_key": "mc_live_SECRET", "nested": {"password": "p"}}),
                    decision: "auto",
                    approval_id: None,
                },
            )
            .await
            .unwrap();
        }
    });
    let hs: Vec<_> = futs.map(tokio::spawn).collect();
    for h in hs {
        h.await.unwrap();
    }
    let rep = audit::verify(&c.st.db, c.ws).await.unwrap();
    assert!(rep.ok && rep.checked == 8, "{rep:?}");
    let all: Vec<Value> = sqlx::query_scalar("SELECT args FROM audit_log")
        .fetch_all(&c.st.db)
        .await
        .unwrap();
    let s = serde_json::to_string(&all).unwrap();
    assert!(!s.contains("mc_live_SECRET") && !s.contains("\"p\""));
}

// ---------------------------------------------------------------- webhooks

/// Tiny HTTP receiver: records each request, answers with `statuses` in order (last repeats).
async fn receiver(
    statuses: Vec<u16>,
) -> (
    String,
    Arc<tokio::sync::Mutex<Vec<(HashMap<String, String>, String)>>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", l.local_addr().unwrap());
    let seen = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let s2 = seen.clone();
    tokio::spawn(async move {
        let mut n = 0;
        loop {
            let (mut sock, _) = l.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let (head, body) = loop {
                let k = sock.read(&mut tmp).await.unwrap();
                if k == 0 {
                    break (String::new(), String::new());
                }
                buf.extend_from_slice(&tmp[..k]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((h, b)) = text.split_once("\r\n\r\n") {
                    let cl: usize = h
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if b.len() >= cl {
                        break (h.to_string(), b.to_string());
                    }
                }
            };
            let headers = head
                .lines()
                .skip(1)
                .filter_map(|l| l.split_once(": "))
                .map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))
                .collect();
            s2.lock().await.push((headers, body));
            let st = statuses.get(n).or(statuses.last()).copied().unwrap_or(200);
            n += 1;
            let _ = sock
                .write_all(
                    format!("HTTP/1.1 {st} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await;
        }
    });
    (url, seen)
}

#[tokio::test]
async fn webhook_endpoint_secret_ssrf_and_signed_delivery() {
    let c = ctx!();
    let (url, seen) = receiver(vec![200]).await;
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/webhooks",
            Some(&c.admin),
            &[],
            Some(json!({"url": url, "events": ["test.*", "email.*"]})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{b}");
    let secret = b["data"]["secret"].as_str().unwrap().to_string();
    let id = b["data"]["id"].as_str().unwrap().to_string();
    assert!(secret.starts_with("whsec_"));
    // encrypted at rest, never listed again
    let enc: Vec<u8> =
        sqlx::query_scalar("SELECT secret_enc FROM webhook_endpoints WHERE id = $1::uuid")
            .bind(&id)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert!(!String::from_utf8_lossy(&enc).contains(&secret[6..]));
    let (_, _, l) = c
        .call("GET", "/v1/webhooks", Some(&c.admin), &[], None)
        .await;
    assert!(!l.to_string().contains(&secret));
    // deliver a test ping
    let (s, ..) = c
        .call(
            "POST",
            &format!("/v1/webhooks/{id}/test"),
            Some(&c.admin),
            &[],
            None,
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(webhooks::deliver_due(&c.st, 10).await.unwrap(), 1);
    let got = seen.lock().await;
    assert_eq!(got.len(), 1);
    let (h, body) = &got[0];
    let (wid, ts, sig) = (
        &h["webhook-id"],
        h["webhook-timestamp"].parse::<i64>().unwrap(),
        &h["webhook-signature"],
    );
    assert!(webhook::verify(
        &secret,
        wid,
        ts,
        body,
        sig,
        chrono::Utc::now().timestamp()
    ));
    assert!(!webhook::verify(
        &secret,
        wid,
        ts,
        &format!("{body} "),
        sig,
        chrono::Utc::now().timestamp()
    ));
    assert_eq!((&h["svix-id"], &h["svix-signature"]), (wid, sig));
    let ev: Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        (ev["type"].as_str(), ev["id"].as_str()),
        (Some("test.ping"), Some(wid.as_str()))
    );
    let st: String = sqlx::query_scalar("SELECT status FROM webhook_deliveries")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(st, "delivered");
    drop(got);
    // events filter: a kill-switch event does not match test.*/email.*
    c.call(
        "POST",
        "/v1/kill-switch",
        Some(&c.admin),
        &[],
        Some(json!({"on": true})),
    )
    .await;
    c.call(
        "POST",
        "/v1/kill-switch",
        Some(&c.admin),
        &[],
        Some(json!({"on": false})),
    )
    .await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM webhook_deliveries")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn webhook_url_ssrf_guard_and_validation() {
    let Some(c) = setup_with(|c| c.allow_private_webhooks = false).await else {
        return;
    };
    for url in [
        "http://example.com/h",
        "https://127.0.0.1/h",
        "https://localhost/h",
        "https://169.254.169.254/latest",
        "https://10.1.2.3/h",
        "https://u:p@example.com/h",
        "ftp://example.com/h",
        "not a url",
    ] {
        let (s, _, b) = c
            .call(
                "POST",
                "/v1/webhooks",
                Some(&c.admin),
                &[],
                Some(json!({"url": url})),
            )
            .await;
        assert_eq!(
            (s, b["error"]["field"].as_str()),
            (StatusCode::BAD_REQUEST, Some("url")),
            "{url}"
        );
    }
    let (s, ..) = c
        .call(
            "POST",
            "/v1/webhooks",
            Some(&c.admin),
            &[],
            Some(json!({"url":"https://example.com/h","events":["bogus.thing"]})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, ..) = c
        .call(
            "POST",
            "/v1/webhooks",
            Some(&c.admin),
            &[],
            Some(json!({"url":"https://example.com/h"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    // DNS-time guard: an allowed-looking host that resolves to loopback is refused at delivery
    let id: Uuid = sqlx::query_scalar("SELECT id FROM webhook_endpoints")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    sqlx::query("UPDATE webhook_endpoints SET url = 'https://localtest.me/h'")
        .execute(&c.st.db)
        .await
        .unwrap();
    c.call(
        "POST",
        &format!("/v1/webhooks/{id}/test"),
        Some(&c.admin),
        &[],
        None,
    )
    .await;
    webhooks::deliver_due(&c.st, 10).await.unwrap();
    let (att, st): (i32, String) =
        sqlx::query_as("SELECT attempts, status FROM webhook_deliveries")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert_eq!(
        (att, st.as_str()),
        (1, "pending"),
        "refused and scheduled for retry, never sent"
    );
}

#[tokio::test]
async fn webhook_retry_schedule_final_4xx_and_auto_disable() {
    let c = ctx!();
    let (url, seen) = receiver(vec![503, 400, 500]).await;
    let (_, _, b) = c
        .call(
            "POST",
            "/v1/webhooks",
            Some(&c.admin),
            &[],
            Some(json!({"url": url})),
        )
        .await;
    let id = b["data"]["id"].as_str().unwrap().to_string();
    // 503 -> retried in ~5 s
    c.call(
        "POST",
        &format!("/v1/webhooks/{id}/test"),
        Some(&c.admin),
        &[],
        None,
    )
    .await;
    webhooks::deliver_due(&c.st, 10).await.unwrap();
    let (att, st, code_, secs): (i32, String, Option<i32>, f64) = sqlx::query_as("SELECT attempts, status, last_status_code, extract(epoch from next_attempt_at - now())::float8 FROM webhook_deliveries").fetch_one(&c.st.db).await.unwrap();
    assert_eq!((att, st.as_str(), code_), (1, "pending", Some(503)));
    assert!(
        (3.0..6.0).contains(&secs),
        "first retry ~5s +/-10%, got {secs}"
    );
    assert_eq!(
        webhooks::deliver_due(&c.st, 10).await.unwrap(),
        0,
        "not due yet"
    );
    // make it due; 400 is final
    sqlx::query("UPDATE webhook_deliveries SET next_attempt_at = now()")
        .execute(&c.st.db)
        .await
        .unwrap();
    webhooks::deliver_due(&c.st, 10).await.unwrap();
    let (att, st): (i32, String) =
        sqlx::query_as("SELECT attempts, status FROM webhook_deliveries")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert_eq!((att, st.as_str()), (2, "failed"));
    assert_eq!(seen.lock().await.len(), 2);
    // exhausting 8 attempts x 5 deliveries disables the endpoint (receiver now always 500)
    for _ in 0..5 {
        c.call(
            "POST",
            &format!("/v1/webhooks/{id}/test"),
            Some(&c.admin),
            &[],
            None,
        )
        .await;
        let did: Uuid =
            sqlx::query_scalar("SELECT id FROM webhook_deliveries WHERE status = 'pending'")
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        for _ in 0..8 {
            sqlx::query("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1")
                .bind(did)
                .execute(&c.st.db)
                .await
                .unwrap();
            webhooks::deliver_due(&c.st, 10).await.unwrap();
        }
        let (att, st): (i32, String) =
            sqlx::query_as("SELECT attempts, status FROM webhook_deliveries WHERE id = $1")
                .bind(did)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!((att, st.as_str()), (8, "failed"));
    }
    let est: String = sqlx::query_scalar("SELECT status FROM webhook_endpoints")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(est, "disabled");
    // replay re-queues
    let did: Uuid = sqlx::query_scalar("SELECT id FROM webhook_deliveries LIMIT 1")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(
        c.call(
            "POST",
            &format!("/v1/webhook-deliveries/{did}/replay"),
            Some(&c.admin),
            &[],
            None
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
}

#[tokio::test]
async fn approval_requested_event_reaches_webhook() {
    let c = ctx!();
    let (url, seen) = receiver(vec![200]).await;
    c.call(
        "POST",
        "/v1/webhooks",
        Some(&c.admin),
        &[],
        Some(json!({"url": url, "events": ["approval.*"]})),
    )
    .await;
    let mut s = spec("agent", KeyEnv::Test, &[Scope::Send]);
    s.policy = Some(json!({"send":"needs_approval"}));
    let agent = c.key(s).await;
    c.call(
        "POST",
        "/v1/emails",
        Some(&agent),
        &[],
        Some(test_mail("delivered@test.mailcraft.local")),
    )
    .await;
    webhooks::deliver_due(&c.st, 10).await.unwrap();
    let got = seen.lock().await;
    assert_eq!(got.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&got[0].1).unwrap()["type"],
        "approval.requested"
    );
}

// ------------------------------------------------------- service wiring

struct MockDomains;
#[async_trait::async_trait]
impl DomainService for MockDomains {
    async fn add(&self, _: Uuid, r: AddDomain) -> mailcraft_core::Result<DomainView> {
        Ok(DomainView {
            id: Uuid::nil(),
            name: r.domain,
            stream: "transactional".into(),
            status: "not_started".into(),
            last_checked_at: None,
            records: vec![],
        })
    }
    async fn list(&self, _: Uuid) -> mailcraft_core::Result<Vec<DomainView>> {
        Ok(vec![])
    }
    async fn get(&self, _: Uuid, _: Uuid) -> mailcraft_core::Result<DomainView> {
        Err(mailcraft_core::Error::new("not_found", 404, "no"))
    }
    async fn verify(&self, _: Uuid, _: Uuid) -> mailcraft_core::Result<DomainView> {
        Err(mailcraft_core::Error::new("not_found", 404, "no"))
    }
    async fn rotate_dkim(&self, _: Uuid, _: Uuid) -> mailcraft_core::Result<DomainView> {
        Err(mailcraft_core::Error::new("not_found", 404, "no"))
    }
    async fn delete(&self, _: Uuid, _: Uuid) -> mailcraft_core::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn stub_services_answer_501_and_real_ones_plug_in() {
    let Some(mut c) = setup().await else { return };
    let mgr = c
        .key(spec(
            "m",
            KeyEnv::Test,
            &[Scope::Manage, Scope::Read, Scope::Send],
        ))
        .await;
    for (m, p, body) in [
        (
            "POST",
            "/v1/domains",
            Some(json!({"domain":"a.example.com"})),
        ),
        ("GET", "/v1/domains", None),
        ("PUT", "/v1/contacts", Some(json!({"email":"a@b.co"}))),
        ("GET", "/v1/contacts", None),
        ("POST", "/v1/segments", Some(json!({"name":"s"}))),
        (
            "POST",
            "/v1/events",
            Some(json!({"name":"e","contact":{"email":"a@b.co"}})),
        ),
    ] {
        let (s, _, b) = c.call(m, p, Some(&mgr), &[], body).await;
        assert_eq!(
            (s, code(&b)),
            (StatusCode::NOT_IMPLEMENTED, "not_implemented"),
            "{m} {p}"
        );
        assert!(b["error"]["hint"].is_string());
    }
    // scopes still apply before the service is reached
    let ro = c.key(spec("ro", KeyEnv::Test, &[Scope::Read])).await;
    assert_eq!(
        c.call(
            "POST",
            "/v1/domains",
            Some(&ro),
            &[],
            Some(json!({"domain":"a.example.com"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    c.st.domains = Arc::new(MockDomains);
    c.app = router(c.st.clone());
    let (s, _, b) = c
        .call(
            "POST",
            "/v1/domains",
            Some(&mgr),
            &[],
            Some(json!({"domain":"a.example.com"})),
        )
        .await;
    assert_eq!(
        (s, b["data"]["name"].as_str()),
        (StatusCode::CREATED, Some("a.example.com"))
    );
    let (s, _, b) = c
        .call(
            "GET",
            &format!("/v1/domains/{}", Uuid::nil()),
            Some(&mgr),
            &[],
            None,
        )
        .await;
    assert_eq!((s, code(&b)), (StatusCode::NOT_FOUND, "not_found"));
}

#[tokio::test]
async fn deciding_an_automation_first_send_releases_or_cancels_the_gated_email() {
    let c = ctx!();
    for (decision, want_email, want_approval) in [
        ("approve", "queued", "approved"),
        ("reject", "cancelled", "rejected"),
    ] {
        let eid: Uuid = sqlx::query_scalar(
            "INSERT INTO emails (workspace_id, stream, source, from_addr, to_addr, subject, status)
             VALUES ($1,'transactional','automation','a@x.com','b@x.com','s','pending_approval') RETURNING id",
        )
        .bind(c.ws)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        let ap: Uuid = sqlx::query_scalar(
            "INSERT INTO approvals (workspace_id, kind, subject_id, payload) VALUES ($1,'automation_first_send',$2,'{}') RETURNING id",
        )
        .bind(c.ws)
        .bind(eid)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        let (st_, _, b) = c
            .call(
                "POST",
                &format!("/v1/approvals/{ap}/decide"),
                Some(&c.admin),
                &[],
                Some(json!({"decision": decision})),
            )
            .await;
        assert_eq!(
            (st_, b["data"]["status"].as_str()),
            (StatusCode::OK, Some(want_approval))
        );
        let status: String = sqlx::query_scalar("SELECT status FROM emails WHERE id = $1")
            .bind(eid)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        assert_eq!(status, want_email, "{decision}");
    }
}
