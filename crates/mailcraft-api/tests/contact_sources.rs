//! Contact sources (pull sync) and contact lists. A tiny in-process HTTP server implements the pull
//! contract of `docs/CONTACT-SOURCES.md`. Real Postgres / Redis (MAILCRAFT_TEST_PG / MAILCRAFT_TEST_REDIS);
//! skips when Postgres is unreachable unless MAILCRAFT_REQUIRE_DB=1.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use http_body_util::BodyExt;
use mailcraft_api::{
    keys::{insert_key, CreateKey},
    router, AppState, Config,
};
use mailcraft_automations::NoopPersonalizer;
use mailcraft_core::auth::{KeyEnv, Scope};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use tower::ServiceExt;
use uuid::Uuid;

const KEY: &str = "0909090909090909090909090909090909090909090909090909090909090909";
const SRC_KEY: &str = "sk_live_pull_9f3a7c";

// ------------------------------------------------------------------ harness (as in groups.rs)

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

async fn setup() -> Option<Ctx> {
    let db = fresh_db().await?;
    let ws: Uuid = sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ('t') RETURNING id")
        .fetch_one(&db)
        .await
        .unwrap();
    let url =
        std::env::var("MAILCRAFT_TEST_REDIS").unwrap_or_else(|_| "redis://127.0.0.1:56391".into());
    let redis = match redis::Client::open(url) {
        Ok(c) => c.get_connection_manager().await.ok(),
        Err(_) => None,
    };
    let mut config = Config::from_env();
    config.unsub_secret = b"test-unsub-secret".to_vec();
    let st = AppState::with_services(db.clone(), redis, KEY, config, Arc::new(NoopPersonalizer))
        .unwrap();
    let mut c = db.acquire().await.unwrap();
    let (_, admin) = insert_key(
        &mut c,
        ws,
        &CreateKey {
            name: "admin".into(),
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
        match setup().await {
            Some(c) => c,
            None => return,
        }
    };
}

impl Ctx {
    async fn c(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let (s, t) = self.raw(method, path, Some(&self.admin), body).await;
        (s, serde_json::from_str(&t).unwrap_or(Value::Null))
    }
    async fn raw(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (u16, String) {
        let mut b = Request::builder().method(method).uri(path);
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        let req = match body {
            Some(v) => b
                .header("content-type", "application/json")
                .body(Body::from(v.to_string()))
                .unwrap(),
            None => b.body(Body::empty()).unwrap(),
        };
        let res = self.app.clone().oneshot(req).await.unwrap();
        let s = res.status().as_u16();
        (
            s,
            String::from_utf8_lossy(&res.into_body().collect().await.unwrap().to_bytes())
                .into_owned(),
        )
    }
    async fn n(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .fetch_one(&self.st.db)
            .await
            .unwrap()
    }
    /// Registers a source for the mock at `url` and returns its id.
    async fn add_source(&self, name: &str, url: &str) -> Uuid {
        let (s, b) = self
            .c(
                "POST",
                "/v1/contact-sources",
                Some(json!({"name": name, "url": url, "key": SRC_KEY})),
            )
            .await;
        assert_eq!(s, 201, "{b}");
        b["data"]["id"].as_str().unwrap().parse().unwrap()
    }
    async fn sync(&self, id: Uuid) -> Value {
        let (s, b) = self
            .c("POST", &format!("/v1/contact-sources/{id}/sync"), None)
            .await;
        assert_eq!(s, 200, "{b}");
        b["data"].clone()
    }
    async fn source(&self, id: Uuid) -> Value {
        self.c("GET", &format!("/v1/contact-sources/{id}"), None)
            .await
            .1["data"]
            .clone()
    }
    async fn contact(&self, email: &str) -> Value {
        self.c("GET", &format!("/v1/contacts/{email}"), None)
            .await
            .1["data"]
            .clone()
    }
}

fn code(b: &Value) -> &str {
    b["error"]["code"].as_str().unwrap_or("")
}

// ------------------------------------------------------------------ the mock source

#[derive(Clone)]
struct SrcRow {
    external_id: String,
    email: String,
    first_name: Option<String>,
    timezone: Option<String>,
    updated_at: DateTime<Utc>,
    deleted: bool,
    properties: Value,
}

fn ago(minutes: i64) -> DateTime<Utc> {
    Utc::now() - Duration::minutes(minutes)
}

fn row(ext: &str, email: &str, updated: DateTime<Utc>) -> SrcRow {
    SrcRow {
        external_id: ext.into(),
        email: email.into(),
        first_name: Some(format!("User {ext}")),
        timezone: Some("Asia/Kolkata".into()),
        updated_at: updated,
        deleted: false,
        properties: json!({"plan": "free"}),
    }
}

struct Src {
    key: String,
    rows: Vec<SrcRow>,
    /// At most this many rows per page, whatever `limit` asks.
    page_size: usize,
    status: Option<u16>,
    content_type: &'static str,
    redirect_to: Option<String>,
    /// Answer this many requests with 429 (`Retry-After: 0`) before behaving.
    rate_limit: u32,
    /// Query strings of every request, for assertions on `updated_since`.
    seen: Vec<HashMap<String, String>>,
}

type Shared = Arc<Mutex<Src>>;

async fn contacts(
    State(s): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let mut s = s.lock().unwrap();
    s.seen.push(q.clone());
    if let Some(to) = &s.redirect_to {
        return (StatusCode::FOUND, [(header::LOCATION, to.clone())]).into_response();
    }
    if headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ") == Some(s.key.as_str()))
        != Some(true)
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Some(code) = s.status {
        return StatusCode::from_u16(code).unwrap().into_response();
    }
    if s.rate_limit > 0 {
        s.rate_limit -= 1;
        return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "0")]).into_response();
    }
    let since = q
        .get("updated_since")
        .map(|v| DateTime::parse_from_rfc3339(v).unwrap().with_timezone(&Utc));
    let mut rows: Vec<&SrcRow> = s
        .rows
        .iter()
        .filter(|r| since.is_none_or(|t| r.updated_at >= t))
        .collect();
    rows.sort_by(|a, b| (a.updated_at, &a.external_id).cmp(&(b.updated_at, &b.external_id)));
    let from: usize = q
        .get("cursor")
        .map(|c| c.trim_start_matches('c').parse().unwrap())
        .unwrap_or(0);
    let limit: usize = q.get("limit").map_or(500, |l| l.parse().unwrap());
    let take = limit.min(s.page_size);
    let page: Vec<Value> = rows
        .iter()
        .skip(from)
        .take(take)
        .map(|r| {
            json!({
                "external_id": r.external_id, "email": r.email, "first_name": r.first_name,
                "last_name": null, "timezone": r.timezone, "created_at": r.updated_at,
                "updated_at": r.updated_at, "deleted": r.deleted, "properties": r.properties,
            })
        })
        .collect();
    let next = (from + take < rows.len()).then(|| format!("c{}", from + take));
    (
        [(header::CONTENT_TYPE, s.content_type)],
        Json(json!({"data": page, "next_cursor": next, "synced_at": Utc::now()})),
    )
        .into_response()
}

async fn spawn(rows: Vec<SrcRow>) -> (Shared, String) {
    let src: Shared = Arc::new(Mutex::new(Src {
        key: SRC_KEY.into(),
        rows,
        page_size: 2,
        status: None,
        content_type: "application/json",
        redirect_to: None,
        rate_limit: 0,
        seen: vec![],
    }));
    let app = Router::new()
        .route("/contacts", get(contacts))
        .with_state(src.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/contacts", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (src, url)
}

// ------------------------------------------------------------------ sync

#[tokio::test]
async fn sync_pages_through_the_source_into_its_list_and_never_duplicates() {
    let c = ctx!();
    let rows = (1..=5)
        .map(|i| row(&i.to_string(), &format!("u{i}@x.io"), ago(100 - i)))
        .collect();
    let (src, url) = spawn(rows).await;
    let id = c.add_source("Acme", &url).await;

    let r = c.sync(id).await;
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["counts"]["created"], 5);
    assert_eq!(r["counts"]["fetched"], 5);
    assert_eq!(src.lock().unwrap().seen.len(), 3, "5 rows at 2 per page");
    // cursor and limit are what the contract says
    let seen = src.lock().unwrap().seen.clone();
    assert_eq!(seen[0]["limit"], "500");
    assert!(!seen[0].contains_key("cursor") && !seen[0].contains_key("updated_since"));
    assert_eq!(seen[1]["cursor"], "c2");

    let s = c.source(id).await;
    assert_eq!(
        (s["last_status"].as_str(), s["list"]["name"].as_str()),
        (Some("ok"), Some("Acme"))
    );
    assert_eq!(s["last_counts"]["created"], 5);
    assert!(s["watermark"].is_string());
    assert!(!s.to_string().contains(SRC_KEY), "the key is write-only");

    // the source's list holds all five, tagged with where they came from
    let (_, l) = c.c("GET", "/v1/lists", None).await;
    let list = &l["data"][0];
    assert_eq!(
        (
            list["origin"].as_str(),
            list["member_count"].as_i64(),
            list["detached"].as_bool()
        ),
        (Some("source"), Some(5), Some(false))
    );
    let ct = c.contact("u3@x.io").await;
    assert_eq!(ct["lists"][0]["name"], "Acme");
    assert_eq!(ct["timezone"], "Asia/Kolkata");
    assert_eq!(ct["properties"]["plan"], "free");
    let (_, only) = c
        .c(
            "GET",
            &format!("/v1/contacts?list={}", list["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(only["data"].as_array().unwrap().len(), 5);

    // the next run is incremental and finds nothing new...
    assert_eq!(c.sync(id).await["counts"]["fetched"], 0);
    // ...a full read (due once a day) updates in place
    sqlx::query("UPDATE contact_sources SET last_full_at = now() - interval '25 hours'")
        .execute(&c.st.db)
        .await
        .unwrap();
    let r = c.sync(id).await;
    assert_eq!(
        (
            r["counts"]["created"].as_i64(),
            r["counts"]["updated"].as_i64()
        ),
        (Some(0), Some(5))
    );
    assert_eq!(c.n("SELECT count(*) FROM contacts").await, 5);
    assert_eq!(c.n("SELECT count(*) FROM segment_members").await, 5);
}

#[tokio::test]
async fn next_run_reads_from_the_sources_clock_minus_five_minutes() {
    let c = ctx!();
    let (src, url) = spawn(vec![
        row("1", "a@x.io", ago(60)),
        row("2", "b@x.io", ago(30)),
    ])
    .await;
    let id = c.add_source("Acme", &url).await;
    let before = Utc::now();
    c.sync(id).await;
    // a finished run resumes from the source's own clock at its start (`synced_at`), not from the
    // newest row: fields that change without touching updated_at are why
    let wm: DateTime<Utc> =
        serde_json::from_value(c.source(id).await["watermark"].clone()).unwrap();
    assert!(
        wm >= before && wm <= Utc::now(),
        "{wm} is the mock's synced_at"
    );

    src.lock().unwrap().seen.clear();
    {
        let mut s = src.lock().unwrap();
        s.rows.push(row("3", "c@x.io", ago(1)));
        s.rows[1].properties = json!({"plan": "pro"}); // older than the window: not re-read
    }
    let r = c.sync(id).await;
    let since: DateTime<Utc> = src.lock().unwrap().seen[0]["updated_since"]
        .parse()
        .unwrap();
    assert!(
        (wm - Duration::minutes(5) - since).num_seconds().abs() <= 1,
        "{since} vs {wm}"
    );
    assert_eq!(
        (
            r["counts"]["created"].as_i64(),
            r["counts"]["updated"].as_i64()
        ),
        (Some(1), Some(0)),
        "{r}"
    );
    assert_eq!(c.contact("b@x.io").await["properties"]["plan"], "free");
}

#[tokio::test]
async fn a_run_cut_short_resumes_from_the_newest_row_it_saw() {
    let c = ctx!();
    let rows = (1..=5)
        .map(|i| row(&i.to_string(), &format!("u{i}@x.io"), ago(100 - i)))
        .collect();
    let (_src, url) = spawn(rows).await;
    let id = c.add_source("Acme", &url).await;
    // stop after the first page (2 of 5 rows), as at shutdown or a row cap
    let run = mailcraft_api::contact_sources::run_source(&c.st, id, &|| true)
        .await
        .unwrap()
        .unwrap();
    assert!(run.ok);
    assert_eq!(run.counts.fetched, 2);
    let wm: DateTime<Utc> =
        serde_json::from_value(c.source(id).await["watermark"].clone()).unwrap();
    assert!(
        (wm - ago(98)).num_seconds().abs() < 120,
        "newest of the 2 rows read, not the source clock: {wm}"
    );
    assert_eq!(
        c.source(id).await["last_full_at"],
        Value::Null,
        "not a complete read"
    );
    // no full read has completed yet, so the next run reads everything
    let r = c.sync(id).await;
    assert_eq!(r["counts"]["created"], 3, "{r}");
    assert_eq!(c.n("SELECT count(*) FROM contacts").await, 5);
}

#[tokio::test]
async fn source_keys_overwrite_but_user_keys_survive_and_email_changes_follow_the_person() {
    let c = ctx!();
    let (src, url) = spawn(vec![
        row("1", "ana@x.io", ago(50)),
        row("2", "bo@x.io", ago(49)),
    ])
    .await;
    let id = c.add_source("Acme", &url).await;
    c.sync(id).await;
    let ana = c.contact("ana@x.io").await;
    // the operator adds their own attribute
    let (s, _) = c
        .c(
            "PATCH",
            &format!("/v1/contacts/{}", ana["id"].as_str().unwrap()),
            Some(json!({"properties": {"vip": true}})),
        )
        .await;
    assert_eq!(s, 200);

    {
        let mut s = src.lock().unwrap();
        s.rows[0].properties = json!({"plan": "pro"});
        s.rows[0].updated_at = ago(2);
        // bo moves to a free address; ana's new address already belongs to someone else
        s.rows[1].email = "bo.new@x.io".into();
        s.rows[1].updated_at = ago(2);
    }
    let r = c.sync(id).await;
    assert_eq!(r["counts"]["created"], 0, "{r}");
    let ana2 = c.contact("ana@x.io").await;
    assert_eq!(ana2["id"], ana["id"]);
    assert_eq!(
        (
            ana2["properties"]["plan"].as_str(),
            ana2["properties"]["vip"].as_bool()
        ),
        (Some("pro"), Some(true))
    );
    assert_eq!(c.contact("bo.new@x.io").await["first_name"], "User 2");
    assert_eq!(
        c.n("SELECT count(*) FROM contacts WHERE email = 'bo@x.io'")
            .await,
        0
    );
    assert_eq!(c.n("SELECT count(*) FROM contacts").await, 2);

    // now ana's address changes to one another contact has: the old address stays, the rest still syncs
    c.c("PUT", "/v1/contacts", Some(json!({"email": "taken@x.io"})))
        .await;
    {
        let mut s = src.lock().unwrap();
        s.rows[0].email = "taken@x.io".into();
        s.rows[0].properties = json!({"plan": "team"});
        s.rows[0].updated_at = ago(1);
    }
    let r = c.sync(id).await;
    assert_eq!(r["counts"]["reasons"]["email_conflict"], 1, "{r}");
    assert_eq!(c.contact("ana@x.io").await["properties"]["plan"], "team");
    assert_eq!(
        c.contact("taken@x.io").await["lists"],
        json!([]),
        "the other contact is left alone"
    );
}

#[tokio::test]
async fn an_existing_contact_is_adopted_by_email_and_a_second_owner_is_refused() {
    let c = ctx!();
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "old@x.io", "first_name": "Imported"})),
    )
    .await;
    let (src, url) = spawn(vec![
        row("1", "old@x.io", ago(10)),
        row("2", "other@x.io", ago(9)),
    ])
    .await;
    let id = c.add_source("Acme", &url).await;
    let r = c.sync(id).await;
    assert_eq!(
        (
            r["counts"]["created"].as_i64(),
            r["counts"]["updated"].as_i64()
        ),
        (Some(1), Some(1)),
        "{r}"
    );
    assert_eq!(c.n("SELECT count(*) FROM contacts").await, 2);
    // a different source id with the same address does not steal it
    src.lock().unwrap().rows.push(row("99", "old@x.io", ago(1)));
    let r = c.sync(id).await;
    assert_eq!(r["counts"]["reasons"]["duplicate_email"], 1, "{r}");
    assert_eq!(
        c.n("SELECT count(*) FROM contacts WHERE external_id = '1'")
            .await,
        1
    );
}

#[tokio::test]
async fn deleted_rows_suppress_and_a_suppression_is_never_cleared() {
    let c = ctx!();
    let (src, url) = spawn(vec![
        row("1", "gone@x.io", ago(50)),
        row("2", "optout@x.io", ago(49)),
        row("3", "stay@x.io", ago(48)),
    ])
    .await;
    let id = c.add_source("Acme", &url).await;
    c.sync(id).await;
    // optout@ unsubscribed in mailcraft
    let (s, _) = c
        .c(
            "POST",
            "/v1/contacts/optout@x.io/suppress",
            Some(json!({"reason": "unsubscribe"})),
        )
        .await;
    assert_eq!(s, 200);

    {
        let mut s = src.lock().unwrap();
        s.rows[0].deleted = true;
        s.rows[0].updated_at = ago(2);
        s.rows[1].first_name = Some("Renamed".into()); // still live in the source
        s.rows[1].updated_at = ago(2);
        s.rows.push({
            let mut r = row("4", "never-seen@x.io", ago(2));
            r.deleted = true;
            r
        });
    }
    let r = c.sync(id).await;
    assert_eq!(
        (
            r["counts"]["deleted"].as_i64(),
            r["counts"]["skipped"].as_i64()
        ),
        (Some(1), Some(1)),
        "{r}"
    );
    assert_eq!(r["counts"]["reasons"]["deleted_unknown"], 1);
    let gone = c.contact("gone@x.io").await;
    assert_eq!(
        (
            gone["suppressed"].as_bool(),
            gone["suppression_reason"].as_str()
        ),
        (Some(true), Some("source_deleted")),
        "kept, not hard-deleted"
    );
    let opt = c.contact("optout@x.io").await;
    assert_eq!(opt["first_name"], "Renamed");
    assert_eq!(
        (
            opt["suppressed"].as_bool(),
            opt["suppression_reason"].as_str()
        ),
        (Some(true), Some("unsubscribe")),
        "still opted out"
    );
    assert_eq!(c.contact("stay@x.io").await["suppressed"], false);
    assert_eq!(
        c.n("SELECT count(*) FROM contacts WHERE email = 'never-seen@x.io'")
            .await,
        0
    );
}

#[tokio::test]
async fn a_changed_address_inherits_the_old_opt_out() {
    let c = ctx!();
    let (src, url) = spawn(vec![row("1", "before@x.io", ago(50))]).await;
    let id = c.add_source("Acme", &url).await;
    c.sync(id).await;
    c.c(
        "POST",
        "/v1/contacts/before@x.io/suppress",
        Some(json!({"reason": "unsubscribe"})),
    )
    .await;
    {
        let mut s = src.lock().unwrap();
        s.rows[0].email = "after@x.io".into();
        s.rows[0].updated_at = ago(1);
    }
    c.sync(id).await;
    let after = c.contact("after@x.io").await;
    assert_eq!(
        (
            after["suppressed"].as_bool(),
            after["suppression_reason"].as_str()
        ),
        (Some(true), Some("unsubscribe"))
    );
}

#[tokio::test]
async fn bad_rows_are_counted_not_fatal() {
    let c = ctx!();
    let mut bad_tz = row("2", "tz@x.io", ago(40));
    bad_tz.timezone = Some("Mars/Olympus".into());
    bad_tz.properties = json!({"timezone": "Nowhere/Land", "plan": "pro"});
    let (src, url) = spawn(vec![
        row("1", "not-an-email", ago(41)),
        bad_tz,
        row("3", "ok@x.io", ago(39)),
    ])
    .await;
    src.lock().unwrap().page_size = 10;
    let id = c.add_source("Acme", &url).await;
    let r = c.sync(id).await;
    assert_eq!(r["ok"], true, "{r}");
    let k = &r["counts"];
    assert_eq!(
        (k["created"].as_i64(), k["skipped"].as_i64()),
        (Some(2), Some(1)),
        "{r}"
    );
    assert_eq!(k["reasons"]["invalid_email"], 1);
    assert_eq!(
        k["reasons"]["invalid_timezone"], 2,
        "top-level and properties.timezone"
    );
    let tz = c.contact("tz@x.io").await;
    assert_eq!(
        tz["timezone"],
        Value::Null,
        "the contact is kept, the bad zone dropped"
    );
    assert_eq!(tz["properties"]["plan"], "pro");
    assert_eq!(c.contact("ok@x.io").await["timezone"], "Asia/Kolkata");
}

#[tokio::test]
async fn a_rejected_key_and_a_down_source_are_recorded_and_the_watermark_stays() {
    let c = ctx!();
    let (src, url) = spawn(vec![row("1", "a@x.io", ago(30))]).await;
    let id = c.add_source("Acme", &url).await;
    c.sync(id).await;
    let wm = c.source(id).await["watermark"].clone();
    assert!(wm.is_string());

    src.lock().unwrap().key = "rotated-elsewhere".into();
    src.lock().unwrap().rows.push(row("2", "b@x.io", ago(1)));
    let r = c.sync(id).await;
    assert_eq!(r["ok"], false);
    assert!(
        r["error"]
            .as_str()
            .unwrap()
            .contains("rejected the API key"),
        "{r}"
    );
    let s = c.source(id).await;
    assert_eq!(
        (s["last_status"].as_str(), s["watermark"].clone()),
        (Some("error"), wm.clone())
    );
    assert!(s["last_error"].as_str().unwrap().contains("401"));
    assert!(!s.to_string().contains(SRC_KEY));

    {
        let mut s = src.lock().unwrap();
        s.key = SRC_KEY.into();
        s.status = Some(503);
    }
    let r = c.sync(id).await;
    assert!(r["error"].as_str().unwrap().contains("unavailable"), "{r}");
    assert_eq!(c.source(id).await["watermark"], wm);
    assert_eq!(
        c.n("SELECT count(*) FROM contacts").await,
        1,
        "nothing partial"
    );

    // back up: the missed row arrives and the error clears
    src.lock().unwrap().status = None;
    let r = c.sync(id).await;
    assert_eq!(
        (r["ok"].as_bool(), r["counts"]["created"].as_i64()),
        (Some(true), Some(1))
    );
    assert_eq!(c.source(id).await["last_error"], Value::Null);
}

#[tokio::test]
async fn non_json_and_redirects_to_another_origin_are_refused() {
    let c = ctx!();
    let (src, url) = spawn(vec![row("1", "a@x.io", ago(5))]).await;
    let id = c.add_source("Acme", &url).await;
    src.lock().unwrap().content_type = "text/html";
    let r = c.sync(id).await;
    assert!(r["error"].as_str().unwrap().contains("JSON"), "{r}");

    src.lock().unwrap().content_type = "application/json";
    src.lock().unwrap().redirect_to = Some("http://127.0.0.1:9/elsewhere".into());
    let r = c.sync(id).await;
    assert!(r["error"].as_str().unwrap().contains("redirect"), "{r}");
    assert_eq!(c.n("SELECT count(*) FROM contacts").await, 0);
}

#[tokio::test]
async fn test_endpoint_reports_the_shape_and_writes_nothing() {
    let c = ctx!();
    let (src, url) = spawn(vec![row("1", "a@x.io", ago(5)), row("2", "b@x.io", ago(4))]).await;
    let (s, b) = c
        .c(
            "POST",
            "/v1/contact-sources/test",
            Some(json!({"url": url, "key": SRC_KEY})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let d = &b["data"];
    assert_eq!(
        (
            d["ok"].as_bool(),
            d["sample_count"].as_i64(),
            d["has_more"].as_bool()
        ),
        (Some(true), Some(1), Some(true)),
        "{b}"
    );
    assert!(d["fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "external_id"));
    assert_eq!(d["property_keys"], json!(["plan"]));
    assert_eq!(src.lock().unwrap().seen[0]["limit"], "1");
    assert_eq!(
        c.n("SELECT count(*) FROM contacts").await
            + c.n("SELECT count(*) FROM contact_sources").await,
        0
    );

    let (_, b) = c
        .c(
            "POST",
            "/v1/contact-sources/test",
            Some(json!({"url": url, "key": "wrong"})),
        )
        .await;
    assert_eq!(b["data"]["ok"], false);
    assert!(b["data"]["error"].as_str().unwrap().contains("API key"));
    let (s, b) = c
        .c(
            "POST",
            "/v1/contact-sources/test",
            Some(json!({"url": "ftp://x/y", "key": "k"})),
        )
        .await;
    assert_eq!((s, code(&b)), (400, "invalid_request"));

    // an existing source can be tested with its stored key
    let id = c.add_source("Acme", &url).await;
    let (_, b) = c
        .c("POST", "/v1/contact-sources/test", Some(json!({"id": id})))
        .await;
    assert_eq!(b["data"]["ok"], true, "{b}");
}

// ------------------------------------------------------------------ sources crud

#[tokio::test]
async fn source_crud_key_rotation_secrecy_and_audit() {
    let c = ctx!();
    let (src, url) = spawn(vec![row("1", "a@x.io", ago(5))]).await;
    let id = c.add_source("Acme", &url).await;

    let (s, b) = c
        .c(
            "POST",
            "/v1/contact-sources",
            Some(json!({"name": "Acme", "url": url, "key": "k"})),
        )
        .await;
    assert_eq!((s, code(&b)), (409, "invalid_state"), "names are unique");
    let (s, _) = c
        .c(
            "POST",
            "/v1/contact-sources",
            Some(json!({"name": "x", "url": url, "key": "k", "interval_minutes": 0})),
        )
        .await;
    assert_eq!(s, 400);
    let (s, _) = c
        .c(
            "POST",
            "/v1/contact-sources",
            Some(json!({"name": "x", "url": url})),
        )
        .await;
    assert_eq!(s, 400, "key is required");
    let (s, _) = c.raw("GET", "/v1/contact-sources", None, None).await;
    assert_eq!(s, 401);
    let read_only = {
        let mut conn = c.st.db.acquire().await.unwrap();
        insert_key(
            &mut conn,
            c.ws,
            &CreateKey {
                name: "ro".into(),
                env: KeyEnv::Live,
                scopes: vec![Scope::Read],
                domain_id: None,
                policy: None,
                recipient_allowlist: None,
                daily_send_cap: None,
                minute_send_cap: None,
                expires_at: None,
            },
        )
        .await
        .unwrap()
        .1
    };
    let (s, _) = c
        .raw("GET", "/v1/contact-sources", Some(&read_only), None)
        .await;
    assert_eq!(s, 403, "manage scope");

    let (_, l) = c.c("GET", "/v1/contact-sources", None).await;
    assert_eq!(l["data"].as_array().unwrap().len(), 1);

    // the key is stored sealed, never in a response or the audit log
    let enc: Vec<u8> = sqlx::query_scalar("SELECT key_enc FROM contact_sources")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&enc).contains(SRC_KEY));
    let audit: String =
        sqlx::query_scalar("SELECT coalesce(string_agg(args::text, ' '), '') FROM audit_log")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert!(!audit.contains(SRC_KEY));

    // rotate: the old key stops working at the source, the new one is picked up
    src.lock().unwrap().key = "new-key-1".into();
    assert_eq!(c.sync(id).await["ok"], false);
    let (s, b) = c
        .c(
            "PATCH",
            &format!("/v1/contact-sources/{id}"),
            Some(json!({"key": "new-key-1", "interval_minutes": 5, "enabled": false})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(
        (
            b["data"]["interval_minutes"].as_i64(),
            b["data"]["enabled"].as_bool()
        ),
        (Some(5), Some(false))
    );
    assert!(!b.to_string().contains("new-key-1"));
    assert_eq!(
        c.sync(id).await["ok"],
        true,
        "a disabled source can still be synced by hand"
    );

    // changing the URL starts over
    let (_, b) = c
        .c(
            "PATCH",
            &format!("/v1/contact-sources/{id}"),
            Some(json!({"url": format!("{url}?x=1")})),
        )
        .await;
    assert_eq!(b["data"]["watermark"], Value::Null);

    let (s, _) = c
        .c(
            "GET",
            &format!("/v1/contact-sources/{}", Uuid::new_v4()),
            None,
        )
        .await;
    assert_eq!(s, 404);
    let actions = sqlx::query_scalar::<_, String>("SELECT action FROM audit_log ORDER BY id")
        .fetch_all(&c.st.db)
        .await
        .unwrap();
    for a in [
        "contact_source.create",
        "contact_source.update",
        "contact_source.sync",
    ] {
        assert!(actions.iter().any(|x| x == a), "{a} in {actions:?}");
    }

    let (s, _) = c
        .c("DELETE", &format!("/v1/contact-sources/{id}"), None)
        .await;
    assert_eq!(s, 200);
    assert!(
        sqlx::query_scalar::<_, String>("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_one(&c.st.db)
            .await
            .unwrap()
            == "contact_source.delete"
    );
}

#[tokio::test]
async fn deleting_a_source_keeps_contacts_and_detaches_or_drops_its_list() {
    let c = ctx!();
    let (_src, url) = spawn(vec![row("1", "a@x.io", ago(5)), row("2", "b@x.io", ago(4))]).await;
    let id = c.add_source("Acme", &url).await;
    c.sync(id).await;
    c.c(
        "POST",
        "/v1/contacts/b@x.io/suppress",
        Some(json!({"reason": "manual"})),
    )
    .await;
    let (_, l) = c.c("GET", "/v1/lists", None).await;
    let list_id = l["data"][0]["id"].as_str().unwrap().to_string();

    // a source's list cannot be deleted from under it
    let (s, b) = c.c("DELETE", &format!("/v1/lists/{list_id}"), None).await;
    assert_eq!((s, code(&b)), (409, "invalid_state"));

    // default: keep the list, detached
    let (s, b) = c
        .c("DELETE", &format!("/v1/contact-sources/{id}"), None)
        .await;
    assert_eq!(
        (s, b["data"]["list_deleted"].as_bool()),
        (200, Some(false)),
        "{b}"
    );
    let (_, l) = c.c("GET", &format!("/v1/lists/{list_id}"), None).await;
    assert_eq!(
        (
            l["data"]["detached"].as_bool(),
            l["data"]["origin"].as_str(),
            l["data"]["member_count"].as_i64()
        ),
        (Some(true), Some("source"), Some(2))
    );
    assert_eq!(l["data"]["source_id"], Value::Null);
    assert_eq!(c.n("SELECT count(*) FROM contacts WHERE external_source_id IS NOT NULL OR external_id IS NOT NULL").await, 0);
    assert_eq!(c.contact("b@x.io").await["suppressed"], true);
    // a detached list is an ordinary list: it can be renamed and deleted (contacts stay)
    let (s, b) = c
        .c(
            "PATCH",
            &format!("/v1/lists/{list_id}"),
            Some(json!({"name": "Old Acme users", "description": "kept"})),
        )
        .await;
    assert_eq!(
        (s, b["data"]["name"].as_str()),
        (200, Some("Old Acme users")),
        "{b}"
    );

    // the other way: drop the list with the source
    let id2 = c.add_source("Second", &url).await;
    c.sync(id2).await;
    let (_, b) = c
        .c(
            "DELETE",
            &format!("/v1/contact-sources/{id2}?delete_list=true"),
            None,
        )
        .await;
    assert_eq!(b["data"]["list_deleted"], true);
    assert_eq!(
        c.n("SELECT count(*) FROM segments WHERE name = 'Second'")
            .await,
        0
    );
    assert_eq!(
        c.n("SELECT count(*) FROM contacts").await,
        2,
        "contacts stay"
    );
}

#[tokio::test]
async fn a_renamed_source_list_keeps_receiving_and_a_taken_name_is_numbered() {
    let c = ctx!();
    c.c("POST", "/v1/lists", Some(json!({"name": "Acme"})))
        .await;
    let (_s, url) = spawn(vec![row("1", "a@x.io", ago(5))]).await;
    let id = c.add_source("Acme", &url).await;
    let s = c.source(id).await;
    assert_eq!(s["list"]["name"], "Acme (2)");
    let list_id = s["list"]["id"].as_str().unwrap();
    let (st, _) = c
        .c(
            "PATCH",
            &format!("/v1/lists/{list_id}"),
            Some(json!({"name": "Acme users"})),
        )
        .await;
    assert_eq!(st, 200);
    c.sync(id).await;
    assert_eq!(c.contact("a@x.io").await["lists"][0]["name"], "Acme users");
    // a custom list name at creation
    let (st, b) = c
        .c(
            "POST",
            "/v1/contact-sources",
            Some(json!({"name": "Other", "url": url, "key": "k", "list_name": "Customers"})),
        )
        .await;
    assert_eq!(
        (st, b["data"]["list"]["name"].as_str()),
        (201, Some("Customers")),
        "{b}"
    );
}

#[tokio::test]
async fn one_run_at_a_time_per_source() {
    let c = ctx!();
    let (_s, url) = spawn(vec![row("1", "a@x.io", ago(5))]).await;
    let id = c.add_source("Acme", &url).await;
    // another instance holds the source
    let mut other = c.st.db.acquire().await.unwrap().detach();
    let got: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_lock(hashtextextended('contact_source:' || $1::text, 0))",
    )
    .bind(id)
    .fetch_one(&mut other)
    .await
    .unwrap();
    assert!(got);
    let (s, b) = c
        .c("POST", &format!("/v1/contact-sources/{id}/sync"), None)
        .await;
    assert_eq!((s, code(&b)), (409, "sync_in_progress"));
    drop(other); // session ends, lock released
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(c.sync(id).await["ok"], true);
}

#[tokio::test]
async fn the_background_loop_runs_due_sources_only() {
    let c = ctx!();
    let (_s, url) = spawn(vec![row("1", "a@x.io", ago(5))]).await;
    let due = c.add_source("Due", &url).await;
    let off = c.add_source("Off", &url).await;
    c.c(
        "PATCH",
        &format!("/v1/contact-sources/{off}"),
        Some(json!({"enabled": false})),
    )
    .await;
    let (stop, rx) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(mailcraft_api::contact_sources::run_loop(c.st.clone(), rx));
    let mut ran = false;
    for _ in 0..50 {
        if c.source(due).await["last_status"] == "ok" {
            ran = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    stop.send(true).unwrap();
    task.await.unwrap();
    assert!(ran, "the loop ran the due source");
    assert_eq!(c.source(off).await["last_run_at"], Value::Null);
    // not due again until its interval has passed
    let first = c.source(due).await["last_run_at"].clone();
    let (stop, rx) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(mailcraft_api::contact_sources::run_loop(c.st.clone(), rx));
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    stop.send(true).unwrap();
    task.await.unwrap();
    assert_eq!(c.source(due).await["last_run_at"], first);
}

// ------------------------------------------------------------------ lists

#[tokio::test]
async fn lists_crud_members_and_deleting_a_list_keeps_contacts_and_suppressions() {
    let c = ctx!();
    let (s, b) = c
        .c(
            "POST",
            "/v1/lists",
            Some(json!({"name": "  Webinar Oct 2026 ", "description": "attendees"})),
        )
        .await;
    assert_eq!(s, 201, "{b}");
    let id = b["data"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        (
            b["data"]["name"].as_str(),
            b["data"]["origin"].as_str(),
            b["data"]["member_count"].as_i64()
        ),
        (Some("Webinar Oct 2026"), Some("manual"), Some(0))
    );
    let (s, b) = c
        .c(
            "POST",
            "/v1/lists",
            Some(json!({"name": "Webinar Oct 2026"})),
        )
        .await;
    assert_eq!((s, code(&b)), (409, "invalid_state"));
    assert_eq!(
        c.c("POST", "/v1/lists", Some(json!({"name": " "}))).await.0,
        400
    );

    // add by email (creates the contact) and by id
    let (_, ana) = c
        .c("PUT", "/v1/contacts", Some(json!({"email": "ana@x.io"})))
        .await;
    let ana_id = ana["data"]["id"].as_str().unwrap().to_string();
    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/lists/{id}/members"),
            Some(json!({"contact_ids": [ana_id, ana_id, Uuid::new_v4()], "emails": ["new@x.io"]})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(
        (
            b["data"]["added"].as_i64(),
            b["data"]["not_found"].as_i64(),
            b["data"]["already_members"].as_i64()
        ),
        (Some(2), Some(1), Some(0))
    );
    let (_, b) = c
        .c(
            "POST",
            &format!("/v1/lists/{id}/members"),
            Some(json!({"emails": ["ana@x.io"]})),
        )
        .await;
    assert_eq!(
        (
            b["data"]["added"].as_i64(),
            b["data"]["already_members"].as_i64()
        ),
        (Some(0), Some(1))
    );
    assert_eq!(
        c.c("POST", &format!("/v1/lists/{id}/members"), Some(json!({})))
            .await
            .0,
        400
    );

    // the contact filter, the badge data and the rule field
    let (_, p) = c.c("GET", &format!("/v1/contacts?list={id}"), None).await;
    assert_eq!(p["data"].as_array().unwrap().len(), 2);
    let (_, p) = c
        .c("GET", "/v1/contacts?list=Webinar%20Oct%202026", None)
        .await;
    assert_eq!(p["data"].as_array().unwrap().len(), 2, "by name too");
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "outside@x.io"})),
    )
    .await;
    let (_, all) = c.c("GET", "/v1/contacts", None).await;
    assert_eq!(all["data"].as_array().unwrap().len(), 3);
    assert_eq!(
        c.c(
            "GET",
            &format!("/v1/contacts?list={}", Uuid::new_v4()),
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        c.contact("ana@x.io").await["lists"][0]["name"],
        "Webinar Oct 2026"
    );
    let (_, pv) = c
        .c(
            "POST",
            "/v1/segments/preview",
            Some(json!({"filter": {"field": "list:Webinar Oct 2026", "op": "eq", "value": true}})),
        )
        .await;
    assert_eq!(pv["data"]["count"], 2, "{pv}");
    let (_, pv) = c.c("POST", "/v1/segments/preview", Some(json!({"filter": {"not": {"field": format!("list:{id}"), "op": "eq", "value": true}}}))).await;
    assert_eq!(pv["data"]["count"], 1, "everyone not in the list: {pv}");

    // remove, by id and by email; the contacts stay
    let (_, b) = c
        .c(
            "POST",
            &format!("/v1/lists/{id}/members/remove"),
            Some(json!({"emails": ["NEW@x.io"]})),
        )
        .await;
    assert_eq!(b["data"]["removed"], 1);
    let (_, b) = c
        .c(
            "POST",
            &format!("/v1/lists/{id}/members/remove"),
            Some(json!({"contact_ids": [ana_id]})),
        )
        .await;
    assert_eq!(b["data"]["removed"], 1);
    assert_eq!(c.n("SELECT count(*) FROM contacts").await, 3);
    c.c(
        "POST",
        &format!("/v1/lists/{id}/members"),
        Some(json!({"contact_ids": [ana_id]})),
    )
    .await;

    // rename + describe
    let (s, b) = c
        .c(
            "PATCH",
            &format!("/v1/lists/{id}"),
            Some(json!({"name": "Webinar", "description": ""})),
        )
        .await;
    assert_eq!(
        (
            s,
            b["data"]["name"].as_str(),
            b["data"]["description"].clone()
        ),
        (200, Some("Webinar"), Value::Null),
        "{b}"
    );

    // a suppressed contact on a list stays suppressed, and deleting the list changes nothing about it
    c.c(
        "POST",
        "/v1/contacts/ana@x.io/suppress",
        Some(json!({"reason": "unsubscribe"})),
    )
    .await;
    let (s, b) = c.c("DELETE", &format!("/v1/lists/{id}"), None).await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(c.n("SELECT count(*) FROM contacts").await, 3);
    assert_eq!(c.n("SELECT count(*) FROM segment_members").await, 0);
    let ana = c.contact("ana@x.io").await;
    assert_eq!(
        (
            ana["suppressed"].as_bool(),
            ana["suppression_reason"].as_str(),
            ana["lists"].clone()
        ),
        (Some(true), Some("unsubscribe"), json!([]))
    );
    assert_eq!(c.c("GET", &format!("/v1/lists/{id}"), None).await.0, 404);

    let actions = sqlx::query_scalar::<_, String>("SELECT action FROM audit_log ORDER BY id")
        .fetch_all(&c.st.db)
        .await
        .unwrap();
    for a in [
        "list.create",
        "list.members_add",
        "list.members_remove",
        "list.update",
        "list.delete",
    ] {
        assert!(actions.iter().any(|x| x == a), "{a} in {actions:?}");
    }
}

#[tokio::test]
async fn lists_are_manual_segments_and_rule_segments_are_not_lists() {
    let c = ctx!();
    let (_, seg) = c.c("POST", "/v1/segments", Some(json!({"name": "Pros", "filter": {"field": "properties.plan", "op": "eq", "value": "pro"}}))).await;
    let seg_id = seg["data"]["id"].as_str().unwrap();
    c.c("POST", "/v1/segments", Some(json!({"name": "Manual"})))
        .await;
    let (_, l) = c.c("GET", "/v1/lists", None).await;
    let names: Vec<_> = l["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["Manual"],
        "a manual segment is a list; a rule segment is not"
    );
    assert_eq!(
        c.c("GET", &format!("/v1/lists/{seg_id}"), None).await.0,
        404
    );
    assert_eq!(
        c.c("DELETE", &format!("/v1/lists/{seg_id}"), None).await.0,
        404
    );
    assert_eq!(
        c.c("GET", &format!("/v1/contacts?list={seg_id}"), None)
            .await
            .0,
        404
    );
    let (_, sl) = c.c("GET", "/v1/segments", None).await;
    assert!(sl["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["origin"].is_string()));
}

#[tokio::test]
async fn csv_import_adds_every_row_to_a_list_existing_contacts_included() {
    let c = ctx!();
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "already@x.io"})),
    )
    .await;
    c.c(
        "POST",
        "/v1/contacts/already@x.io/suppress",
        Some(json!({"reason": "unsubscribe"})),
    )
    .await;
    let (s, b) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"list_name": "Webinar Oct 2026", "contacts": [
            {"email": "one@x.io"}, {"email": "already@x.io"}, {"email": "broken"}]})),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(
        (
            b["data"]["imported"].as_i64(),
            b["data"]["failed"].as_array().unwrap().len()
        ),
        (Some(2), 1)
    );
    let list_id = b["data"]["list_id"].as_str().unwrap().to_string();
    let (_, l) = c.c("GET", &format!("/v1/lists/{list_id}"), None).await;
    assert_eq!(
        (
            l["data"]["origin"].as_str(),
            l["data"]["member_count"].as_i64()
        ),
        (Some("import"), Some(2))
    );
    // same name again reuses the list (chunked imports); by id works too
    let (_, b2) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"list_name": "Webinar Oct 2026", "contacts": [{"email": "two@x.io"}]})),
        )
        .await;
    assert_eq!(b2["data"]["list_id"], list_id.as_str());
    let (_, b3) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"list_id": list_id, "contacts": [{"email": "three@x.io"}]})),
        )
        .await;
    assert_eq!(b3["data"]["imported"], 1);
    assert_eq!(c.n("SELECT count(*) FROM segment_members").await, 4);
    // suppression is untouched by list membership
    assert_eq!(
        c.contact("already@x.io").await["suppression_reason"],
        "unsubscribe"
    );

    let (s, _) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"list_id": list_id, "list_name": "x", "contacts": [{"email": "z@x.io"}]})),
        )
        .await;
    assert_eq!(s, 400, "one or the other");
    let (s, _) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"list_id": Uuid::new_v4(), "contacts": [{"email": "z@x.io"}]})),
        )
        .await;
    assert_eq!(s, 404);
    c.c(
        "POST",
        "/v1/segments",
        Some(json!({"name": "Rules", "filter": {"field": "email", "op": "exists"}})),
    )
    .await;
    let (s, b) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"list_name": "Rules", "contacts": [{"email": "z@x.io"}]})),
        )
        .await;
    assert_eq!((s, code(&b)), (409, "invalid_state"));
    // no list: as before
    let (s, b) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(json!({"contacts": [{"email": "plain@x.io"}]})),
        )
        .await;
    assert_eq!((s, b["data"]["list_id"].clone()), (200, Value::Null));
}

#[tokio::test]
async fn a_list_is_a_broadcast_audience_and_suppressed_members_are_screened() {
    let c = ctx!();
    sqlx::query("UPDATE workspaces SET live_enabled = true, legal_name = 'Acme', postal_address = '1 Main St' WHERE id = $1")
        .bind(c.ws).execute(&c.st.db).await.unwrap();
    sqlx::query("INSERT INTO domains (workspace_id, name, status, return_path_host) VALUES ($1,'acme.io','verified','bounce.acme.io')")
        .bind(c.ws).execute(&c.st.db).await.unwrap();
    sqlx::query("INSERT INTO transports (workspace_id, kind, name, config_enc, is_default) VALUES ($1,'smtp-relay','zoho','\\x00',true)")
        .bind(c.ws).execute(&c.st.db).await.unwrap();
    let (s, b) = c.c("POST", "/v1/templates", Some(json!({"name": "hello", "alias": "hello", "stream": "marketing",
        "content": {"version": 1, "subject": "Hi", "blocks": [{"type": "paragraph", "text": "Hello {{ first_name | default('there') }}"}]}}))).await;
    assert_eq!(s, 201, "{b}");
    assert_eq!(
        c.c("POST", "/v1/templates/hello/publish", None).await.0,
        200
    );
    let (_, l) = c
        .c("POST", "/v1/lists", Some(json!({"name": "Audience"})))
        .await;
    let id = l["data"]["id"].as_str().unwrap();
    c.c(
        "POST",
        &format!("/v1/lists/{id}/members"),
        Some(json!({"emails": ["a@x.io", "b@x.io", "c@x.io"]})),
    )
    .await;
    c.c(
        "POST",
        "/v1/contacts/c@x.io/suppress",
        Some(json!({"reason": "unsubscribe"})),
    )
    .await;

    let body = |extra: Value| {
        let mut b = json!({"template_id": "hello", "from": "dev@acme.io", "dry_run": true});
        b.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        b
    };
    let (s, b) = c
        .c("POST", "/v1/broadcasts", Some(body(json!({"list_id": id}))))
        .await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(b["data"]["queued"], 2);
    assert_eq!(b["data"]["skipped"][0]["email"], "c@x.io");
    let (s, _) = c
        .c(
            "POST",
            "/v1/broadcasts",
            Some(body(
                json!({"list_id": id, "recipients": [{"email": "z@x.io"}]}),
            )),
        )
        .await;
    assert_eq!(s, 400, "inline recipients or a list, not both");
    let (_, e) = c
        .c("POST", "/v1/lists", Some(json!({"name": "Empty"})))
        .await;
    let (s, _) = c
        .c(
            "POST",
            "/v1/broadcasts",
            Some(body(json!({"list_id": e["data"]["id"]}))),
        )
        .await;
    assert_eq!(s, 400, "an empty list");
    let (s, _) = c
        .c(
            "POST",
            "/v1/broadcasts",
            Some(body(json!({"list_id": Uuid::new_v4()}))),
        )
        .await;
    assert_eq!(s, 404);
}

// ------------------------------------------------------------------ dry runs

#[tokio::test]
async fn import_dry_run_classifies_every_row_and_writes_nothing() {
    let c = ctx!();
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "ana@x.io", "first_name": "Ana", "properties": {"plan": "free"}})),
    )
    .await;
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "same@x.io", "first_name": "Same"})),
    )
    .await;
    let audit_before = c.n("SELECT count(*) FROM audit_log").await;
    let body = |list: Value| {
        let mut b = json!({"dry_run": true, "contacts": [
            {"email": "ana@x.io", "first_name": "Anna", "properties": {"plan": "pro"}},
            {"email": "same@X.IO", "first_name": "Same"},
            {"email": "fresh@x.io", "first_name": "Fresh"},
            {"email": "broken"},
            {"email": "tz@x.io", "timezone": "Mars/Olympus"},
        ]});
        b.as_object_mut()
            .unwrap()
            .extend(list.as_object().unwrap().clone());
        b
    };
    let (s, b) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(body(json!({"list_name": "Webinar"}))),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let d = &b["data"];
    assert_eq!(d["dry_run"], true);
    assert_eq!(
        d["summary"],
        json!({"new": 1, "update": 1, "unchanged": 1, "skipped": 2, "list_adds": 3}),
        "{b}"
    );
    assert_eq!(
        d["list"],
        json!({"id": null, "name": "Webinar", "exists": false})
    );
    let rows = d["rows"].as_array().unwrap();
    let status: Vec<_> = rows.iter().map(|r| r["status"].as_str().unwrap()).collect();
    assert_eq!(status, ["update", "unchanged", "new", "skipped", "skipped"]);
    assert_eq!(
        rows[0]["changes"],
        json!([
            {"field": "first_name", "old": "Ana", "new": "Anna"},
            {"field": "properties.plan", "old": "free", "new": "pro"},
        ])
    );
    assert_eq!(rows[3]["reason"], "invalid_email");
    assert_eq!(rows[4]["reason"], "invalid_timezone");
    assert_eq!(
        rows[1]["email"], "same@x.io",
        "the domain is normalised before matching"
    );

    // nothing was written: no contacts, no list, no audit row
    assert_eq!(c.n("SELECT count(*) FROM contacts").await, 2);
    assert_eq!(c.n("SELECT count(*) FROM segments").await, 0);
    assert_eq!(c.n("SELECT count(*) FROM audit_log").await, audit_before);
    assert_eq!(c.contact("ana@x.io").await["first_name"], "Ana");

    // against an existing list, members already on it are not "added" again
    let (_, l) = c
        .c("POST", "/v1/lists", Some(json!({"name": "Existing"})))
        .await;
    let lid = l["data"]["id"].as_str().unwrap();
    c.c(
        "POST",
        &format!("/v1/lists/{lid}/members"),
        Some(json!({"emails": ["ana@x.io"]})),
    )
    .await;
    let (_, b) = c
        .c(
            "POST",
            "/v1/contacts/import",
            Some(body(json!({"list_id": lid}))),
        )
        .await;
    assert_eq!(b["data"]["summary"]["list_adds"], 2);
    assert_eq!(b["data"]["rows"][0]["list"], "already");
    assert_eq!(b["data"]["rows"][2]["list"], "add");
    assert_eq!(b["data"]["list"]["exists"], true);
    assert_eq!(c.n("SELECT count(*) FROM segment_members").await, 1);
    // no target: no list info
    let (_, b) = c
        .c("POST", "/v1/contacts/import", Some(body(json!({}))))
        .await;
    assert_eq!(
        (
            b["data"]["list"].clone(),
            b["data"]["rows"][0]["list"].clone()
        ),
        (Value::Null, Value::Null)
    );
}

#[tokio::test]
async fn source_sync_dry_run_previews_the_first_page_and_writes_nothing() {
    let c = ctx!();
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "mine@x.io", "first_name": "Local"})),
    )
    .await;
    let mut gone = row("3", "ghost@x.io", ago(3));
    gone.deleted = true;
    let (src, url) = spawn(vec![
        row("1", "mine@x.io", ago(8)),
        row("2", "fresh@x.io", ago(4)),
        gone,
    ])
    .await;
    src.lock().unwrap().page_size = 10;
    let id = c.add_source("Acme", &url).await;

    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/contact-sources/{id}/sync?dry_run=true"),
            None,
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let d = &b["data"];
    assert_eq!(
        (
            d["ok"].as_bool(),
            d["sample"].as_bool(),
            d["has_more"].as_bool()
        ),
        (Some(true), Some(true), Some(false))
    );
    assert_eq!(
        d["summary"],
        json!({"new": 1, "update": 1, "unchanged": 0, "skipped": 1}),
        "{b}"
    );
    let rows = d["rows"].as_array().unwrap();
    assert_eq!(rows[0]["status"], "update");
    assert!(rows[0]["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["field"] == "first_name" && x["old"] == "Local" && x["new"] == "User 1"));
    assert_eq!(rows[0]["list"], "add");
    assert_eq!(
        (rows[1]["status"].as_str(), rows[2]["reason"].as_str()),
        (Some("new"), Some("deleted_unknown"))
    );
    assert_eq!(
        c.n("SELECT count(*) FROM contacts").await,
        1,
        "no contact created"
    );
    assert_eq!(c.n("SELECT count(*) FROM segment_members").await, 0);
    let src_row = c.source(id).await;
    assert_eq!(
        (src_row["last_run_at"].clone(), src_row["watermark"].clone()),
        (Value::Null, Value::Null)
    );

    // after a real sync the same page is all "unchanged"
    c.sync(id).await;
    let (_, b) = c
        .c(
            "POST",
            &format!("/v1/contact-sources/{id}/sync?dry_run=true"),
            None,
        )
        .await;
    assert_eq!(
        b["data"]["summary"]["unchanged"], 1,
        "only rows inside the window are read again: {b}"
    );
    assert_eq!(b["data"]["rows"][0]["list"], "already");

    // a failing source reports it instead of throwing
    src.lock().unwrap().key = "other".into();
    let (s, b) = c
        .c(
            "POST",
            &format!("/v1/contact-sources/{id}/sync?dry_run=true"),
            None,
        )
        .await;
    assert_eq!((s, b["data"]["ok"].as_bool()), (200, Some(false)));
}

// ------------------------------------------------------------------ the pull contract's edges

#[tokio::test]
async fn a_null_from_the_source_means_unknown_and_never_clears_anything() {
    let c = ctx!();
    c.c(
        "PUT",
        "/v1/contacts",
        Some(json!({"email": "ana@x.io", "first_name": "Ana", "timezone": "Europe/Berlin", "properties": {"plan": "pro", "vip": true}})),
    )
    .await;
    let mut r = row("1", "ana@x.io", ago(5));
    r.first_name = None;
    r.timezone = None;
    r.properties = json!({"plan": null, "seats": 3, "trial": null});
    let (_src, url) = spawn(vec![r]).await;
    let id = c.add_source("Acme", &url).await;
    let (_, p) = c
        .c(
            "POST",
            &format!("/v1/contact-sources/{id}/sync?dry_run=true"),
            None,
        )
        .await;
    assert_eq!(
        p["data"]["rows"][0]["changes"],
        json!([{"field": "properties.seats", "old": null, "new": 3}]),
        "the preview ignores nulls too"
    );
    c.sync(id).await;
    let ana = c.contact("ana@x.io").await;
    assert_eq!(
        (ana["first_name"].as_str(), ana["timezone"].as_str()),
        (Some("Ana"), Some("Europe/Berlin"))
    );
    assert_eq!(
        ana["properties"],
        json!({"plan": "pro", "vip": true, "seats": 3})
    );
}

#[tokio::test]
async fn deleted_and_suspended_accounts_are_suppressed_with_their_status() {
    let c = ctx!();
    let (src, url) = spawn(vec![
        row("1", "gone@x.io", ago(50)),
        row("2", "paused@x.io", ago(49)),
        row("3", "odd@x.io", ago(48)),
    ])
    .await;
    src.lock().unwrap().page_size = 10;
    let id = c.add_source("Acme", &url).await;
    c.sync(id).await;
    {
        let mut s = src.lock().unwrap();
        for (i, status) in ["deleted", "suspended", "active"].into_iter().enumerate() {
            s.rows[i].deleted = true;
            s.rows[i].properties = json!({"status": status});
            s.rows[i].updated_at = ago(2);
        }
    }
    let (_, p) = c
        .c(
            "POST",
            &format!("/v1/contact-sources/{id}/sync?dry_run=true"),
            None,
        )
        .await;
    let news: Vec<_> = p["data"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["changes"][0]["new"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        news,
        ["source_deleted", "source_suspended", "source_deleted"]
    );
    let r = c.sync(id).await;
    assert_eq!(r["counts"]["deleted"], 3, "{r}");
    let reason = |e: &'static str| {
        let c = &c;
        async move { c.contact(e).await["suppression_reason"].clone() }
    };
    assert_eq!(reason("gone@x.io").await, "source_deleted");
    assert_eq!(reason("paused@x.io").await, "source_suspended");
    assert_eq!(
        reason("odd@x.io").await,
        "source_deleted",
        "an unknown status is a deletion"
    );
}

#[tokio::test]
async fn a_rate_limited_page_is_retried_and_a_stubborn_limit_is_an_error() {
    let c = ctx!();
    let (src, url) = spawn(vec![row("1", "a@x.io", ago(5))]).await;
    let id = c.add_source("Acme", &url).await;
    src.lock().unwrap().rate_limit = 2;
    let r = c.sync(id).await;
    assert_eq!(
        (r["ok"].as_bool(), r["counts"]["created"].as_i64()),
        (Some(true), Some(1)),
        "{r}"
    );
    assert_eq!(src.lock().unwrap().seen.len(), 3, "two 429s, then the page");

    src.lock().unwrap().rate_limit = 99;
    let r = c.sync(id).await;
    assert_eq!(r["ok"], false);
    assert!(
        r["error"].as_str().unwrap().contains("rate limiting"),
        "{r}"
    );
}

#[tokio::test]
async fn everything_is_read_again_every_full_sync_hours() {
    let c = ctx!();
    let (src, url) = spawn(vec![
        row("1", "a@x.io", ago(60)),
        row("2", "b@x.io", ago(59)),
    ])
    .await;
    src.lock().unwrap().page_size = 10;
    let id = c.add_source("Acme", &url).await;
    assert_eq!(c.source(id).await["full_sync_hours"], 24);
    c.sync(id).await;
    let s = c.source(id).await;
    assert!(
        s["last_full_at"].is_string(),
        "the first run read everything"
    );
    assert!(!src.lock().unwrap().seen[0].contains_key("updated_since"));

    // a computed field changes at the source without moving updated_at
    src.lock().unwrap().rows[0].properties = json!({"plan": "free", "credits": 7});
    src.lock().unwrap().seen.clear();
    let r = c.sync(id).await;
    assert_eq!(
        r["counts"]["fetched"], 0,
        "incremental: nothing newer than the window"
    );
    assert!(src.lock().unwrap().seen[0].contains_key("updated_since"));
    assert!(c.contact("a@x.io").await["properties"]["credits"].is_null());

    // 25 hours after the last full read the next run is a full one again
    sqlx::query("UPDATE contact_sources SET last_full_at = now() - interval '25 hours'")
        .execute(&c.st.db)
        .await
        .unwrap();
    src.lock().unwrap().seen.clear();
    let r = c.sync(id).await;
    assert_eq!(r["counts"]["fetched"], 2, "{r}");
    assert!(!src.lock().unwrap().seen[0].contains_key("updated_since"));
    assert_eq!(c.contact("a@x.io").await["properties"]["credits"], 7);

    // 0 turns the periodic full read off
    let (s, b) = c
        .c(
            "PATCH",
            &format!("/v1/contact-sources/{id}"),
            Some(json!({"full_sync_hours": 0})),
        )
        .await;
    assert_eq!(
        (s, b["data"]["full_sync_hours"].as_i64()),
        (200, Some(0)),
        "{b}"
    );
    sqlx::query("UPDATE contact_sources SET last_full_at = now() - interval '999 hours'")
        .execute(&c.st.db)
        .await
        .unwrap();
    src.lock().unwrap().seen.clear();
    c.sync(id).await;
    assert!(src.lock().unwrap().seen[0].contains_key("updated_since"));
    assert_eq!(
        c.c(
            "PATCH",
            &format!("/v1/contact-sources/{id}"),
            Some(json!({"full_sync_hours": 721}))
        )
        .await
        .0,
        400
    );
}
