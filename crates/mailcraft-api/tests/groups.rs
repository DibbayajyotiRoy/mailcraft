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

// ------------------------------------------------------------ dashboard API gaps

impl Ctx {
    async fn email(
        &self,
        to: &str,
        from: &str,
        subject: &str,
        stream: &str,
        env: &str,
        at: &str,
    ) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO emails (workspace_id, stream, env, from_addr, to_addr, subject, status, created_at) \
             VALUES ($1,$2,$3,$4,$5,$6,'sent',$7::timestamptz) RETURNING id",
        )
        .bind(self.ws)
        .bind(stream)
        .bind(env)
        .bind(from)
        .bind(to)
        .bind(subject)
        .bind(at)
        .fetch_one(&self.st.db)
        .await
        .unwrap()
    }
}

fn ids(b: &Value) -> Vec<String> {
    b["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["subject"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn email_detail_has_body_and_list_filters_server_side() {
    let c = ctx!();
    let a = c
        .email(
            "Ann@Example.com",
            "me@acme.io",
            "Welcome aboard",
            "transactional",
            "live",
            "2026-10-01T10:00:00Z",
        )
        .await;
    c.email(
        "bob@example.com",
        "me@acme.io",
        "100% off sale",
        "marketing",
        "live",
        "2026-10-05T10:00:00Z",
    )
    .await;
    c.email(
        "cy@other.org",
        "news@acme.io",
        "Weekly digest",
        "marketing",
        "test",
        "2026-10-09T23:30:00Z",
    )
    .await;
    sqlx::query("INSERT INTO email_bodies (email_id, html, text) VALUES ($1, $2, 'plain')")
        .bind(a)
        .bind("<p>Hello</p>")
        .execute(&c.st.db)
        .await
        .unwrap();

    let (s, b) = c.c("GET", &format!("/v1/emails/{a}"), None).await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(
        (
            b["data"]["html"].as_str(),
            b["data"]["text"].as_str(),
            b["data"]["body_truncated"].as_bool()
        ),
        (Some("<p>Hello</p>"), Some("plain"), Some(false))
    );
    // no stored body (e.g. template not rendered yet): nulls, not an error
    let none = c
        .email(
            "d@example.com",
            "me@acme.io",
            "x",
            "transactional",
            "live",
            "2026-10-02T00:00:00Z",
        )
        .await;
    let (_, b) = c.c("GET", &format!("/v1/emails/{none}"), None).await;
    assert!(b["data"]["html"].is_null() && b["data"]["text"].is_null());
    // size cap
    sqlx::query("INSERT INTO email_bodies (email_id, html) VALUES ($1, repeat('a', 250000))")
        .bind(none)
        .execute(&c.st.db)
        .await
        .unwrap();
    let (_, b) = c.c("GET", &format!("/v1/emails/{none}"), None).await;
    assert_eq!(
        (
            b["data"]["html"].as_str().map(str::len),
            b["data"]["body_truncated"].as_bool()
        ),
        (Some(200_000), Some(true))
    );

    let q = |qs: &str| format!("/v1/emails?{qs}");
    // case-insensitive contains on to / from / subject
    assert_eq!(
        ids(&c.c("GET", &q("q=ANN@exam"), None).await.1),
        ["Welcome aboard"]
    );
    assert_eq!(
        ids(&c.c("GET", &q("q=digest"), None).await.1),
        ["Weekly digest"]
    );
    assert_eq!(
        c.c("GET", &q("q=news@acme"), None).await.1["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // LIKE wildcards are literal
    assert_eq!(
        ids(&c.c("GET", &q("q=100%25"), None).await.1),
        ["100% off sale"]
    );
    assert!(ids(&c.c("GET", &q("q=%25%25"), None).await.1).is_empty());
    // by id
    assert_eq!(
        ids(&c.c("GET", &q(&format!("q={a}")), None).await.1),
        ["Welcome aboard"]
    );
    // date range: `to` as a date includes that whole day; RFC 3339 works too
    assert_eq!(
        ids(&c
            .c("GET", &q("from=2026-10-05&to=2026-10-09"), None)
            .await
            .1),
        ["Weekly digest", "100% off sale"]
    );
    assert_eq!(
        ids(&c.c("GET", &q("to=2026-10-01"), None).await.1),
        ["Welcome aboard"]
    );
    assert_eq!(
        ids(&c.c("GET", &q("from=2026-10-09T23:00:00Z"), None).await.1),
        ["Weekly digest"]
    );
    // stream / env, combined with q
    assert_eq!(
        ids(&c.c("GET", &q("stream=marketing&env=live"), None).await.1),
        ["100% off sale"]
    );
    assert_eq!(
        ids(&c.c("GET", &q("env=test&q=weekly"), None).await.1),
        ["Weekly digest"]
    );
    for bad in ["from=yesterday", "to=2026-13-01", "stream=bulk", "env=prod"] {
        assert_eq!(c.c("GET", &q(bad), None).await.0, 400, "{bad}");
    }
    // filters compose with the cursor
    let (_, p1) = c.c("GET", &q("stream=marketing&limit=1"), None).await;
    let cur = p1["next_cursor"].as_str().expect("second page").to_string();
    assert_eq!(
        ids(&c
            .c(
                "GET",
                &q(&format!("stream=marketing&limit=1&cursor={cur}")),
                None
            )
            .await
            .1),
        ["100% off sale"]
    );
}

#[tokio::test]
async fn approval_reason_and_rendered_preview() {
    let c = ctx!();
    let e = c
        .email(
            "a@example.com",
            "me@acme.io",
            "Hi",
            "transactional",
            "live",
            "2026-10-01T00:00:00Z",
        )
        .await;
    sqlx::query("UPDATE emails SET status = 'pending_approval' WHERE id = $1")
        .bind(e)
        .execute(&c.st.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO email_bodies (email_id, html, text) VALUES ($1,'<b>Pay now</b>','Pay now')",
    )
    .bind(e)
    .execute(&c.st.db)
    .await
    .unwrap();
    let mk = |_: ()| async {
        sqlx::query_scalar::<_, Uuid>("INSERT INTO approvals (workspace_id, kind, subject_id, payload) VALUES ($1,'email',$2,$3) RETURNING id")
            .bind(c.ws).bind(e)
            .bind(json!({"email_ids": [e], "preview": {"subject": "Hi", "has_html": true}}))
            .fetch_one(&c.st.db).await.unwrap()
    };
    let id = mk(()).await;
    let (_, b) = c.c("GET", &format!("/v1/approvals/{id}"), None).await;
    assert_eq!(
        (
            b["data"]["payload"]["preview"]["html"].as_str(),
            b["data"]["reason"].is_null()
        ),
        (Some("<b>Pay now</b>"), true)
    );
    let long = "x".repeat(501);
    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/approvals/{id}/decide"),
            Some(json!({"decision": "reject", "reason": long})),
        )
        .await;
    assert_eq!((s, code(&b)), (400, "invalid_request"), "{b}");
    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/approvals/{id}/decide"),
            Some(json!({"decision": "reject", "reason": "  looks like phishing "})),
        )
        .await;
    assert_eq!(
        (s, b["data"]["reason"].as_str()),
        (200, Some("looks like phishing")),
        "{b}"
    );
    let (_, b) = c.c("GET", &format!("/v1/approvals/{id}"), None).await;
    assert_eq!(
        (b["data"]["status"].as_str(), b["data"]["reason"].as_str()),
        (Some("rejected"), Some("looks like phishing"))
    );
    let audited: Value = sqlx::query_scalar(
        "SELECT args FROM audit_log WHERE action = 'approval.decide' AND approval_id = $1",
    )
    .bind(id)
    .fetch_one(&c.st.db)
    .await
    .unwrap();
    assert_eq!(audited["reason"], "looks like phishing");
    // reason stays optional
    let id2 = mk(()).await;
    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/approvals/{id2}/decide"),
            Some(json!({"decision": "approve"})),
        )
        .await;
    assert_eq!((s, b["data"]["reason"].is_null()), (200, true));
}

#[tokio::test]
async fn keys_last_used_segments_member_count_contacts_search() {
    let c = ctx!();
    let (_, b) = c.c("GET", "/v1/keys", None).await;
    let admin = &b["data"].as_array().unwrap()[0];
    assert!(
        admin["last_used_at"].is_string(),
        "authenticated request stamps last_used_at: {admin}"
    );
    let other = c.key(&[Scope::Read]).await;
    let (_, b) = c.c("GET", "/v1/keys", None).await;
    let unused = b["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|k| k["last_used_at"].is_null())
        .count();
    assert_eq!(unused, 1);
    call(&c.app, "GET", "/v1/emails", Some(&other), None).await;
    let (_, b) = c.c("GET", "/v1/keys", None).await;
    assert!(b["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|k| k["last_used_at"].is_string()));

    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "ann@example.com", "first_name": "Ann", "last_name": "Lee"})),
    )
    .await;
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "bob@example.com", "first_name": "Bob", "last_name": "Stone"})),
    )
    .await;
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "x_y@other.org"})),
    )
    .await;
    let emails = |b: &Value| -> Vec<String> {
        let mut v: Vec<String> = b["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["email"].as_str().unwrap().to_lowercase())
            .collect();
        v.sort();
        v
    };
    assert_eq!(
        emails(&c.c("GET", "/v1/contacts?q=ANN", None).await.1),
        ["ann@example.com"]
    );
    assert_eq!(
        emails(&c.c("GET", "/v1/contacts?q=stone", None).await.1),
        ["bob@example.com"]
    );
    assert_eq!(
        emails(&c.c("GET", "/v1/contacts?q=ann%20lee", None).await.1),
        ["ann@example.com"]
    );
    assert_eq!(
        emails(&c.c("GET", "/v1/contacts?q=example.com", None).await.1).len(),
        2
    );
    assert_eq!(
        emails(&c.c("GET", "/v1/contacts?q=x_y", None).await.1),
        ["x_y@other.org"]
    );
    assert!(emails(&c.c("GET", "/v1/contacts?q=x%25y", None).await.1).is_empty());
    assert_eq!(
        emails(&c.c("GET", "/v1/contacts?q=", None).await.1).len(),
        3
    );

    let (_, seg) = c
        .c("POST", "/v1/segments", Some(json!({"name": "vips"})))
        .await;
    let sid = seg["data"]["id"].as_str().unwrap();
    c.c(
        "POST",
        &format!("/v1/segments/{sid}/members"),
        Some(json!({"emails": ["ann@example.com", "bob@example.com"]})),
    )
    .await;
    c.c("POST", "/v1/segments", Some(json!({"name": "empty"})))
        .await;
    let (_, b) = c.c("GET", "/v1/segments", None).await;
    let counts: Vec<(String, i64)> = b["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().into(),
                s["member_count"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(counts, [("empty".to_string(), 0), ("vips".to_string(), 2)]);
}

#[tokio::test]
async fn template_version_history() {
    let c = ctx!();
    let (_, b) = c
        .c(
            "POST",
            "/v1/templates",
            Some(json!({"name": "News", "subject": "v1", "html": "<p>one</p>"})),
        )
        .await;
    let id = b["data"]["id"].as_str().unwrap().to_string();
    c.c("POST", &format!("/v1/templates/{id}/publish"), None)
        .await;
    let (s, _) = c
        .c(
            "PATCH",
            &format!("/v1/templates/{id}"),
            Some(json!({"subject": "v2", "html": "<p>two</p>"})),
        )
        .await;
    assert_eq!(s, 200);
    let (s, b) = c
        .c("GET", &format!("/v1/templates/{id}/versions"), None)
        .await;
    assert_eq!(s, 200, "{b}");
    let v: Vec<(i64, bool, bool)> = b["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            (
                v["version"].as_i64().unwrap(),
                v["published"].as_bool().unwrap(),
                v["created_at"].is_string(),
            )
        })
        .collect();
    assert_eq!(
        v,
        [(2, false, true), (1, true, true)],
        "newest first; v1 is the live one"
    );
    assert!(b["data"][1]["published_at"].is_string() && b["data"][0]["published_at"].is_null());
    let (s, b) = c
        .c("GET", &format!("/v1/templates/{id}/versions/1"), None)
        .await;
    assert_eq!(
        (
            s,
            b["data"]["version"].as_i64(),
            b["data"]["subject"].as_str(),
            b["data"]["published"].as_bool()
        ),
        (200, Some(1), Some("v1"), Some(true)),
        "{b}"
    );
    assert!(b["data"]["template"].is_object());
    assert_eq!(
        c.c("GET", &format!("/v1/templates/{id}/versions/9"), None)
            .await
            .0,
        404
    );
    assert_eq!(c.c("GET", "/v1/templates/nope/versions", None).await.0, 404);
}

#[tokio::test]
async fn automation_step_stats_and_run_current_step() {
    let c = ctx!();
    c.c(
        "POST",
        "/v1/templates",
        Some(json!({"name": "welcome", "subject": "Hi", "html": "<p>Hi</p>"})),
    )
    .await;
    c.c("POST", "/v1/templates/welcome/publish", None).await;
    let (s, b) = c
        .c(
            "POST",
            "/v1/automations",
            Some(json!({"name": "flow", "trigger": "signed_up", "steps": [
        {"key": "mail", "type": "send_email", "config": {"template": "welcome"}}]})),
        )
        .await;
    assert_eq!(s, 201, "{b}");
    let aid: Uuid = b["data"]["id"].as_str().unwrap().parse().unwrap();
    let db = &c.st.db;
    let run = |email: &'static str, state: &'static str, cur: Option<&'static str>| async move {
        let cid: Uuid = sqlx::query_scalar(
            "INSERT INTO contacts (workspace_id, email) VALUES ($1,$2) RETURNING id",
        )
        .bind(c.ws)
        .bind(email)
        .fetch_one(db)
        .await
        .unwrap();
        sqlx::query_scalar::<_, Uuid>("INSERT INTO automation_runs (automation_id, version, contact_id, entry_key, state, current_step) VALUES ($1,1,$2,$3,$4,$5) RETURNING id")
            .bind(aid).bind(cid).bind(email).bind(state).bind(cur).fetch_one(db).await.unwrap()
    };
    let log = |r: Uuid, step: &'static str, res: Value| async move {
        sqlx::query(
            "INSERT INTO automation_run_steps (run_id, step_key, result) VALUES ($1,$2,$3)",
        )
        .bind(r)
        .bind(step)
        .bind(res)
        .execute(db)
        .await
        .unwrap();
    };
    // r1 finished both steps; r2 is waiting on `delay`; r3 failed at `mail` after a retry; r4 exited at `delay`;
    // r5 has just arrived at `mail` (no log yet).
    let r1 = run("1@x.io", "completed", None).await;
    log(r1, "delay", json!({})).await;
    log(r1, "mail", json!({})).await;
    let r2 = run("2@x.io", "waiting", Some("delay")).await;
    log(r2, "delay", json!({"outcome": "wait"})).await;
    let r3 = run("3@x.io", "failed", Some("mail")).await;
    log(r3, "delay", json!({})).await;
    log(r3, "mail", json!({"decision": "error", "failed": false})).await;
    log(r3, "mail", json!({"decision": "error", "failed": true})).await;
    let r4 = run("4@x.io", "exited", Some("delay")).await;
    log(r4, "delay", json!({})).await;
    log(r4, "_goal", json!({"decision": "exit"})).await;
    run("5@x.io", "active", Some("mail")).await;

    let (_, b) = c.c("GET", &format!("/v1/automations/{aid}"), None).await;
    let st = &b["data"]["stats"];
    assert_eq!(
        st["delay"],
        json!({"entered": 4, "completed": 2, "failed": 0, "active": 1, "exited": 1}),
        "{st}"
    );
    assert_eq!(
        st["mail"],
        json!({"entered": 3, "completed": 1, "failed": 1, "active": 1, "exited": 0}),
        "{st}"
    );
    assert!(st.get("_goal").is_none());
    // runs expose current_step
    let (_, b) = c
        .c(
            "GET",
            &format!("/v1/automations/{aid}/runs?status=waiting"),
            None,
        )
        .await;
    assert_eq!(b["data"][0]["current_step"], "delay");
}

#[tokio::test]
async fn automations_editing_archive_test_run_and_run_log() {
    let c = ctx!();
    c.c(
        "POST",
        "/v1/templates",
        Some(json!({"name": "welcome", "subject": "Hi {{ first_name }}", "html": "<p>Hi</p>"})),
    )
    .await;
    c.c("POST", "/v1/templates/welcome/publish", None).await;
    let tid = c.c("GET", "/v1/templates/welcome", None).await.1["data"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    // a send step may name its template by id as well as alias
    let def = |tpl: &str, delay: &str| {
        json!({"name": "flow", "trigger": "signed_up", "steps": [
        {"key": "pause", "type": "delay", "config": {"duration": delay}, "next": "mail"},
        {"key": "mail", "type": "send_email", "config": {"template": tpl, "from": "hello@example.com"}}]})
    };
    let (s, b) = c.c("POST", "/v1/automations", Some(def(&tid, "1d"))).await;
    assert_eq!(
        (s, b["data"]["status"].as_str()),
        (201, Some("draft")),
        "{b}"
    );
    let id = b["data"]["id"].as_str().unwrap().to_string();

    // editing = installing the same name again: version 2, status untouched
    c.c("POST", &format!("/v1/automations/{id}/publish"), None)
        .await;
    let (s, b) = c
        .c("POST", "/v1/automations", Some(def("welcome", "2d")))
        .await;
    assert_eq!(
        (
            s,
            b["data"]["version"].as_i64(),
            b["data"]["status"].as_str()
        ),
        (201, Some(2), Some("active")),
        "{b}"
    );
    let (_, b) = c.c("GET", &format!("/v1/automations/{id}"), None).await;
    assert_eq!(
        (
            b["data"]["current_version"].as_i64(),
            b["data"]["steps"][1]["config"]["duration"].as_str()
        ),
        (Some(2), Some("2d"))
    );

    // archive: not while live; hidden from the default list; cannot be published or tested; restores as a draft
    let (s, b) = c
        .c("POST", &format!("/v1/automations/{id}/archive"), None)
        .await;
    assert_eq!((s, code(&b)), (409, "invalid_state"));
    c.c("POST", &format!("/v1/automations/{id}/pause"), None)
        .await;
    let (s, b) = c
        .c("POST", &format!("/v1/automations/{id}/archive"), None)
        .await;
    assert_eq!(
        (s, b["data"]["status"].as_str()),
        (200, Some("archived")),
        "{b}"
    );
    assert_eq!(
        c.c("GET", "/v1/automations", None).await.1["data"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let (_, b) = c.c("GET", "/v1/automations?status=archived", None).await;
    assert_eq!(b["data"][0]["id"].as_str(), Some(id.as_str()));
    assert_eq!(
        c.c("POST", &format!("/v1/automations/{id}/publish"), None)
            .await
            .0,
        409
    );
    assert_eq!(
        c.c(
            "POST",
            &format!("/v1/automations/{id}/test"),
            Some(json!({"email": "t@example.com"}))
        )
        .await
        .0,
        409
    );
    let (s, b) = c
        .c("POST", &format!("/v1/automations/{id}/unarchive"), None)
        .await;
    assert_eq!(
        (s, b["data"]["status"].as_str()),
        (200, Some("draft")),
        "{b}"
    );

    // test run: works on a draft, needs send or manage, refuses bad input
    let ro = c.key(&[Scope::Read]).await;
    let url = format!("/v1/automations/{id}/test");
    assert_eq!(
        call(
            &c.app,
            "POST",
            &url,
            Some(&ro),
            Some(json!({"email": "t@example.com"}))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        c.c("POST", &url, Some(json!({"email": "nobody"}))).await.0,
        422
    );
    assert_eq!(
        c.c(
            "POST",
            &url,
            Some(json!({"email": "t@example.com", "bogus": 1}))
        )
        .await
        .0,
        400
    );
    let (s, b) = c
        .c(
            "POST",
            &url,
            Some(json!({"email": "T@Example.com", "properties": {"plan": "pro"}})),
        )
        .await;
    assert_eq!(
        (s, b["data"]["status"].as_str()),
        (202, Some("started")),
        "{b}"
    );
    let run = b["data"]["run_id"].as_str().unwrap().to_string();
    // the engine worker picks it up; the delay parks it
    let engine = mailcraft_automations::Engine::new(
        c.st.db.clone(),
        Arc::new(NoopPersonalizer),
        mailcraft_automations::EngineConfig::default(),
    );
    engine.tick(chrono::Utc::now()).await.unwrap();
    let (_, b) = c
        .c("GET", &format!("/v1/automations/{id}/runs"), None)
        .await;
    assert_eq!(
        (
            b["data"][0]["contact_email"].as_str(),
            b["data"][0]["test"].as_bool(),
            b["data"][0]["current_step"].as_str()
        ),
        (Some("T@example.com"), Some(true), Some("mail"))
    );
    let (s, b) = c
        .c("GET", &format!("/v1/automations/{id}/runs/{run}"), None)
        .await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(b["data"]["steps"][0]["step_key"], "pause");
    assert_eq!(
        c.c(
            "GET",
            &format!("/v1/automations/{id}/runs/{}", Uuid::nil()),
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        c.c(
            "GET",
            &format!("/v1/automations/{id}/runs/not-a-uuid"),
            None
        )
        .await
        .0,
        404
    );
    // fast-forward past the 2 day delay: the mail is queued in the sandbox, no approval needed
    engine
        .tick(chrono::Utc::now() + chrono::Duration::days(3))
        .await
        .unwrap();
    let (_, b) = c
        .c("GET", &format!("/v1/automations/{id}/runs/{run}"), None)
        .await;
    assert_eq!(b["data"]["state"], "completed", "{b}");
    let last = b["data"]["steps"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(
        (
            last["step_key"].as_str(),
            last["result"]["decision"].as_str(),
            last["result"]["status"].as_str()
        ),
        (Some("mail"), Some("enqueued"), Some("queued")),
        "{last}"
    );
    let env: String = sqlx::query_scalar("SELECT env FROM emails WHERE to_addr = 'T@example.com'")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(
        env, "test",
        "a workspace that is not live only has the sandbox"
    );

    // event names for the trigger picker
    c.c(
        "POST",
        "/v1/events",
        Some(json!({"name": "signed_up", "contact": {"email": "e@example.com"}})),
    )
    .await;
    let (s, b) = c.c("GET", "/v1/events/names", None).await;
    assert_eq!(
        (
            s,
            b["data"][0]["name"].as_str(),
            b["data"][0]["count"].as_i64()
        ),
        (200, Some("signed_up"), Some(1)),
        "{b}"
    );
}

#[tokio::test]
async fn domain_verify_stamps_last_checked_and_records_diagnostics() {
    std::env::set_var("MAILCRAFT_PUBLIC_URL", "https://mc.example.net");
    let c = ctx!();
    let (s, b) = c
        .c(
            "POST",
            "/v1/domains",
            Some(json!({"domain": "mail.gaps-test.invalid"})),
        )
        .await;
    if s == 501 {
        eprintln!("no system DNS resolver: domains stay stubbed here");
        return;
    }
    assert_eq!(s, 201, "{b}");
    let id = b["data"]["id"].as_str().unwrap().to_string();
    assert!(b["data"]["last_checked_at"].is_null());
    let (s, b) = c.c("POST", &format!("/v1/domains/{id}/verify"), None).await;
    assert_eq!(s, 200, "{b}");
    assert!(b["data"]["last_checked_at"].is_string(), "{b}");
    let recs = b["data"]["records"].as_array().unwrap();
    assert!(
        recs.iter()
            .all(|r| r["checked_at"].is_string() && r["detail"].is_string()),
        "{b}"
    );
    let (_, g) = c.c("GET", &format!("/v1/domains/{id}"), None).await;
    assert_eq!(g["data"]["last_checked_at"], b["data"]["last_checked_at"]);
    // a wrong record surfaces what DNS returned
    sqlx::query("UPDATE domain_records SET status = 'failed', found = 'v=spf1 -all' WHERE domain_id = $1 AND record = 'SPF'")
        .bind(id.parse::<Uuid>().unwrap()).execute(&c.st.db).await.unwrap();
    let (_, g) = c.c("GET", &format!("/v1/domains/{id}"), None).await;
    assert!(
        g["data"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["found"] == "v=spf1 -all"),
        "{g}"
    );
}

// ----------------------------------------- contacts + segments managed from the dashboard

#[tokio::test]
async fn contact_edit_activity_import_and_suppression_roundtrip() {
    let c = ctx!();
    let (_, b) = c
        .c("PUT", "/v1/contacts", Some(json!({"email": "ann@example.com", "first_name": "Ann", "last_name": "Lee", "timezone": "Europe/Berlin", "properties": {"plan": "free", "seats": 3, "old": true}})))
        .await;
    let id = b["data"]["id"].as_str().unwrap().to_string();

    // PATCH: "" clears, null deletes a property key, omitted fields stay, bad timezone is rejected.
    let (s, b) = c
        .c("PATCH", "/v1/contacts/ann@example.com", Some(json!({"last_name": "", "timezone": "", "properties": {"plan": "pro", "old": null}})))
        .await;
    assert_eq!(s, 200, "{b}");
    let d = &b["data"];
    assert_eq!(
        (
            d["first_name"].as_str(),
            d["last_name"].as_str(),
            d["timezone"].as_str(),
            d["properties"]["plan"].as_str(),
            d["properties"]["seats"].as_i64(),
            d["properties"].get("old").is_some(),
            d["suppressed"].as_bool()
        ),
        (
            Some("Ann"),
            None,
            None,
            Some("pro"),
            Some(3),
            false,
            Some(false)
        ),
        "{b}"
    );
    let (s, b) = c
        .c(
            "PATCH",
            &format!("/v1/contacts/{id}"),
            Some(json!({"timezone": "Mars/Base"})),
        )
        .await;
    assert_eq!((s, code(&b)), (422, "invalid_request"), "{b}");
    assert_eq!(
        c.c(
            "PATCH",
            &format!("/v1/contacts/{id}"),
            Some(json!({"properties": [1]}))
        )
        .await
        .0,
        422
    );
    assert_eq!(
        c.c(
            "PATCH",
            &format!("/v1/contacts/{id}"),
            Some(json!({"email": "x@y.zz"}))
        )
        .await
        .0,
        400,
        "email is not editable"
    );
    let audit = c.c("GET", "/v1/audit?limit=50", None).await.1.to_string();
    assert!(
        audit.contains("contact.update") && !audit.contains("Mars/Base"),
        "audited by field name, never by value"
    );

    // Activity: events, emails (matched by address), runs, topics, segments.
    c.c(
        "POST",
        "/v1/templates",
        Some(json!({"name": "hello", "subject": "Hi", "html": "<p>Hi</p>"})),
    )
    .await;
    c.c("POST", "/v1/templates/hello/publish", None).await;
    let (s, b) = c
        .c("POST", "/v1/automations", Some(json!({"name": "on-signup", "trigger": "signed_up", "steps": [{"key": "mail", "type": "send_email", "config": {"template": "hello"}}]})))
        .await;
    assert_eq!(s, 201, "{b}");
    let aid = b["data"]["id"].as_str().unwrap().to_string();
    c.c("POST", &format!("/v1/automations/{aid}/publish"), None)
        .await;
    let (s, b) = c
        .c("POST", "/v1/events", Some(json!({"name": "signed_up", "contact": {"email": "ann@example.com"}, "properties": {"via": "ui"}})))
        .await;
    assert_eq!(s, 202, "{b}");
    c.email(
        "ann@example.com",
        "me@acme.io",
        "Welcome",
        "transactional",
        "live",
        "2026-10-01T10:00:00Z",
    )
    .await;
    c.email(
        "joann@example.com",
        "me@acme.io",
        "Not Ann",
        "transactional",
        "live",
        "2026-10-02T10:00:00Z",
    )
    .await;
    c.email(
        "a_n@example.com",
        "me@acme.io",
        "Underscore is not a wildcard",
        "transactional",
        "live",
        "2026-10-03T10:00:00Z",
    )
    .await;
    let (_, b) = c
        .c("POST", "/v1/segments", Some(json!({"name": "manual"})))
        .await;
    let sid = b["data"]["id"].as_str().unwrap().to_string();
    c.c(
        "POST",
        &format!("/v1/segments/{sid}/members"),
        Some(json!({"emails": ["ann@example.com"]})),
    )
    .await;
    sqlx::query("INSERT INTO topics (workspace_id, key, name) VALUES ($1,'digest','Digest')")
        .bind(c.ws)
        .execute(&c.st.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO contact_topics (contact_id, topic_id, opted_in) SELECT $1, id, false FROM topics WHERE key = 'digest'")
        .bind(id.parse::<Uuid>().unwrap())
        .execute(&c.st.db)
        .await
        .unwrap();
    let (s, b) = c
        .c("GET", "/v1/contacts/ann@example.com/activity", None)
        .await;
    assert_eq!(s, 200, "{b}");
    let a = &b["data"];
    assert_eq!(
        (
            a["events"][0]["name"].as_str(),
            a["events"][0]["properties"]["via"].as_str(),
            a["emails"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|e| e["subject"].as_str())
                .collect::<Vec<_>>(),
            a["topics"][0]["key"].as_str(),
            a["topics"][0]["opted_in"].as_bool(),
            a["segments"][0]["name"].as_str()
        ),
        (
            Some("signed_up"),
            Some("ui"),
            vec!["Welcome"],
            Some("digest"),
            Some(false),
            Some("manual")
        ),
        "{b}"
    );
    assert_eq!(a["runs"][0]["automation"], "on-signup", "{b}");
    assert_eq!(
        c.c("GET", "/v1/contacts/ghost@example.com/activity", None)
            .await
            .0,
        404
    );

    // Suppression shows up in list + get with its reason, and DELETE /v1/suppressions/{email} undoes it.
    c.c(
        "POST",
        &format!("/v1/contacts/{id}/suppress"),
        Some(json!({"reason": "complaint"})),
    )
    .await;
    let (_, b) = c.c("GET", "/v1/contacts?q=ann@", None).await;
    assert_eq!(
        (
            b["data"][0]["suppressed"].as_bool(),
            b["data"][0]["suppression_reason"].as_str()
        ),
        (Some(true), Some("complaint")),
        "{b}"
    );
    assert_eq!(
        c.c("DELETE", "/v1/suppressions/ann%40example.com", None)
            .await
            .0,
        200
    );
    let (_, b) = c.c("GET", &format!("/v1/contacts/{id}"), None).await;
    assert_eq!(
        (
            b["data"]["suppressed"].as_bool(),
            b["data"]["suppression_reason"].is_null()
        ),
        (Some(false), true),
        "{b}"
    );

    // Import: bad rows are reported by index and skipped; the call is idempotent; limits are enforced.
    let rows = json!({"contacts": [
        {"email": "new1@example.com", "first_name": "N", "properties": {"plan": "pro"}},
        {"email": "not-an-email"},
        {"email": "new2@example.com", "timezone": "Nowhere/Land"},
        {"email": "ann@example.com", "last_name": "Imported"},
    ]});
    let (s, b) = c.c("POST", "/v1/contacts/import", Some(rows)).await;
    assert_eq!(s, 200, "{b}");
    let failed: Vec<_> = b["data"]["failed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["index"].as_i64().unwrap(), f["email"].as_str().unwrap()))
        .collect();
    assert_eq!(
        (b["data"]["imported"].as_i64(), failed),
        (Some(2), vec![(1, "not-an-email"), (2, "new2@example.com")]),
        "{b}"
    );
    let (_, b) = c.c("GET", "/v1/contacts/new1@example.com", None).await;
    assert_eq!(b["data"]["properties"]["plan"], "pro");
    assert_eq!(
        c.c("POST", "/v1/contacts/import", Some(json!({"contacts": []})))
            .await
            .0,
        400
    );
    let many: Vec<_> = (0..5001)
        .map(|i| json!({"email": format!("m{i}@example.com")}))
        .collect();
    let (s, b) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"contacts": many})),
        )
        .await;
    assert_eq!(
        (s, b["error"]["field"].as_str()),
        (400, Some("contacts")),
        "{b}"
    );
    let few: Vec<_> = (0..300)
        .map(|i| json!({"email": format!("b{i}@example.com")}))
        .collect();
    let (s, b) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"contacts": few})),
        )
        .await;
    assert_eq!((s, b["data"]["imported"].as_i64()), (200, Some(300)), "{b}");
    let ro = c.key(&[Scope::Read]).await;
    assert_eq!(
        call(
            &c.app,
            "POST",
            "/v1/contacts/import",
            Some(&ro),
            Some(json!({"contacts": [{"email": "a@b.co"}]}))
        )
        .await
        .0,
        403
    );
}

#[tokio::test]
async fn segment_rules_preview_edit_and_delete() {
    let c = ctx!();
    for (e, plan, n) in [
        ("a@example.com", "pro", 5),
        ("b@example.com", "pro", 1),
        ("c@example.com", "free", 9),
    ] {
        c.c(
            "PUT",
            "/v1/contacts",
            Some(json!({"email": e, "properties": {"plan": plan, "seats": n}})),
        )
        .await;
    }
    // Rules: attribute compare, event_count, days_since (a). a tracked an event 10 days ago.
    c.c(
        "POST",
        "/v1/events",
        Some(json!({"name": "login", "contact": {"email": "a@example.com"}})),
    )
    .await;
    sqlx::query("UPDATE track_events SET received_at = now() - interval '10 days 1 hour'")
        .execute(&c.st.db)
        .await
        .unwrap();
    let pro = json!({"and": [{"field": "properties.plan", "op": "eq", "value": "pro"}, {"field": "properties.seats", "op": "gte", "value": 2}]});
    let (s, b) = c
        .c("POST", "/v1/segments/preview", Some(json!({"filter": pro})))
        .await;
    assert_eq!(
        (
            s,
            b["data"]["count"].as_i64(),
            b["data"]["sample"][0]["email"].as_str()
        ),
        (200, Some(1), Some("a@example.com")),
        "{b}"
    );
    for (rule, want) in [
        (
            json!({"field": "days_since:login", "op": "lte", "value": 14}),
            1,
        ),
        (
            json!({"field": "days_since:login", "op": "lte", "value": 5}),
            0,
        ),
        (
            json!({"or": [{"field": "days_since:login", "op": "exists", "value": false}, {"field": "days_since:login", "op": "gt", "value": 5}]}),
            3,
        ),
        (
            json!({"field": "event_count:login", "op": "gte", "value": 1}),
            1,
        ),
        (
            json!({"field": "email", "op": "contains", "value": "@example.com"}),
            3,
        ),
        (
            json!({"not": {"field": "properties.plan", "op": "eq", "value": "pro"}}),
            1,
        ),
    ] {
        let (s, b) = c
            .c(
                "POST",
                "/v1/segments/preview",
                Some(json!({"filter": rule})),
            )
            .await;
        assert_eq!(
            (s, b["data"]["count"].as_i64()),
            (200, Some(want)),
            "{rule}: {b}"
        );
    }
    // Unsupported fields / shapes are rejected up front, on preview and on save (they would break the poll loop).
    let bad = json!({"field": "contact.plan", "op": "eq", "value": "pro"});
    let (s, b) = c
        .c("POST", "/v1/segments/preview", Some(json!({"filter": bad})))
        .await;
    assert_eq!(
        (s, code(&b), b["error"]["field"].as_str()),
        (422, "invalid_request", Some("filter")),
        "{b}"
    );
    assert_eq!(
        c.c(
            "POST",
            "/v1/segments",
            Some(json!({"name": "bad", "filter": bad}))
        )
        .await
        .0,
        422
    );
    assert_eq!(
        c.c(
            "POST",
            "/v1/segments/preview",
            Some(json!({"filter": {"nope": 1}}))
        )
        .await
        .0,
        400
    );

    // Create, list with a live member_count (no poll has run), edit, rename conflict, make manual.
    let (s, b) = c
        .c(
            "POST",
            "/v1/segments",
            Some(json!({"name": "pros", "filter": pro})),
        )
        .await;
    assert_eq!(s, 201, "{b}");
    let sid = b["data"]["id"].as_str().unwrap().to_string();
    let (_, b) = c
        .c("POST", "/v1/segments", Some(json!({"name": "other"})))
        .await;
    let other = b["data"]["id"].as_str().unwrap().to_string();
    let (_, b) = c.c("GET", "/v1/segments", None).await;
    let counts: Vec<_> = b["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap(),
                s["member_count"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(counts, vec![("other", 0), ("pros", 1)], "{b}");
    let all_pro = json!({"field": "properties.plan", "op": "eq", "value": "pro"});
    let (s, b) = c
        .c(
            "PUT",
            &format!("/v1/segments/{sid}"),
            Some(json!({"name": "  Pros  ", "filter": all_pro})),
        )
        .await;
    assert_eq!((s, b["data"]["name"].as_str()), (200, Some("Pros")), "{b}");
    let (s, b) = c
        .c(
            "PUT",
            &format!("/v1/segments/{other}"),
            Some(json!({"name": "Pros"})),
        )
        .await;
    assert_eq!(
        (s, code(&b), b["error"]["field"].as_str()),
        (409, "invalid_state", Some("name")),
        "{b}"
    );
    assert_eq!(
        c.c(
            "PUT",
            &format!("/v1/segments/{}", Uuid::new_v4()),
            Some(json!({"name": "x"}))
        )
        .await
        .0,
        404
    );
    assert_eq!(
        c.c(
            "PUT",
            &format!("/v1/segments/{sid}"),
            Some(json!({"name": " "}))
        )
        .await
        .0,
        400
    );
    assert_eq!(
        c.c(
            "PUT",
            &format!("/v1/segments/{sid}"),
            Some(json!({"name": "Pros", "filter": bad}))
        )
        .await
        .0,
        422
    );
    let (_, b) = c.c("GET", "/v1/segments", None).await;
    assert_eq!(
        b["data"][0]["member_count"], 2,
        "ordered by name: Pros before other; {b}"
    );
    let (s, b) = c
        .c(
            "PUT",
            &format!("/v1/segments/{sid}"),
            Some(json!({"name": "Pros", "filter": null})),
        )
        .await;
    assert_eq!((s, b["data"]["filter"].is_null()), (200, true), "{b}");
    c.c(
        "PUT",
        &format!("/v1/segments/{sid}"),
        Some(json!({"name": "Pros", "filter": all_pro})),
    )
    .await;

    // Delete is refused while an automation names the segment, by name or by id; fine afterwards.
    let (s, b) = c
        .c("POST", "/v1/automations", Some(json!({"name": "joiner", "trigger": "signed_up", "steps": [{"key": "a", "type": "add_to_segment", "config": {"segment": "Pros"}}]})))
        .await;
    assert_eq!(s, 201, "{b}");
    let aid = b["data"]["id"].as_str().unwrap().to_string();
    let (s, b) = c.c("DELETE", &format!("/v1/segments/{sid}"), None).await;
    assert_eq!((s, code(&b)), (409, "invalid_state"), "{b}");
    assert!(
        b["error"]["message"].as_str().unwrap().contains("joiner"),
        "{b}"
    );
    assert_eq!(
        c.c("DELETE", &format!("/v1/segments/{other}"), None)
            .await
            .0,
        200
    );
    assert_eq!(
        c.c("DELETE", &format!("/v1/segments/{other}"), None)
            .await
            .0,
        404
    );
    sqlx::query("DELETE FROM automations WHERE id = $1::uuid")
        .bind(&aid)
        .execute(&c.st.db)
        .await
        .unwrap();
    assert_eq!(
        c.c("DELETE", &format!("/v1/segments/{sid}"), None).await.0,
        200
    );
    let audit = c.c("GET", "/v1/audit?limit=50", None).await.1.to_string();
    assert!(
        ["segment.create", "segment.update", "segment.delete"]
            .iter()
            .all(|a| audit.contains(a)),
        "{audit}"
    );
    let ro = c.key(&[Scope::Read]).await;
    assert_eq!(
        call(
            &c.app,
            "POST",
            "/v1/segments/preview",
            Some(&ro),
            Some(json!({"filter": all_pro}))
        )
        .await
        .0,
        403
    );
}
