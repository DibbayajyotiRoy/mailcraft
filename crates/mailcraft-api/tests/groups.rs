//! Route-group integration tests (setup, unsubscribe, transports, templates, automations, admin,
//! domains + contacts/segments/events services). Real Postgres (55441) and Redis (56391) by default;
//! MAILCRAFT_TEST_PG / MAILCRAFT_TEST_REDIS override. Skips when Postgres is unreachable unless
//! MAILCRAFT_REQUIRE_DB=1.
use std::sync::Arc;

use axum::{body::Body, http::Request, routing::post, Json, Router};
use http_body_util::BodyExt;
use mailcraft_api::{
    keys::{insert_key, CreateKey},
    router, AppState, Config,
};
use mailcraft_automations::NoopPersonalizer;
use mailcraft_core::auth::{KeyEnv, Scope};
use mailcraft_deliverability::unsubscribe::{self, Category, UnsubToken};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use tower::ServiceExt;
use uuid::Uuid;

const KEY: &str = "0909090909090909090909090909090909090909090909090909090909090909";

struct Ctx {
    app: Router,
    st: AppState,
    ws: Uuid,
    admin: String,
}

fn pg_url() -> String {
    std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55441/postgres".into())
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
    let name = format!("mc_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let url = pg_url();
    let db = PgPool::connect(&format!("{}/{name}", url.rsplit_once('/').unwrap().0))
        .await
        .unwrap();
    sqlx::migrate!("../../migrations").run(&db).await.unwrap();
    Some(db)
}

async fn state(db: PgPool, cfg: impl FnOnce(&mut Config)) -> AppState {
    let url =
        std::env::var("MAILCRAFT_TEST_REDIS").unwrap_or_else(|_| "redis://127.0.0.1:56391".into());
    let redis = match redis::Client::open(url) {
        Ok(c) => c.get_connection_manager().await.ok(),
        Err(_) => None,
    };
    let mut config = Config::from_env();
    config.unsub_secret = b"test-unsub-secret".to_vec();
    cfg(&mut config);
    AppState::with_services(db, redis, KEY, config, Arc::new(NoopPersonalizer)).unwrap()
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

async fn setup_with(cfg: impl FnOnce(&mut Config)) -> Option<Ctx> {
    let db = fresh_db().await?;
    let ws: Uuid = sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ('t') RETURNING id")
        .fetch_one(&db)
        .await
        .unwrap();
    let st = state(db.clone(), cfg).await;
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
    })
}

macro_rules! ctx {
    () => {
        match setup_with(|_| {}).await {
            Some(c) => c,
            None => return,
        }
    };
}

async fn raw(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    ctype: &str,
    body: Option<String>,
) -> (u16, String) {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    let req = match body {
        Some(v) => b.header("content-type", ctype).body(Body::from(v)).unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let s = res.status().as_u16();
    (
        s,
        String::from_utf8_lossy(&res.into_body().collect().await.unwrap().to_bytes()).into_owned(),
    )
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let (s, t) = raw(
        app,
        method,
        path,
        token,
        "application/json",
        body.map(|v| v.to_string()),
    )
    .await;
    (s, serde_json::from_str(&t).unwrap_or(Value::Null))
}

impl Ctx {
    async fn c(&self, m: &str, p: &str, b: Option<Value>) -> (u16, Value) {
        call(&self.app, m, p, Some(&self.admin), b).await
    }
    async fn key(&self, scopes: &[Scope]) -> String {
        let mut c = self.st.db.acquire().await.unwrap();
        insert_key(&mut c, self.ws, &spec("k", KeyEnv::Live, scopes))
            .await
            .unwrap()
            .1
    }
}

fn code(b: &Value) -> &str {
    b["error"]["code"].as_str().unwrap_or("")
}

// ------------------------------------------------------------------- setup

#[tokio::test]
async fn setup_runs_once_and_status_shape() {
    let Some(db) = fresh_db().await else { return };
    let app = router(state(db, |_| {}).await);
    let (s, b) = call(
        &app,
        "POST",
        "/v1/setup",
        None,
        Some(json!({"admin_email": "me@example.com", "x": 1})),
    )
    .await;
    assert_eq!(
        (s, code(&b)),
        (400, "invalid_request"),
        "unknown fields rejected"
    );
    let (s, b) = call(
        &app,
        "POST",
        "/v1/setup",
        None,
        Some(json!({"admin_email": "me@example.com"})),
    )
    .await;
    assert_eq!(s, 201, "{b}");
    let (admin, test) = (
        b["data"]["admin_key"].as_str().unwrap(),
        b["data"]["test_key"].as_str().unwrap(),
    );
    assert!(admin.starts_with("mc_live_") && test.starts_with("mc_test_"));
    let (s, b) = call(&app, "POST", "/v1/setup", None, Some(json!({}))).await;
    assert_eq!((s, code(&b)), (409, "invalid_state"));
    let (s, b) = call(&app, "GET", "/v1/account/status", Some(test), None).await;
    assert_eq!(s, 200);
    let d = &b["data"];
    assert_eq!(
        (
            d["env"].as_str(),
            d["delivery_path"]["kind"].as_str(),
            d["verified"].as_bool()
        ),
        (Some("test"), Some("sandbox"), Some(false))
    );
    assert_eq!(d["key_prefix"].as_str().unwrap().len(), 12);
    assert!(d["limits"].is_object() && d["kill_switch"] == false && d["pending_approvals"] == 0);
    // the shown admin key works
    assert_eq!(
        call(&app, "GET", "/v1/keys", Some(admin), None).await.0,
        200
    );
}

// ------------------------------------------------------------- unsubscribe

#[tokio::test]
async fn one_click_unsubscribe() {
    let c = ctx!();
    let (_, b) = c
        .c(
            "PUT",
            "/v1/contacts",
            Some(json!({"email": "Ann@Example.com"})),
        )
        .await;
    let cid = b["data"]["id"].as_str().unwrap().to_string();
    let tok = unsubscribe::issue(
        b"test-unsub-secret",
        &UnsubToken {
            tenant: c.ws.simple().to_string(),
            contact: cid.clone(),
            category: Category::Product,
            exp: chrono::Utc::now().timestamp() as u64 + 3600,
        },
    )
    .unwrap();
    let optout = || async {
        sqlx::query_scalar::<_, Option<bool>>("SELECT bool_or(NOT opted_in) FROM contact_topics ct JOIN topics t ON t.id = ct.topic_id WHERE ct.contact_id = $1::uuid AND t.key = 'product'")
            .bind(&cid)
            .fetch_one(&c.st.db)
            .await
            .unwrap()
    };
    let (s, html) = raw(&c.app, "GET", &format!("/u/{tok}"), None, "", None).await;
    assert!(s == 200 && html.contains("<form"));
    assert_eq!(optout().await, None, "GET must not unsubscribe");
    let form = "application/x-www-form-urlencoded";
    assert_eq!(
        raw(
            &c.app,
            "POST",
            &format!("/u/{tok}"),
            None,
            form,
            Some("nothing".into())
        )
        .await
        .0,
        400
    );
    let (s, _) = raw(
        &c.app,
        "POST",
        &format!("/u/{tok}"),
        None,
        form,
        Some("List-Unsubscribe=One-Click".into()),
    )
    .await;
    assert_eq!(s, 200, "no redirect");
    assert_eq!(optout().await, Some(true));
    assert_eq!(
        raw(
            &c.app,
            "POST",
            &format!("/u/{tok}"),
            None,
            form,
            Some("List-Unsubscribe=One-Click".into())
        )
        .await
        .0,
        200,
        "idempotent"
    );
    assert_eq!(
        raw(
            &c.app,
            "POST",
            "/u/garbage",
            None,
            form,
            Some("List-Unsubscribe=One-Click".into())
        )
        .await
        .0,
        400
    );
}

// -------------------------------------------------------------- transports

#[tokio::test]
async fn transports_crud_and_test() {
    let c = ctx!();
    let (s, b) = call(&c.app, "GET", "/v1/transports", None, None).await;
    assert_eq!((s, code(&b)), (401, "unauthenticated"));
    let ro = c.key(&[Scope::Read]).await;
    let body = json!({"kind": "smtp-relay", "preset": "postmark", "config": {"username": "tok", "password": "s3cret"}});
    let (s, b) = call(
        &c.app,
        "POST",
        "/v1/transports",
        Some(&ro),
        Some(body.clone()),
    )
    .await;
    assert_eq!((s, code(&b)), (403, "forbidden_scope"));
    let (s, b) = c.c("POST", "/v1/transports", Some(body)).await;
    assert_eq!(s, 201, "{b}");
    assert!(!b.to_string().contains("s3cret"), "secrets are write-only");
    assert_eq!(
        (
            b["data"]["kind"].as_str(),
            b["data"]["is_default"].as_bool(),
            b["data"]["detail"]["host"].as_str()
        ),
        (Some("smtp-relay"), Some(true), Some("smtp.postmarkapp.com"))
    );
    let stored: Vec<u8> = sqlx::query_scalar("SELECT config_enc FROM transports")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&stored).contains("s3cret"));
    // bad inputs
    for (body, field) in [
        (
            json!({"kind": "smtp-relay", "preset": "nope", "config": {"password": "x"}}),
            "preset",
        ),
        (
            json!({"kind": "smtp-relay", "config": {"host": "smtp.example.com", "port": 587, "tls": "none"}}),
            "config.tls",
        ),
        (
            json!({"kind": "ses", "config": {"region": "eu-west-1"}}),
            "config.access_key_id",
        ),
        (json!({"kind": "gmail-oauth", "config": {}}), "kind"),
    ] {
        let (s, b) = c.c("POST", "/v1/transports", Some(body)).await;
        assert_eq!((s, b["error"]["field"].as_str()), (400, Some(field)), "{b}");
    }
    // test against a local listener (plaintext only allowed for localhost)
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let _ = l.accept().await;
        }
    });
    let (_, b) = c.c("POST", "/v1/transports", Some(json!({"kind": "smtp-relay", "name": "local", "config": {"host": "127.0.0.1", "port": port, "tls": "none"}}))).await;
    let id = b["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        b["data"]["is_default"], false,
        "second transport is not the default"
    );
    let (s, b) = c
        .c("POST", &format!("/v1/transports/{id}/test"), None)
        .await;
    assert_eq!((s, b["data"]["ok"].as_bool()), (200, Some(true)), "{b}");
    let (_, b) = c.c("POST", "/v1/transports", Some(json!({"kind": "smtp-relay", "name": "dead", "config": {"host": "127.0.0.1", "port": 1, "tls": "none"}}))).await;
    let dead = b["data"]["id"].as_str().unwrap().to_string();
    let (s, b) = c
        .c("POST", &format!("/v1/transports/{dead}/test"), None)
        .await;
    assert_eq!((s, b["data"]["ok"].as_bool()), (200, Some(false)));
    let (_, b) = c.c("GET", "/v1/transports", None).await;
    assert_eq!(b["data"].as_array().unwrap().len(), 3);
    let (_, b) = c.c("GET", "/v1/account/status", None).await;
    assert_eq!(b["data"]["delivery_path"]["kind"], "smtp-relay");
    let (s, _) = c.c("DELETE", &format!("/v1/transports/{dead}"), None).await;
    assert_eq!(s, 200);
    assert_eq!(
        c.c("DELETE", &format!("/v1/transports/{dead}"), None)
            .await
            .0,
        404
    );
}

#[tokio::test]
async fn gmail_oauth_flow() {
    let c = match setup_with(|_| {}).await {
        Some(c) => c,
        None => return,
    };
    let (s, b) = c
        .c(
            "POST",
            "/v1/transports/gmail/oauth/start",
            Some(json!({"redirect_uri": "http://127.0.0.1:9/callback"})),
        )
        .await;
    assert_eq!((s, code(&b)), (501, "oauth_not_configured"));

    // A fake Google token endpoint.
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_url = format!("http://{}/token", l.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(
            l,
            Router::new().route(
                "/token",
                post(|| async { Json(json!({"refresh_token": "rt-123", "access_token": "at"})) }),
            ),
        )
        .await
        .unwrap();
    });
    let c = setup_with(move |cfg| {
        cfg.google_oauth = Some(mailcraft_api::state::GoogleOauth {
            client_id: "cid".into(),
            client_secret: Some("cs".into()),
            auth_url: "https://accounts.example/auth".into(),
            token_url,
        });
    })
    .await
    .unwrap();
    let redirect = "http://127.0.0.1:4567/callback";
    let (s, b) = c
        .c(
            "POST",
            "/v1/transports/gmail/oauth/start",
            Some(json!({"redirect_uri": "ftp://x"})),
        )
        .await;
    assert_eq!((s, code(&b)), (400, "invalid_request"));
    let (s, b) = c
        .c(
            "POST",
            "/v1/transports/gmail/oauth/start",
            Some(json!({"redirect_uri": redirect, "login_hint": "me@gmail.com"})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let (url, state) = (
        b["data"]["auth_url"].as_str().unwrap(),
        b["data"]["state"].as_str().unwrap(),
    );
    assert!(
        url.contains("code_challenge=")
            && url.contains("client_id=cid")
            && url.contains("gmail.send")
    );
    // bad / foreign state
    let (s, b) = c
        .c(
            "POST",
            "/v1/transports/gmail/oauth/complete",
            Some(json!({"state": "junk", "code": "c", "redirect_uri": redirect})),
        )
        .await;
    assert_eq!((s, code(&b)), (400, "oauth_state_invalid"));
    let (s, b) = c
        .c(
            "POST",
            "/v1/transports/gmail/oauth/complete",
            Some(json!({"state": state, "code": "c", "redirect_uri": "http://127.0.0.1:1/other"})),
        )
        .await;
    assert_eq!((s, code(&b)), (400, "oauth_state_invalid"));
    let (s, b) = c
        .c(
            "POST",
            "/v1/transports/gmail/oauth/complete",
            Some(json!({"state": state, "code": "4/abc", "redirect_uri": redirect})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(
        (b["data"]["kind"].as_str(), b["data"]["from"].as_str()),
        (Some("gmail-oauth"), Some("me@gmail.com"))
    );
    assert!(!b.to_string().contains("rt-123"));
    // refresh token stored encrypted and recoverable
    let (id, enc): (Uuid, Vec<u8>) = sqlx::query_as("SELECT id, config_enc FROM transports")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    let cfg: Value =
        serde_json::from_slice(&c.st.secrets.open(&enc, id.as_bytes()).unwrap()).unwrap();
    assert_eq!(cfg["refresh_token"], "rt-123");
    // reconnecting replaces in place
    let (s, b) = c
        .c(
            "POST",
            "/v1/transports/gmail/oauth/start",
            Some(json!({"redirect_uri": redirect, "login_hint": "me@gmail.com"})),
        )
        .await;
    assert_eq!(s, 200);
    let st2 = b["data"]["state"].as_str().unwrap();
    assert_eq!(
        c.c(
            "POST",
            "/v1/transports/gmail/oauth/complete",
            Some(json!({"state": st2, "code": "c2", "redirect_uri": redirect}))
        )
        .await
        .0,
        200
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM transports")
            .fetch_one(&c.st.db)
            .await
            .unwrap(),
        1
    );
}

// --------------------------------------------------------------- templates

#[tokio::test]
async fn templates_lifecycle() {
    let c = ctx!();
    let t = json!({"name": "Welcome", "subject": "Hi {{ first_name }}", "html": "<h1>Hello {{ first_name }}</h1><p>Welcome aboard.</p>"});
    let ro = c.key(&[Scope::Read]).await;
    assert_eq!(
        call(&c.app, "POST", "/v1/templates", Some(&ro), Some(t.clone()))
            .await
            .0,
        403
    );
    let (s, b) = c.c("POST", "/v1/templates", Some(t.clone())).await;
    assert_eq!(s, 201, "{b}");
    assert_eq!(
        (
            b["data"]["alias"].as_str(),
            b["data"]["status"].as_str(),
            b["data"]["version"].as_i64()
        ),
        (Some("welcome"), Some("draft"), Some(1))
    );
    let (s, b2) = c.c("POST", "/v1/templates", Some(t)).await;
    assert_eq!((s, code(&b2)), (409, "template_exists"));
    assert_eq!(
        c.c("POST", "/v1/templates", Some(json!({"name": "x"})))
            .await
            .0,
        400
    );
    // read by alias; draft until published
    let (_, b) = c.c("GET", "/v1/templates/welcome", None).await;
    assert_eq!(
        (
            b["data"]["status"].as_str(),
            b["data"]["template"]["version"].as_i64()
        ),
        (Some("draft"), Some(1))
    );
    let (s, b) = c
        .c(
            "POST",
            "/v1/templates/welcome/preview",
            Some(json!({"variables": {"first_name": "Ann"}})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    assert!(
        b["data"]["html"].as_str().unwrap().contains("Hello Ann") && b["data"]["lint"].is_array()
    );
    assert_eq!(
        c.c("POST", "/v1/templates/welcome/preview", None).await.0,
        200,
        "empty body = defaults"
    );
    // new version, publish picks it
    let (s, b) = c
        .c(
            "PATCH",
            "/v1/templates/welcome",
            Some(json!({"html": "<p>v2 {{ first_name }}</p>"})),
        )
        .await;
    assert_eq!((s, b["data"]["version"].as_i64()), (200, Some(2)));
    let (s, b) = c
        .c(
            "POST",
            "/v1/templates/welcome/publish",
            Some(json!({"version": 1})),
        )
        .await;
    assert_eq!((s, b["data"]["published_version"].as_i64()), (200, Some(1)));
    let (_, b) = c.c("POST", "/v1/templates/welcome/publish", None).await;
    assert_eq!(b["data"]["published_version"], 2);
    let (_, b) = c.c("GET", "/v1/templates", None).await;
    assert_eq!(
        (
            b["data"][0]["status"].as_str(),
            b["data"][0]["published_version"].as_i64()
        ),
        (Some("published"), Some(2))
    );
    assert_eq!(
        c.c(
            "POST",
            "/v1/templates/welcome/publish",
            Some(json!({"version": 9}))
        )
        .await
        .0,
        404
    );
    // exports
    for (f, needle) in [("html", "v2"), ("mjml", "<mjml>"), ("json", "\"blocks\"")] {
        let (s, b) = c
            .c(
                "GET",
                &format!("/v1/templates/welcome/export?format={f}"),
                None,
            )
            .await;
        assert!(
            s == 200 && b["data"]["content"].as_str().unwrap().contains(needle),
            "{f}: {b}"
        );
    }
    // import mjml + json, bad content
    let mjml = "<mjml><mj-body><mj-section><mj-column><mj-text>Hi there</mj-text></mj-column></mj-section></mj-body></mjml>";
    let (s, b) = c
        .c(
            "POST",
            "/v1/templates/import",
            Some(json!({"format": "mjml", "name": "From MJML", "content": mjml, "subject": "S"})),
        )
        .await;
    assert_eq!(
        (s, b["data"]["alias"].as_str()),
        (201, Some("from-mjml")),
        "{b}"
    );
    let (s, _) = c
        .c(
            "POST",
            "/v1/templates/import",
            Some(json!({"format": "json", "name": "Bad", "content": "{not json"})),
        )
        .await;
    assert_eq!(s, 400);
    // lint
    let (s, b) = c
        .c(
            "POST",
            "/v1/content/lint",
            Some(json!({"html": "<p>hello</p>", "subject": "Hello"})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    assert!(b["data"]["lint"].is_array());
    assert_eq!(
        c.c("POST", "/v1/content/lint", Some(json!({}))).await.0,
        400
    );
    assert_eq!(c.c("GET", "/v1/templates/nope", None).await.0, 404);
}

// ------------------------------------------------------------- automations

#[tokio::test]
async fn automations_lifecycle() {
    let c = ctx!();
    let def = json!({"name": "welcome-flow", "trigger": "signed_up", "steps": [
        {"key": "mail", "type": "send_email", "config": {"template": "welcome"}}]});
    // template must exist and be published
    let (s, b) = c.c("POST", "/v1/automations", Some(def.clone())).await;
    assert_eq!((s, code(&b)), (422, "invalid_request"), "{b}");
    c.c(
        "POST",
        "/v1/templates",
        Some(json!({"name": "welcome", "subject": "Hi", "html": "<p>Hi</p>"})),
    )
    .await;
    c.c("POST", "/v1/templates/welcome/publish", None).await;
    let ro = c.key(&[Scope::Read]).await;
    assert_eq!(
        call(
            &c.app,
            "POST",
            "/v1/automations",
            Some(&ro),
            Some(def.clone())
        )
        .await
        .0,
        403
    );
    let (s, b) = c.c("POST", "/v1/automations", Some(def.clone())).await;
    assert_eq!(s, 201, "{b}");
    assert_eq!(
        (
            b["data"]["status"].as_str(),
            b["data"]["trigger"].as_str(),
            b["data"]["steps"].as_array().map(|a| a.len())
        ),
        (Some("draft"), Some("signed_up"), Some(2))
    );
    let id = b["data"]["id"].as_str().unwrap().to_string();
    let (s, b) = c.c("POST", "/v1/automations", Some(json!({"name": "bad", "trigger": "x", "steps": [{"key": "a", "type": "delay", "config": {"duration": "31d"}}]}))).await;
    assert_eq!((s, code(&b)), (422, "invalid_request"));
    assert_eq!(c.c("POST", "/v1/automations", Some(json!({"name": "dup", "trigger": "x", "steps": [{"key": "t", "type": "trigger", "config": {"event": "y"}}]}))).await.0, 400, "trigger and trigger step");
    // pause needs active
    let (s, b) = c
        .c("POST", &format!("/v1/automations/{id}/pause"), None)
        .await;
    assert_eq!((s, code(&b)), (409, "invalid_state"));
    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/automations/{id}/publish"),
            Some(json!({})),
        )
        .await;
    assert_eq!(
        (s, b["data"]["status"].as_str()),
        (200, Some("active")),
        "{b}"
    );
    assert_eq!(
        c.c("POST", "/v1/automations/welcome-flow/pause", None)
            .await
            .1["data"]["status"],
        "paused"
    );
    assert_eq!(
        c.c("POST", &format!("/v1/automations/{id}/resume"), None)
            .await
            .1["data"]["status"],
        "active"
    );
    let (_, b) = c.c("GET", "/v1/automations/welcome-flow", None).await;
    assert_eq!(
        (
            b["data"]["id"].as_str(),
            b["data"]["steps"].as_array().map(|a| a.len())
        ),
        (Some(id.as_str()), Some(2))
    );
    let (_, b) = c.c("GET", "/v1/automations?status=active", None).await;
    assert_eq!(b["data"].as_array().unwrap().len(), 1);
    // an event enrols a contact; runs lists it
    let (s, b) = c.c("POST", "/v1/events", Some(json!({"name": "signed_up", "contact": {"email": "ann@example.com"}, "properties": {"plan": "pro"}}))).await;
    assert_eq!(s, 202, "{b}");
    assert_eq!(
        b["data"]["triggered_automations"][0]["id"].as_str(),
        Some(id.as_str())
    );
    let (s, b) = c.c("POST", "/v1/events", Some(json!({"name": "signed_up", "contact": {"email": "bob@example.com"}, "dry_run": true}))).await;
    assert_eq!(s, 200);
    assert_eq!(b["data"]["triggered_automations"][0]["run_id"], Value::Null);
    let (s, b) = c
        .c("GET", &format!("/v1/automations/{id}/runs"), None)
        .await;
    assert_eq!((s, b["data"].as_array().unwrap().len()), (200, 1), "{b}");
    assert_eq!(
        c.c(
            "GET",
            &format!("/v1/automations/{id}/runs?status=bogus"),
            None
        )
        .await
        .0,
        400
    );
    assert_eq!(c.c("GET", "/v1/automations/nope", None).await.0, 404);
}

// ------------------------------------------------------------------- admin

#[tokio::test]
async fn stats_settings_policy_doctor_suppressions() {
    let c = ctx!();
    // stats
    let (email_id, ): (Uuid, ) = sqlx::query_as("INSERT INTO emails (workspace_id, stream, from_addr, to_addr, subject) VALUES ($1,'transactional','a@x.com','b@y.com','s') RETURNING id")
        .bind(c.ws)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    for t in [
        "sent",
        "sent",
        "delivered",
        "bounced",
        "delivery_delayed",
        "opened",
    ] {
        sqlx::query("INSERT INTO email_events (workspace_id, email_id, type) VALUES ($1,$2,$3)")
            .bind(c.ws)
            .bind(email_id)
            .bind(t)
            .execute(&c.st.db)
            .await
            .unwrap();
    }
    let (s, b) = c.c("GET", "/v1/stats/overview?days=3", None).await;
    assert_eq!(s, 200);
    assert_eq!(
        b["data"]["totals"],
        json!({"sent": 2, "delivered": 1, "bounced": 1, "complained": 0, "deferred": 1})
    );
    assert_eq!(b["data"]["series"].as_array().unwrap().len(), 3);
    assert_eq!(b["data"]["series"][2]["sent"], 2);
    assert_eq!(c.c("GET", "/v1/stats/overview?days=0", None).await.0, 400);

    // settings: secrets are write-only
    let ro = c.key(&[Scope::Read]).await;
    assert_eq!(
        call(
            &c.app,
            "PUT",
            "/v1/settings",
            Some(&ro),
            Some(json!({"reply_to": "a@b.co"}))
        )
        .await
        .0,
        403
    );
    let (s, b) = c.c("PUT", "/v1/settings", Some(json!({"llm_provider": {"kind": "openai", "model": "gpt-x", "api_key": "sk-secret"}, "default_from": "hello@example.com"}))).await;
    assert_eq!(s, 200, "{b}");
    assert!(!b.to_string().contains("sk-secret"));
    let (_, b) = call(&c.app, "GET", "/v1/settings", Some(&ro), None).await;
    assert_eq!(
        (
            b["data"]["llm_provider"]["kind"].as_str(),
            b["data"]["llm_provider"]["api_key_set"].as_bool(),
            b["data"]["default_from"].as_str()
        ),
        (Some("openai"), Some(true), Some("hello@example.com"))
    );
    // a second partial update keeps the first
    c.c(
        "PUT",
        "/v1/settings",
        Some(json!({"reply_to": "r@example.com"})),
    )
    .await;
    let (_, b) = c.c("GET", "/v1/settings", None).await;
    assert_eq!(
        (
            b["data"]["reply_to"].as_str(),
            b["data"]["llm_provider"]["model"].as_str()
        ),
        (Some("r@example.com"), Some("gpt-x"))
    );
    for bad in [
        json!({"llm_provider": {"kind": "skynet"}}),
        json!({"default_from": "nope"}),
        json!({"unknown": 1}),
    ] {
        assert_eq!(c.c("PUT", "/v1/settings", Some(bad)).await.0, 400);
    }

    // custom instructions: set / get / trim / clear / too long / non-admin
    let (s, b) = c
        .c(
            "PUT",
            "/v1/settings",
            Some(json!({"custom_instructions": "  Be warm.  "})),
        )
        .await;
    assert_eq!(
        (s, b["data"]["custom_instructions"].as_str()),
        (200, Some("Be warm.")),
        "{b}"
    );
    assert_eq!(
        c.c("GET", "/v1/settings", None).await.1["data"]["llm_provider"]["model"],
        "gpt-x",
        "llm kept"
    );
    let (s, b) = c
        .c(
            "PUT",
            "/v1/settings",
            Some(json!({"custom_instructions": "x".repeat(2001)})),
        )
        .await;
    assert_eq!(s, 422, "{b}");
    assert!(b["error"]["hint"].is_string(), "{b}");
    assert_eq!(
        c.c("GET", "/v1/settings", None).await.1["data"]["custom_instructions"],
        "Be warm."
    );
    assert_eq!(
        call(
            &c.app,
            "PUT",
            "/v1/settings",
            Some(&ro),
            Some(json!({"custom_instructions": "hi"}))
        )
        .await
        .0,
        403
    );
    let (_, b) = c
        .c(
            "PUT",
            "/v1/settings",
            Some(json!({"custom_instructions": ""})),
        )
        .await;
    assert!(b["data"]["custom_instructions"].is_null(), "{b}");

    // policy
    let (_, b) = c.c("GET", "/v1/policy", None).await;
    assert_eq!(b["data"]["default"]["send"], "auto");
    assert_eq!(
        call(
            &c.app,
            "PUT",
            "/v1/policy",
            Some(&ro),
            Some(json!({"default": {"send": "blocked"}}))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        c.c(
            "PUT",
            "/v1/policy",
            Some(json!({"default": {"send": "maybe"}}))
        )
        .await
        .0,
        400
    );
    assert_eq!(
        c.c(
            "PUT",
            "/v1/policy",
            Some(json!({"default": {"send": "needs_approval"}}))
        )
        .await
        .0,
        200
    );
    assert_eq!(
        c.c("GET", "/v1/policy", None).await.1["data"]["default"]["send"],
        "needs_approval"
    );

    // event definitions
    let (s, _) = c
        .c(
            "POST",
            "/v1/event-definitions",
            Some(json!({"name": "signed_up", "schema": {"type": "object"}})),
        )
        .await;
    assert_eq!(s, 201);
    assert_eq!(
        c.c("POST", "/v1/event-definitions", Some(json!({"name": ""})))
            .await
            .0,
        400
    );
    assert_eq!(
        c.c("GET", "/v1/event-definitions", None).await.1["data"][0]["name"],
        "signed_up"
    );

    // doctor
    let (s, b) = call(&c.app, "GET", "/v1/doctor", Some(&ro), None).await;
    assert_eq!(s, 200);
    let checks = b["data"]["checks"].as_array().unwrap();
    let st = |id: &str| {
        checks
            .iter()
            .find(|x| x["id"] == id)
            .map(|x| x["status"].as_str().unwrap())
    };
    assert_eq!(
        (st("postgres"), st("transport_auth"), st("dns_records")),
        (Some("pass"), Some("warn"), Some("skipped"))
    );
    assert!(st("redis").is_some());

    // suppressions
    for e in ["a@x.com", "b@x.com", "c@x.com"] {
        sqlx::query(
            "INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,$2,'manual')",
        )
        .bind(c.ws)
        .bind(e)
        .execute(&c.st.db)
        .await
        .unwrap();
    }
    let (s, b) = call(&c.app, "GET", "/v1/suppressions?limit=2", Some(&ro), None).await;
    assert_eq!((s, b["data"].as_array().unwrap().len()), (200, 2));
    let cur = b["next_cursor"].as_str().expect("next page").to_string();
    let (_, b2) = c
        .c(
            "GET",
            &format!("/v1/suppressions?limit=2&cursor={cur}"),
            None,
        )
        .await;
    assert_eq!(
        (
            b2["data"].as_array().unwrap().len(),
            b2["next_cursor"].is_null()
        ),
        (1, true)
    );
    assert_eq!(
        call(
            &c.app,
            "DELETE",
            "/v1/suppressions/a%40x.com",
            Some(&ro),
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        c.c("DELETE", "/v1/suppressions/a%40x.com", None).await.0,
        200
    );
    assert_eq!(
        c.c("DELETE", "/v1/suppressions/a%40x.com", None).await.0,
        404
    );
    assert_eq!(
        c.c("GET", "/v1/suppressions?cursor=junk", None).await.0,
        400
    );
}

#[tokio::test]
async fn kill_switch_shape_and_keys_pagination() {
    let c = ctx!();
    let (_, b) = c.c("GET", "/v1/kill-switch", None).await;
    assert_eq!(
        (b["data"]["on"].as_bool(), b["data"]["since"].is_null()),
        (Some(false), true)
    );
    c.c("POST", "/v1/kill-switch", Some(json!({"on": true})))
        .await;
    let (_, b) = c.c("GET", "/v1/kill-switch", None).await;
    assert!(
        b["data"]["on"] == true && b["data"]["since"].is_string() && b["data"]["by"].is_string()
    );
    for _ in 0..3 {
        c.key(&[Scope::Read]).await;
    }
    let (_, b) = c.c("GET", "/v1/keys?limit=2", None).await;
    assert_eq!(b["data"].as_array().unwrap().len(), 2);
    let cur = b["next_cursor"].as_str().unwrap();
    let (_, b2) = c
        .c("GET", &format!("/v1/keys?limit=2&cursor={cur}"), None)
        .await;
    assert_eq!(
        (
            b2["data"].as_array().unwrap().len(),
            b2["next_cursor"].is_null()
        ),
        (2, true)
    );
    let ids: std::collections::HashSet<_> = b["data"]
        .as_array()
        .unwrap()
        .iter()
        .chain(b2["data"].as_array().unwrap())
        .map(|k| k["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 4, "pages do not overlap");
}

// ------------------------------------------- domains + contact/segment services

#[tokio::test]
async fn domains_service_and_dkim_lifecycle() {
    // The planner needs an instance domain (or sending IPs) for SPF / DKIM delegation.
    std::env::set_var("MAILCRAFT_PUBLIC_URL", "https://mc.example.net");
    let c = ctx!();
    let ro = c.key(&[Scope::Read]).await;
    let (s, b) = c
        .c(
            "POST",
            "/v1/domains",
            Some(json!({"domain": "not a domain"})),
        )
        .await;
    if s == 501 {
        eprintln!("no system DNS resolver: domains stay stubbed here");
        return;
    }
    assert_eq!((s, code(&b)), (400, "invalid_request"));
    assert_eq!(
        call(
            &c.app,
            "POST",
            "/v1/domains",
            Some(&ro),
            Some(json!({"domain": "mail.acme-test.invalid"}))
        )
        .await
        .0,
        403
    );
    let (s, b) = c
        .c(
            "POST",
            "/v1/domains",
            Some(json!({"domain": "Mail.Acme-Test.invalid", "stream": "marketing"})),
        )
        .await;
    assert_eq!(s, 201, "{b}");
    let d = &b["data"];
    assert_eq!(
        (
            d["name"].as_str(),
            d["status"].as_str(),
            d["stream"].as_str()
        ),
        (
            Some("mail.acme-test.invalid"),
            Some("not_started"),
            Some("marketing")
        )
    );
    let recs = d["records"].as_array().unwrap();
    assert!(
        recs.iter().any(|r| r["record"] == "DKIM")
            && recs.iter().any(|r| r["record"] == "ReturnPath"),
        "{d}"
    );
    assert!(recs.iter().all(|r| r["status"] == "not_started"));
    let id = d["id"].as_str().unwrap().to_string();
    assert_eq!(
        c.c(
            "POST",
            "/v1/domains",
            Some(json!({"domain": "mail.acme-test.invalid"}))
        )
        .await
        .1["error"]["code"],
        "domain_exists"
    );
    assert_eq!(
        c.c("GET", "/v1/domains", None).await.1["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        c.c("GET", &format!("/v1/domains/{}", Uuid::new_v4()), None)
            .await
            .0,
        404
    );
    // verify: nothing is published under .invalid
    let (s, b) = c.c("POST", &format!("/v1/domains/{id}/verify"), None).await;
    assert_eq!(s, 200, "{b}");
    assert_ne!(b["data"]["status"], "verified");
    // rotate -> standby selector -> activate -> old retires
    let (s, b) = c
        .c("POST", &format!("/v1/domains/{id}/rotate-dkim"), None)
        .await;
    assert_eq!(s, 200, "{b}");
    let sel: String = sqlx::query_scalar("SELECT selector FROM dkim_keys WHERE state = 'standby'")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(
        c.c(
            "POST",
            &format!("/v1/domains/{id}/dkim/activate"),
            Some(json!({"selector": "nope"}))
        )
        .await
        .0,
        404
    );
    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/domains/{id}/dkim/activate"),
            Some(json!({"selector": sel})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let states: Vec<String> = sqlx::query_scalar("SELECT state FROM dkim_keys ORDER BY state")
        .fetch_all(&c.st.db)
        .await
        .unwrap();
    assert_eq!(states, ["active", "retired"]);
    let (s, b) = c
        .c("POST", &format!("/v1/domains/{id}/dkim/purge"), None)
        .await;
    assert_eq!(
        (s, b["data"]["purged"].as_array().unwrap().len()),
        (200, 0),
        "retired keys are kept 7 days"
    );
    // dns sync needs a token; unknown provider rejected
    assert_eq!(
        c.c(
            "POST",
            &format!("/v1/domains/{id}/dns/sync"),
            Some(json!({"provider": "route53"}))
        )
        .await
        .0,
        400
    );
    if std::env::var("CLOUDFLARE_API_TOKEN").is_err() {
        assert_eq!(
            c.c(
                "POST",
                &format!("/v1/domains/{id}/dns/sync"),
                Some(json!({"provider": "cloudflare", "dry_run": true}))
            )
            .await
            .0,
            400
        );
    }
    // doctor now has a dns_records check for the domain
    let (_, b) = c.c("GET", "/v1/doctor", None).await;
    assert!(
        b["data"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == "dns_records:mail.acme-test.invalid"),
        "{b}"
    );
    assert_eq!(
        c.c("DELETE", &format!("/v1/domains/{id}"), None).await.0,
        200
    );
    assert_eq!(c.c("GET", &format!("/v1/domains/{id}"), None).await.0, 404);
}

#[tokio::test]
async fn contacts_segments_services() {
    let c = ctx!();
    let (s, b) = c.c("PUT", "/v1/contacts", Some(json!({"email": "Ann@Example.COM", "first_name": "Ann", "properties": {"plan": "free"}}))).await;
    assert_eq!(
        (s, b["data"]["email"].as_str()),
        (200, Some("Ann@example.com")),
        "{b}"
    );
    assert_eq!(
        c.c("PUT", "/v1/contacts", Some(json!({"email": "nope"})))
            .await
            .0,
        422
    );
    // PATCH merges properties
    let (s, b) = c
        .c(
            "PATCH",
            "/v1/contacts/ann@example.com",
            Some(json!({"properties": {"plan": "pro", "seats": 3}})),
        )
        .await;
    assert_eq!(
        (
            s,
            b["data"]["properties"]["plan"].as_str(),
            b["data"]["properties"]["seats"].as_i64()
        ),
        (200, Some("pro"), Some(3)),
        "{b}"
    );
    assert_eq!(
        c.c("PATCH", "/v1/contacts/ghost@example.com", Some(json!({})))
            .await
            .0,
        404
    );
    let id = b["data"]["id"].as_str().unwrap().to_string();
    for i in 0..3 {
        c.c(
            "PUT",
            "/v1/contacts",
            Some(json!({"email": format!("u{i}@example.com")})),
        )
        .await;
    }
    let (_, b) = c.c("GET", "/v1/contacts?limit=3", None).await;
    assert_eq!(b["data"].as_array().unwrap().len(), 3);
    let cur = b["next_cursor"].as_str().unwrap();
    assert_eq!(
        c.c("GET", &format!("/v1/contacts?limit=3&cursor={cur}"), None)
            .await
            .1["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // segment + members
    let (s, b) = c
        .c("POST", "/v1/segments", Some(json!({"name": "pros"})))
        .await;
    assert_eq!(s, 201, "{b}");
    let seg = b["data"]["id"].as_str().unwrap().to_string();
    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/segments/{seg}/members"),
            Some(json!({"emails": ["ann@example.com", "new@example.com"]})),
        )
        .await;
    assert_eq!((s, b["data"]["added"].as_i64()), (200, Some(2)), "{b}");
    assert_eq!(
        c.c(
            "POST",
            &format!("/v1/segments/{seg}/members"),
            Some(json!({"emails": ["ann@example.com"]}))
        )
        .await
        .1["data"]["already_members"],
        1
    );
    assert_eq!(
        c.c("GET", "/v1/segments", None).await.1["data"][0]["members"],
        2
    );
    assert_eq!(
        c.c(
            "POST",
            "/v1/segments",
            Some(json!({"name": "bad", "filter": {"nope": 1}}))
        )
        .await
        .0,
        400
    );
    // suppress + get shows it; delete erases
    assert_eq!(
        c.c(
            "POST",
            &format!("/v1/contacts/{id}/suppress"),
            Some(json!({"reason": "asked nicely"}))
        )
        .await
        .0,
        200
    );
    assert_eq!(
        c.c("GET", &format!("/v1/contacts/{id}"), None).await.1["data"]["suppressed"],
        true
    );
    assert_eq!(
        c.c("DELETE", "/v1/contacts/ann@example.com", None).await.0,
        200
    );
    assert_eq!(c.c("GET", &format!("/v1/contacts/{id}"), None).await.0, 404);
}
