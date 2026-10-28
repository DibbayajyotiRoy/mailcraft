//! `/v1/contact-sources`: mailcraft PULLS its contact list from another product's internal HTTP API
//! (contract: `docs/CONTACT-SOURCES.md`). No database access to that product.
//!
//! * `contact_sources.key_enc` = `SecretBox::seal(api key, source id bytes)`. The key is write-only:
//!   no response, log line or audit row carries it.
//! * Every source owns a list (`segments.source_id`); every synced contact joins it.
//! * One run = pages until `next_cursor` is null (or a cap is hit). Each row is upserted through the
//!   same `upsert_contact` the contacts API uses, so properties merge shallowly (source keys win,
//!   user-set keys stay) and a suppression is never cleared. `deleted: true` suppresses
//!   (`source_deleted`), never hard-deletes.
//! * The watermark (max `updated_at` seen) only advances when a run finishes or stops at a cap, so a
//!   failed run is retried from the same place; the next run asks for `watermark - 5 min`.
//! * Single-flight per source: a session advisory lock on a detached connection, so a crashed
//!   process (or a second instance) can never leave a source locked.
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Duration as Span, SecondsFormat, Utc};
use mailcraft_automations::{
    contacts::{self, normalize_email, valid_timezone},
    AutomationError, ContactInput,
};
use mailcraft_core::auth::Scope;
use reqwest::{redirect, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Connection as _, PgConnection, PgPool};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{envelope, envelope_list, err, invalid, not_found, ApiError, ApiJson, ApiResult},
    integrations::record,
    lists, ssrf,
    state::AppState,
};

const PAGE_LIMIT: u32 = 500;
/// A page longer than this is a broken source, not a big one.
const MAX_PAGE_ROWS: usize = 1000;
const MAX_RUN_ROWS: u32 = 50_000;
const MAX_PAGES: usize = 400;
const MAX_BODY: usize = 20 << 20;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_BUDGET: Duration = Duration::from_secs(300);
const TICK: Duration = Duration::from_secs(30);
/// Pages are fetched one at a time with at least this gap (sources may allow ~5 requests a second).
const PAGE_GAP: Duration = Duration::from_millis(200);
/// A 429 is retried this many times, waiting `Retry-After` (1 s if absent), doubling, at most 30 s.
const RETRIES: u32 = 3;
const MAX_BACKOFF: Duration = Duration::from_secs(30);

fn overlap() -> Span {
    Span::minutes(5)
}

// ------------------------------------------------------------------ rows

#[derive(Deserialize)]
struct Row {
    external_id: String,
    email: String,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
    updated_at: DateTime<Utc>,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    properties: Option<Value>,
}

/// What one run did. `skipped` rows were not imported; `reasons` also notes fixes (a dropped timezone).
#[derive(Default, Serialize, Clone, Debug)]
pub struct Counts {
    pub created: u32,
    pub updated: u32,
    pub skipped: u32,
    pub deleted: u32,
    pub fetched: u32,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub reasons: BTreeMap<&'static str, u32>,
}

impl Counts {
    fn note(&mut self, why: &'static str) {
        *self.reasons.entry(why).or_default() += 1;
    }
    fn skip(&mut self, why: &'static str) {
        self.skipped += 1;
        self.note(why);
    }
}

/// `deleted` covers suspended accounts too; `properties.status` says which.
fn suppression_reason(props: Option<&Value>) -> &'static str {
    match props.and_then(|p| p["status"].as_str()) {
        Some("suspended") => "source_suspended",
        _ => "source_deleted",
    }
}

/// A null means "unknown", never "clear": drop null-valued keys before merging into a contact.
fn without_nulls(p: Value) -> Option<Value> {
    match p {
        Value::Object(m) => {
            let m: serde_json::Map<String, Value> =
                m.into_iter().filter(|(_, v)| !v.is_null()).collect();
            (!m.is_empty()).then_some(Value::Object(m))
        }
        other => Some(other),
    }
}

fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

// ------------------------------------------------------------------ http

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("mailcraft-contact-sync")
        // Private addresses are fine (the URL is admin-set and usually internal), but the key never
        // follows a redirect to another origin.
        .redirect(redirect::Policy::custom(|a| {
            if a.previous().len() > 3 {
                return a.error("too many redirects");
            }
            match a.previous().first() {
                Some(first) if a.url().origin() == first.origin() => a.follow(),
                _ => a.stop(),
            }
        }))
        .build()
        .map_err(|e| e.without_url().to_string())
}

struct Page {
    rows: Vec<Value>,
    next: Option<String>,
    /// The source's clock when it started reading; the safe point for the next `updated_since`.
    synced_at: Option<DateTime<Utc>>,
}

async fn fetch_page(
    c: &Client,
    url: &str,
    key: &str,
    limit: u32,
    cursor: Option<&str>,
    since: Option<DateTime<Utc>>,
    rate_limited: &mut Option<Duration>,
) -> Result<Page, String> {
    let mut u = Url::parse(url).map_err(|_| "the source URL is not valid".to_string())?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("limit", &limit.to_string());
        if let Some(c) = cursor {
            q.append_pair("cursor", c);
        }
        if let Some(s) = since {
            q.append_pair(
                "updated_since",
                &s.to_rfc3339_opts(SecondsFormat::Secs, true),
            );
        }
    }
    let mut res = c
        .get(u)
        .bearer_auth(key)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "the source did not answer within 10 seconds".to_string()
            } else {
                format!("cannot reach the source: {}", e.without_url())
            }
        })?;
    let status = res.status();
    if status == 401 || status == 403 {
        return Err(format!(
            "the source rejected the API key (HTTP {})",
            status.as_u16()
        ));
    }
    if status == 429 {
        *rate_limited = Some(
            res.headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse().ok())
                .map_or(Duration::from_secs(1), Duration::from_secs),
        );
        return Err("the source is rate limiting mailcraft (HTTP 429)".into());
    }
    if status.is_server_error() {
        return Err(format!(
            "the source is unavailable (HTTP {}); it will be retried at the next interval",
            status.as_u16()
        ));
    }
    if status.is_redirection() {
        return Err(format!(
            "the source redirected to another address (HTTP {}); use its final URL",
            status.as_u16()
        ));
    }
    if !status.is_success() {
        return Err(format!("the source answered HTTP {}", status.as_u16()));
    }
    let ct = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ct.contains("json") {
        return Err("the source did not answer with JSON".into());
    }
    if res.content_length().is_some_and(|n| n as usize > MAX_BODY) {
        return Err("a page from the source is larger than 20 MB".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("reading the source's answer failed: {}", e.without_url()))?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("a page from the source is larger than 20 MB".into());
        }
        body.extend_from_slice(&chunk);
    }
    let v: Value = serde_json::from_slice(&body)
        .map_err(|_| "the source's answer is not valid JSON".to_string())?;
    let Some(rows) = v.get("data").and_then(Value::as_array) else {
        return Err("the answer has no `data` array (see docs/CONTACT-SOURCES.md)".into());
    };
    if rows.len() > MAX_PAGE_ROWS {
        return Err(format!(
            "the source returned {} rows in one page (limit {MAX_PAGE_ROWS})",
            rows.len()
        ));
    }
    let next = match v.get("next_cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err("`next_cursor` must be a string or null".into()),
    };
    let synced_at = v
        .get("synced_at")
        .and_then(Value::as_str)
        .and_then(|t| t.parse().ok());
    Ok(Page {
        rows: rows.clone(),
        next,
        synced_at,
    })
}

/// [`fetch_page`], waiting and trying again when the source answers 429.
async fn fetch_retry(
    c: &Client,
    url: &str,
    key: &str,
    cursor: Option<&str>,
    since: Option<DateTime<Utc>>,
) -> Result<Page, String> {
    let mut attempt = 0;
    loop {
        let mut limited = None;
        match fetch_page(c, url, key, PAGE_LIMIT, cursor, since, &mut limited).await {
            // Wait what the source asked for (1 s if it did not say), twice as long each time.
            Err(_) if limited.is_some() && attempt < RETRIES => {
                let asked = limited.unwrap_or_default();
                tokio::time::sleep((asked * 2u32.pow(attempt)).min(MAX_BACKOFF)).await;
                attempt += 1;
            }
            r => return r,
        }
    }
}

// ------------------------------------------------------------------ sources

#[derive(sqlx::FromRow)]
struct Source {
    id: Uuid,
    workspace_id: Uuid,
    name: String,
    url: String,
    key_enc: Vec<u8>,
    enabled: bool,
    interval_minutes: i32,
    full_sync_hours: i32,
    last_full_at: Option<DateTime<Utc>>,
    watermark: Option<DateTime<Utc>>,
    last_run_at: Option<DateTime<Utc>>,
    last_status: Option<String>,
    last_error: Option<String>,
    last_counts: Option<Value>,
    created_at: DateTime<Utc>,
    list_id: Option<Uuid>,
    list_name: Option<String>,
}

const SELECT: &str = "SELECT s.id, s.workspace_id, s.name, s.url, s.key_enc, s.enabled, s.interval_minutes, s.full_sync_hours, s.last_full_at, s.watermark, \
    s.last_run_at, s.last_status, s.last_error, s.last_counts, s.created_at, l.id AS list_id, l.name AS list_name \
    FROM contact_sources s LEFT JOIN segments l ON l.source_id = s.id";

impl Source {
    /// Public shape: never the key.
    fn view(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "url": self.url, "enabled": self.enabled,
            "interval_minutes": self.interval_minutes, "full_sync_hours": self.full_sync_hours,
            "last_full_at": self.last_full_at, "watermark": self.watermark,
            "last_run_at": self.last_run_at, "last_status": self.last_status,
            "last_error": self.last_error, "last_counts": self.last_counts, "created_at": self.created_at,
            "list": self.list_id.map(|id| json!({"id": id, "name": self.list_name})),
        })
    }
}

async fn load(db: &PgPool, ws: Option<Uuid>, id: Uuid) -> ApiResult<Source> {
    sqlx::query_as(&format!(
        "{SELECT} WHERE s.id = $1 AND ($2::uuid IS NULL OR s.workspace_id = $2)"
    ))
    .bind(id)
    .bind(ws)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| not_found("contact source"))
}

fn open_key(st: &AppState, s: &Source) -> Result<String, String> {
    st.secrets
        .open(&s.key_enc, s.id.as_bytes())
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or_else(|| {
            "the stored API key cannot be decrypted (was MAILCRAFT_SECRET_KEY changed?); enter the key again".to_string()
        })
}

// ------------------------------------------------------------------ one row

struct Ctx<'a> {
    db: &'a PgPool,
    source: &'a Source,
    list: Uuid,
    now: DateTime<Utc>,
}

enum Written {
    Created,
    Updated,
    Skipped(&'static str),
}

fn db_err(e: AutomationError) -> sqlx::Error {
    match e {
        AutomationError::Db(e) => e,
        e => sqlx::Error::Protocol(e.to_string()),
    }
}

/// An address that was opted out stays opted out when its owner changes it.
async fn carry_suppression(
    tx: &mut PgConnection,
    ws: Uuid,
    from: &str,
    to: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO suppressions (workspace_id, email, reason, source) \
         SELECT workspace_id, $3, reason, 'contact_source' FROM suppressions \
         WHERE workspace_id = $1 AND lower(email) = lower($2) AND reason IN ('unsubscribe','complaint','manual','source_deleted') \
         ON CONFLICT DO NOTHING",
    )
    .bind(ws)
    .bind(from)
    .bind(to)
    .execute(tx)
    .await?;
    Ok(())
}

/// The writes for one live row, in the caller's transaction.
async fn write(
    tx: &mut PgConnection,
    cx: &Ctx<'_>,
    ext: &str,
    mut input: ContactInput,
    linked: Option<(Uuid, String)>,
    by_email: Option<(Uuid, Option<Uuid>)>,
    counts: &mut Counts,
) -> Result<Written, sqlx::Error> {
    let ws = cx.source.workspace_id;
    let created = linked.is_none() && by_email.is_none();
    match (&linked, &by_email) {
        // The source changed this person's address.
        (Some((id, cur)), other) if *cur != input.email => match other {
            None => {
                sqlx::query("UPDATE contacts SET email = $2 WHERE id = $1")
                    .bind(id)
                    .bind(&input.email)
                    .execute(&mut *tx)
                    .await?;
                carry_suppression(tx, ws, cur, &input.email).await?;
            }
            // Another contact already has the new address: keep the old one, still sync the rest.
            Some(_) => {
                counts.note("email_conflict");
                input.email = cur.clone();
            }
        },
        // The address belongs to a contact the source owns under another id (or another source).
        (None, Some((_, Some(_)))) => return Ok(Written::Skipped("duplicate_email")),
        // Existing contact with no source yet: adopt it. No contact: create.
        _ => {}
    }
    let c = match contacts::upsert_contact(&mut *tx, ws, &input, cx.now).await {
        Ok(c) => c,
        Err(AutomationError::Db(e)) => return Err(e),
        Err(_) => return Ok(Written::Skipped("rejected")),
    };
    sqlx::query(
        "UPDATE contacts SET external_source_id = $2, external_id = $3 WHERE id = $1 \
         AND (external_source_id IS DISTINCT FROM $2 OR external_id IS DISTINCT FROM $3)",
    )
    .bind(c.id)
    .bind(cx.source.id)
    .bind(ext)
    .execute(&mut *tx)
    .await?;
    contacts::add_to_segment(&mut *tx, cx.list, c.id, cx.now)
        .await
        .map_err(db_err)?;
    Ok(if created {
        Written::Created
    } else {
        Written::Updated
    })
}

/// Applies one row. `Err` is a database failure, which ends the run; anything wrong with the row
/// itself is counted as skipped.
async fn apply(cx: &Ctx<'_>, row: Row, counts: &mut Counts) -> Result<(), sqlx::Error> {
    let ext = row.external_id.trim().to_string();
    if ext.is_empty() || ext.len() > 200 {
        counts.skip("invalid_external_id");
        return Ok(());
    }
    let Ok(email) = normalize_email(&row.email) else {
        counts.skip("invalid_email");
        return Ok(());
    };
    let props = row.properties.filter(|p| !p.is_null());
    if props.as_ref().is_some_and(|p| !p.is_object()) {
        counts.skip("invalid_properties");
        return Ok(());
    }
    let reason = suppression_reason(props.as_ref());
    let mut props = props.and_then(without_nulls);
    // A bad timezone costs the timezone, not the contact.
    let mut tz = clean(row.timezone);
    if tz.as_deref().is_some_and(|t| !valid_timezone(t)) {
        counts.note("invalid_timezone");
        tz = None;
    }
    if let Some(p) = props.as_mut().and_then(Value::as_object_mut) {
        if p.get("timezone")
            .and_then(Value::as_str)
            .is_some_and(|t| !valid_timezone(t.trim()))
        {
            counts.note("invalid_timezone");
            p.remove("timezone");
        }
    }
    let ws = cx.source.workspace_id;
    let linked: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM contacts WHERE external_source_id = $1 AND external_id = $2",
    )
    .bind(cx.source.id)
    .bind(&ext)
    .fetch_optional(cx.db)
    .await?;
    let by_email: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, external_source_id FROM contacts WHERE workspace_id = $1 AND email = $2",
    )
    .bind(ws)
    .bind(&email)
    .fetch_optional(cx.db)
    .await?;

    if row.deleted {
        // Suppress, never delete. Only a contact this source owns, or one nobody else owns.
        let target = match (&linked, &by_email) {
            (Some((_, current)), _) => Some(current.clone()),
            (None, Some((_, None))) => Some(email),
            _ => None,
        };
        match target {
            Some(e) => {
                sqlx::query(
                    "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1, $2, $3, 'contact_source') ON CONFLICT DO NOTHING",
                )
                .bind(ws)
                .bind(e)
                .bind(reason)
                .execute(cx.db)
                .await?;
                counts.deleted += 1;
            }
            None => counts.skip("deleted_unknown"),
        }
        return Ok(());
    }

    let input = ContactInput {
        email,
        first_name: clean(row.first_name),
        last_name: clean(row.last_name),
        timezone: tz,
        properties: props,
        consent: None,
    };
    let mut tx = cx.db.begin().await?;
    match write(&mut tx, cx, &ext, input, linked, by_email, counts).await {
        Ok(w) => {
            tx.commit().await?;
            match w {
                Written::Created => counts.created += 1,
                Written::Updated => counts.updated += 1,
                Written::Skipped(why) => counts.skip(why),
            }
        }
        // Lost a race for the address: leave the row for the next run.
        Err(e)
            if e.as_database_error()
                .is_some_and(|d| d.is_unique_violation()) =>
        {
            counts.skip("conflict")
        }
        Err(e) => return Err(e),
    }
    Ok(())
}

// ------------------------------------------------------------------ a run

pub struct Run {
    pub ok: bool,
    pub error: Option<String>,
    pub counts: Counts,
    pub watermark: Option<DateTime<Utc>>,
    pub duration_ms: u128,
}

async fn list_for(st: &AppState, s: &Source) -> Result<Uuid, sqlx::Error> {
    if let Some(id) = s.list_id {
        return Ok(id);
    }
    let mut c = st.db.acquire().await?;
    let name = lists::unique_name(&mut c, s.workspace_id, &s.name).await?;
    sqlx::query_scalar(
        "INSERT INTO segments (workspace_id, name, origin, source_id) VALUES ($1, $2, 'source', $3) RETURNING id",
    )
    .bind(s.workspace_id)
    .bind(name)
    .bind(s.id)
    .fetch_one(&mut *c)
    .await
}

/// Whether the next run reads everything, and the `updated_since` it sends otherwise. Some of a
/// source's fields change without moving `updated_at`, so every `full_sync_hours` it reads it all.
fn plan(s: &Source) -> (bool, Option<DateTime<Utc>>) {
    let full = s.watermark.is_none()
        || (s.full_sync_hours > 0
            && s.last_full_at
                .is_none_or(|t| Utc::now() - t >= Span::hours(s.full_sync_hours.into())));
    (full, s.watermark.filter(|_| !full).map(|w| w - overlap()))
}

/// Pages through the source. `Err` is the message stored in `last_error`.
async fn pull(
    st: &AppState,
    s: &Source,
    counts: &mut Counts,
    max_seen: &mut Option<DateTime<Utc>>,
    stop: &(dyn Fn() -> bool + Sync),
) -> Result<Pulled, String> {
    let key = open_key(st, s)?;
    let http = client()?;
    let list = list_for(st, s).await.map_err(|e| {
        tracing::error!(error = %e, source = %s.id, "contact source list");
        "database error".to_string()
    })?;
    let cx = Ctx {
        db: &st.db,
        source: s,
        list,
        now: Utc::now(),
    };
    let (full, since) = plan(s);
    let (started, mut cursor) = (Instant::now(), None::<String>);
    let mut synced_at = None;
    for n in 0..MAX_PAGES {
        if n > 0 {
            tokio::time::sleep(PAGE_GAP).await;
        }
        let page = fetch_retry(&http, &s.url, &key, cursor.as_deref(), since).await?;
        if n == 0 {
            synced_at = page.synced_at;
        }
        for raw in page.rows {
            counts.fetched += 1;
            let Ok(row) = serde_json::from_value::<Row>(raw) else {
                counts.skip("malformed");
                continue;
            };
            *max_seen = (*max_seen).max(Some(row.updated_at));
            apply(&cx, row, counts).await.map_err(|e| {
                tracing::error!(error = %e, source = %s.id, "contact source write");
                "database error while saving contacts".to_string()
            })?;
        }
        let Some(next) = page.next else {
            return Ok(Pulled {
                done: true,
                full,
                synced_at,
            });
        };
        if cursor.as_deref() == Some(next.as_str()) {
            return Err("the source returned the same cursor twice".into());
        }
        cursor = Some(next);
        // Rows come ordered by updated_at, so stopping here and resuming from the watermark is safe.
        if counts.fetched >= MAX_RUN_ROWS || started.elapsed() > RUN_BUDGET || stop() {
            break;
        }
    }
    Ok(Pulled {
        done: false,
        full,
        synced_at,
    })
}

/// How a pull ended. `done`: it read to the last page (otherwise it stopped at a cap).
struct Pulled {
    done: bool,
    full: bool,
    synced_at: Option<DateTime<Utc>>,
}

/// Runs one source now. `None` when another run (here or on another instance) holds it.
pub async fn run_source(
    st: &AppState,
    id: Uuid,
    stop: &(dyn Fn() -> bool + Sync),
) -> ApiResult<Option<Run>> {
    let s = load(&st.db, None, id).await?;
    let mut lock = st.db.acquire().await?.detach();
    let got: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_lock(hashtextextended('contact_source:' || $1::text, 0))",
    )
    .bind(id)
    .fetch_one(&mut lock)
    .await?;
    if !got {
        return Ok(None);
    }
    let t0 = Instant::now();
    let (mut counts, mut max_seen) = (Counts::default(), None);
    let (error, done, full, synced_at) = match pull(st, &s, &mut counts, &mut max_seen, stop).await
    {
        Ok(p) => (None, p.done, p.full, p.synced_at),
        Err(e) => (Some(e), false, false, None),
    };
    // A run that read to the end resumes from the source's own clock at its start (anything that
    // changed while it ran is read again next time); one that stopped at a cap resumes from the newest
    // row it saw. Never past "now": a source with a runaway clock must not freeze the sync.
    let resume = if done {
        synced_at.or(max_seen)
    } else {
        max_seen
    };
    let watermark = resume
        .filter(|_| error.is_none())
        .map(|m: DateTime<Utc>| m.min(Utc::now()));
    sqlx::query(
        "UPDATE contact_sources SET last_run_at = now(), last_status = $2, last_error = $3, last_counts = $4, \
         watermark = CASE WHEN $5::timestamptz IS NULL THEN watermark ELSE GREATEST(COALESCE(watermark, $5), $5) END, \
         last_full_at = CASE WHEN $7 THEN now() ELSE last_full_at END \
         WHERE id = $1 AND url = $6",
    )
    .bind(id)
    .bind(if error.is_none() { "ok" } else { "error" })
    .bind(&error)
    .bind(sqlx::types::Json(&counts))
    .bind(watermark)
    .bind(&s.url)
    .bind(error.is_none() && done && full)
    .execute(&st.db)
    .await?;
    let _ = lock.close().await; // closing the session releases the advisory lock
    Ok(Some(Run {
        ok: error.is_none(),
        error,
        counts,
        watermark,
        duration_ms: t0.elapsed().as_millis(),
    }))
}

/// Background loop: every [`TICK`], run each enabled source whose interval has elapsed. Sources run
/// one after another. ponytail: one slow source delays the others; spawn per source if that bites.
pub async fn run_loop(st: AppState, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(TICK);
    while !*shutdown.borrow() {
        tokio::select! { _ = tick.tick() => {}, _ = shutdown.changed() => break }
        let due: Result<Vec<Uuid>, _> = sqlx::query_scalar(
            "SELECT id FROM contact_sources WHERE enabled AND (last_run_at IS NULL OR \
             last_run_at + make_interval(mins => interval_minutes) <= now()) ORDER BY last_run_at NULLS FIRST LIMIT 20",
        )
        .fetch_all(&st.db)
        .await;
        for id in due.unwrap_or_default() {
            let stop = || *shutdown.borrow();
            if stop() {
                break;
            }
            match run_source(&st, id, &stop).await {
                Ok(Some(r)) => {
                    tracing::info!(source = %id, ok = r.ok, created = r.counts.created, updated = r.counts.updated, skipped = r.counts.skipped, deleted = r.counts.deleted, "contact source sync");
                    if r.counts.created + r.counts.deleted > 0 {
                        audit_run(&st, id, &r, None).await;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::error!(source = %id, error = %e.0.message, "contact source sync failed")
                }
            }
        }
    }
}

async fn audit_run(st: &AppState, id: Uuid, r: &Run, key: Option<&crate::auth::ApiKey>) {
    let Ok(s) = load(&st.db, None, id).await else {
        return;
    };
    let _ = audit::append_standalone(
        &st.db,
        s.workspace_id,
        key.map_or(Actor::System, Actor::Key),
        Entry {
            action: "contact_source.sync",
            args: json!({"source_id": id, "name": s.name, "ok": r.ok, "error": r.error, "counts": r.counts}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await;
}

// ------------------------------------------------------------------ http handlers

fn url_of(raw: &str) -> ApiResult<String> {
    let u = raw.trim();
    if u.len() > 2000 {
        return Err(invalid("url is too long").field("url"));
    }
    // Private and loopback addresses are the normal case here; only the shape is checked.
    ssrf::check_url(u, true)?;
    Ok(u.to_string())
}

fn key_of(raw: &str) -> ApiResult<String> {
    let k = raw.trim();
    if k.is_empty() || k.len() > 1000 || !k.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(invalid("key must be 1-1000 printable characters, no spaces").field("key"));
    }
    Ok(k.to_string())
}

fn full_hours_of(v: i32) -> ApiResult<i32> {
    if !(0..=720).contains(&v) {
        return Err(invalid("full_sync_hours must be 0-720 (0 = never)").field("full_sync_hours"));
    }
    Ok(v)
}

fn interval_of(v: i32) -> ApiResult<i32> {
    if !(1..=1440).contains(&v) {
        return Err(invalid("interval_minutes must be 1-1440").field("interval_minutes"));
    }
    Ok(v)
}

fn taken(e: sqlx::Error, name: &str) -> ApiError {
    if e.as_database_error()
        .is_some_and(|d| d.is_unique_violation())
    {
        return err(
            "invalid_state",
            409,
            format!("a contact source named `{name}` already exists"),
        )
        .field("name");
    }
    e.into()
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateSource {
    pub name: String,
    pub url: String,
    /// Sent as `Authorization: Bearer <key>`. Write-only.
    pub key: String,
    #[serde(default)]
    pub interval_minutes: Option<i32>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Read everything (no `updated_since`) this often, as well as the incremental runs. Default 24; 0 = never.
    #[serde(default)]
    pub full_sync_hours: Option<i32>,
    /// Display name of the list synced contacts join (default: the source name).
    #[serde(default)]
    pub list_name: Option<String>,
}

pub async fn create(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<CreateSource>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let name = lists::name_of(&b.name)?;
    let (url, key) = (url_of(&b.url)?, key_of(&b.key)?);
    let interval = interval_of(b.interval_minutes.unwrap_or(15))?;
    let full_hours = full_hours_of(b.full_sync_hours.unwrap_or(24))?;
    let list_name = match b.list_name.as_deref().filter(|n| !n.trim().is_empty()) {
        Some(n) => lists::name_of(n).map_err(|e| e.field("list_name"))?,
        None => name.clone(),
    };
    let mut g = begin!(st, auth, headers, "POST /v1/contact-sources", b);
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO contact_sources (id, workspace_id, name, url, key_enc, enabled, interval_minutes, full_sync_hours) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    )
    .bind(id)
    .bind(ws)
    .bind(&name)
    .bind(&url)
    .bind(st.secrets.seal(key.as_bytes(), id.as_bytes()))
    .bind(b.enabled.unwrap_or(true))
    .bind(interval)
    .bind(full_hours)
    .execute(&mut *g.tx)
    .await
    .map_err(|e| taken(e, &name))?;
    let list_name = lists::unique_name(&mut g.tx, ws, &list_name).await?;
    sqlx::query(
        "INSERT INTO segments (workspace_id, name, origin, source_id) VALUES ($1, $2, 'source', $3)",
    )
    .bind(ws)
    .bind(&list_name)
    .bind(id)
    .execute(&mut *g.tx)
    .await?;
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "contact_source.create",
            args: json!({"source_id": id, "name": name, "url": url, "interval_minutes": interval, "list": list_name}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    let s: Source = sqlx::query_as(&format!("{SELECT} WHERE s.id = $1"))
        .bind(id)
        .fetch_one(&mut *g.tx)
        .await?;
    g.finish(StatusCode::CREATED, s.view()).await
}

pub async fn list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Manage)?;
    let rows: Vec<Source> = sqlx::query_as(&format!(
        "{SELECT} WHERE s.workspace_id = $1 ORDER BY s.created_at, s.id"
    ))
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    Ok(envelope_list(
        rows.iter().map(Source::view).collect::<Vec<_>>(),
        None,
    ))
}

pub async fn get(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let s = load(&st.db, Some(auth.0.workspace_id), id).await?;
    Ok(envelope(StatusCode::OK, s.view()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchSource {
    #[serde(default)]
    pub name: Option<String>,
    /// Changing the URL starts over: the next run reads everything again.
    #[serde(default)]
    pub url: Option<String>,
    /// Rotates the key.
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub interval_minutes: Option<i32>,
    #[serde(default)]
    pub full_sync_hours: Option<i32>,
}

pub async fn patch(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<PatchSource>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    load(&st.db, Some(ws), id).await?;
    let name = b.name.as_deref().map(lists::name_of).transpose()?;
    let url = b.url.as_deref().map(url_of).transpose()?;
    let key = b.key.as_deref().map(key_of).transpose()?;
    let interval = b.interval_minutes.map(interval_of).transpose()?;
    let full_hours = b.full_sync_hours.map(full_hours_of).transpose()?;
    sqlx::query(
        "UPDATE contact_sources SET name = COALESCE($3, name), url = COALESCE($4, url), key_enc = COALESCE($5, key_enc), \
         enabled = COALESCE($6, enabled), interval_minutes = COALESCE($7, interval_minutes), \
         full_sync_hours = COALESCE($8, full_sync_hours), \
         watermark = CASE WHEN $4::text IS NOT NULL AND $4 <> url THEN NULL ELSE watermark END \
         WHERE id = $1 AND workspace_id = $2",
    )
    .bind(id)
    .bind(ws)
    .bind(&name)
    .bind(&url)
    .bind(key.as_ref().map(|k| st.secrets.seal(k.as_bytes(), id.as_bytes())))
    .bind(b.enabled)
    .bind(interval)
    .bind(full_hours)
    .execute(&st.db)
    .await
    .map_err(|e| taken(e, name.as_deref().unwrap_or_default()))?;
    let fields: Vec<&str> = [
        ("name", name.is_some()),
        ("url", url.is_some()),
        ("key", key.is_some()),
        ("enabled", b.enabled.is_some()),
        ("interval_minutes", interval.is_some()),
        ("full_sync_hours", full_hours.is_some()),
    ]
    .into_iter()
    .filter_map(|(f, set)| set.then_some(f))
    .collect();
    record(
        &st,
        &auth,
        "contact_source.update",
        json!({"source_id": id, "fields": fields, "rotated": key.is_some(), "enabled": b.enabled}),
    )
    .await?;
    Ok(envelope(
        StatusCode::OK,
        load(&st.db, Some(ws), id).await?.view(),
    ))
}

#[derive(Deserialize)]
pub struct DeleteQ {
    /// Also delete the source's list. Contacts stay either way.
    delete_list: Option<bool>,
}

pub async fn delete(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    Query(q): Query<DeleteQ>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let s = load(&st.db, Some(ws), id).await?;
    let drop_list = q.delete_list.unwrap_or(false) && s.list_id.is_some();
    if let (true, Some(list_name)) = (drop_list, &s.list_name) {
        let users = crate::services::segment_users(
            &st.db,
            ws,
            &[list_name, &s.list_id.unwrap_or_default().to_string()],
        )
        .await?;
        if !users.is_empty() {
            return Err(err(
                "invalid_state",
                409,
                format!("automation(s) still use the list: {}", users.join(", ")),
            )
            .hint_in("keep the list, or change those automations first"));
        }
    }
    let mut tx = st.db.begin().await?;
    // Contacts stay and keep their lists; they just are not tied to a source any more. Suppressions are untouched.
    sqlx::query(
        "UPDATE contacts SET external_source_id = NULL, external_id = NULL WHERE external_source_id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if drop_list {
        sqlx::query("DELETE FROM segments WHERE source_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    // The list, if kept, is detached by the foreign key (segments.source_id -> NULL).
    sqlx::query("DELETE FROM contact_sources WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::append(
        &mut tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "contact_source.delete",
            args: json!({"source_id": id, "name": s.name, "list_deleted": drop_list}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"id": id, "deleted": true, "list_deleted": drop_list}),
    ))
}

#[derive(Deserialize)]
pub struct SyncQ {
    /// Preview the first page instead of syncing: nothing is written.
    dry_run: Option<bool>,
}

#[derive(sqlx::FromRow)]
struct Linked {
    external_id: String,
    #[sqlx(flatten)]
    c: crate::diff::Existing,
}

/// What the first page would do, read-only. Same decisions as [`apply`], without the writes: a
/// sample of the next sync, not all of it.
async fn preview(st: &AppState, s: &Source) -> ApiResult {
    use crate::diff;
    let fail = |e: String| envelope(StatusCode::OK, json!({"ok": false, "error": e}));
    let key = match open_key(st, s) {
        Ok(k) => k,
        Err(e) => return Ok(fail(e)),
    };
    let http = match client() {
        Ok(c) => c,
        Err(e) => return Ok(fail(e)),
    };
    let since = plan(s).1;
    let page = match fetch_page(&http, &s.url, &key, PAGE_LIMIT, None, since, &mut None).await {
        Ok(p) => p,
        Err(e) => return Ok(fail(e)),
    };
    let parsed: Vec<Result<Row, ()>> = page
        .rows
        .iter()
        .map(|r| serde_json::from_value::<Row>(r.clone()).map_err(|_| ()))
        .collect();
    let ok_rows = || parsed.iter().filter_map(|r| r.as_ref().ok());
    let ext_ids: Vec<String> = ok_rows()
        .map(|r| r.external_id.trim().to_string())
        .collect();
    let emails: Vec<String> = ok_rows()
        .filter_map(|r| normalize_email(&r.email).ok())
        .collect();
    let linked: std::collections::HashMap<String, crate::diff::Existing> = sqlx::query_as::<_, Linked>(
        "SELECT external_id, id, email, first_name, last_name, timezone, properties, external_source_id \
         FROM contacts WHERE external_source_id = $1 AND external_id = ANY($2)",
    )
    .bind(s.id)
    .bind(&ext_ids)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|l| (l.external_id, l.c))
    .collect();
    let by_email = diff::existing(&st.db, s.workspace_id, &emails).await?;
    let on_list = match s.list_id {
        Some(l) => {
            let ids: Vec<Uuid> = linked
                .values()
                .chain(by_email.values())
                .map(|c| c.id)
                .collect();
            diff::members(&st.db, l, &ids).await?
        }
        None => Default::default(),
    };
    let (mut new, mut update, mut unchanged, mut skipped) = (0, 0, 0, 0);
    let mut rows = Vec::with_capacity(parsed.len());
    for (index, p) in parsed.iter().enumerate() {
        let mut skip = |email: &str, reason: &str| {
            skipped += 1;
            json!({"index": index, "email": email, "status": "skipped", "reason": reason})
        };
        let Ok(r) = p else {
            rows.push(skip("", "malformed"));
            continue;
        };
        let Ok(email) = normalize_email(&r.email) else {
            rows.push(skip(r.email.trim(), "invalid_email"));
            continue;
        };
        let ext = r.external_id.trim();
        let own = linked.get(ext);
        let other = by_email.get(&email);
        if r.deleted {
            let target = own.or(other.filter(|o| o.external_source_id.is_none()));
            if target.is_none() {
                rows.push(skip(&email, "deleted_unknown"));
                continue;
            }
            update += 1;
            rows.push(json!({"index": index, "email": email, "external_id": ext, "status": "update", "list": null,
                "changes": [{"field": "suppressed", "old": false, "new": suppression_reason(r.properties.as_ref())}]}));
            continue;
        }
        if own.is_none() && other.is_some_and(|o| o.external_source_id.is_some()) {
            rows.push(skip(&email, "duplicate_email"));
            continue;
        }
        let existing = own.or(other);
        let tz = clean(r.timezone.clone()).filter(|t| valid_timezone(t));
        let props = r
            .properties
            .clone()
            .filter(Value::is_object)
            .and_then(without_nulls);
        let mut changes = existing.map_or_else(Vec::new, |e| {
            diff::changes(
                e,
                clean(r.first_name.clone()).as_deref(),
                clean(r.last_name.clone()).as_deref(),
                tz.as_deref(),
                props.as_ref(),
            )
        });
        if let Some(e) = own.filter(|e| e.email != email) {
            changes.insert(0, json!({"field": "email", "old": e.email, "new": email}));
        }
        let status = match existing {
            None => "new",
            Some(_) if changes.is_empty() => "unchanged",
            Some(_) => "update",
        };
        match status {
            "new" => new += 1,
            "update" => update += 1,
            _ => unchanged += 1,
        }
        let list = s.list_id.map(|_| {
            if existing.is_some_and(|e| on_list.contains(&e.id)) {
                "already"
            } else {
                "add"
            }
        });
        let values = (status == "new").then(|| {
            json!({"first_name": clean(r.first_name.clone()), "last_name": clean(r.last_name.clone()), "timezone": tz, "properties": props})
        });
        rows.push(json!({"index": index, "email": email, "external_id": ext, "status": status, "changes": changes, "list": list, "values": values}));
    }
    Ok(envelope(
        StatusCode::OK,
        json!({
            "ok": true, "dry_run": true, "sample": true, "has_more": page.next.is_some(),
            "summary": {"new": new, "update": update, "unchanged": unchanged, "skipped": skipped},
            "list": s.list_id.map(|id| json!({"id": id, "name": s.list_name})),
            "rows": rows,
        }),
    ))
}

/// Run now. Always 200 once it ran: `ok: false` carries the reason (also stored on the source).
/// `?dry_run=true` previews the first page instead and writes nothing.
pub async fn sync(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    Query(q): Query<SyncQ>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let s = load(&st.db, Some(auth.0.workspace_id), id).await?;
    if q.dry_run.unwrap_or(false) {
        return preview(&st, &s).await;
    }
    let Some(r) = run_source(&st, id, &|| false).await? else {
        return Err(
            err("sync_in_progress", 409, "this source is already syncing")
                .hint_in("wait for the running sync to finish"),
        );
    };
    audit_run(&st, id, &r, Some(&auth.0)).await;
    Ok(envelope(
        StatusCode::OK,
        json!({"id": id, "ok": r.ok, "error": r.error, "counts": r.counts, "watermark": r.watermark, "duration_ms": r.duration_ms}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestSource {
    /// An existing source: its URL and key fill whatever is not given.
    #[serde(default)]
    pub id: Option<Uuid>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
}

/// Fetches one page (`limit=1`) and reports what came back. Writes nothing. Always 200; `ok: false`
/// carries the reason.
pub async fn test(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<TestSource>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let stored = match b.id {
        Some(id) => Some(load(&st.db, Some(auth.0.workspace_id), id).await?),
        None => None,
    };
    let url = match (&b.url, &stored) {
        (Some(u), _) => url_of(u)?,
        (None, Some(s)) => s.url.clone(),
        (None, None) => return Err(invalid("url is required").field("url")),
    };
    let key = match (&b.key, &stored) {
        (Some(k), _) => key_of(k)?,
        (None, Some(s)) => match open_key(&st, s) {
            Ok(k) => k,
            Err(e) => return Ok(envelope(StatusCode::OK, json!({"ok": false, "error": e}))),
        },
        (None, None) => return Err(invalid("key is required").field("key")),
    };
    let fail = |e: String| envelope(StatusCode::OK, json!({"ok": false, "error": e}));
    let http = match client() {
        Ok(c) => c,
        Err(e) => return Ok(fail(e)),
    };
    let page = match fetch_page(&http, &url, &key, 1, None, None, &mut None).await {
        Ok(p) => p,
        Err(e) => return Ok(fail(e)),
    };
    let first = page.rows.first();
    if let Some(Err(e)) = first.map(|r| serde_json::from_value::<Row>(r.clone())) {
        return Ok(fail(format!(
            "the first row is not in the contact-source format: {e}"
        )));
    }
    let keys_of = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    };
    Ok(envelope(
        StatusCode::OK,
        json!({
            "ok": true,
            "sample_count": page.rows.len(),
            "has_more": page.next.is_some(),
            "fields": keys_of(first),
            "property_keys": keys_of(first.and_then(|r| r.get("properties"))),
        }),
    ))
}
