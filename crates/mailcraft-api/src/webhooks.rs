//! Webhook endpoint CRUD, signed delivery with the SPEC retry schedule, replay and test pings.
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use mailcraft_core::{auth::Scope, webhook};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{envelope, envelope_list, invalid, not_found, ApiJson, ApiResult},
    idem::{Begin, Guard},
    ssrf,
    state::AppState,
};

const KNOWN_PREFIXES: [&str; 8] = [
    "email",
    "contact",
    "domain",
    "automation",
    "approval",
    "suppression",
    "kill_switch",
    "test",
];

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateWebhook {
    pub url: String,
    #[serde(default)]
    pub events: Option<Vec<String>>,
    #[serde(default)]
    pub description: Option<String>,
}

fn validate_events(events: &[String]) -> ApiResult<()> {
    for e in events {
        let head = e.split('.').next().unwrap_or("");
        if e != "*" && !KNOWN_PREFIXES.contains(&head) {
            return Err(invalid(format!("unknown event `{e}`"))
                .field("events")
                .hint_in("use `*`, `email.*`, or names like `email.bounced` (SPEC 7.4)"));
        }
    }
    Ok(())
}

pub async fn create(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(body): ApiJson<CreateWebhook>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    ssrf::check_url(&body.url, st.config.allow_private_webhooks)?;
    let events = body.events.clone().unwrap_or_else(|| vec!["*".into()]);
    if events.is_empty() {
        return Err(invalid("events must not be empty").field("events"));
    }
    validate_events(&events)?;
    let mut g = match Guard::begin(&st, &auth.0, &headers, "POST /v1/webhooks", &body).await? {
        Begin::Replay(r) => return Ok(r),
        Begin::Fresh(g) => g,
    };
    let id = Uuid::now_v7();
    let secret = webhook::new_secret();
    let sealed = st.secrets.seal(secret.as_bytes(), id.as_bytes());
    sqlx::query(
        "INSERT INTO webhook_endpoints (id, workspace_id, url, events, secret_enc, description) \
         VALUES ($1,$2,$3,$4,$5,$6)",
    )
    .bind(id)
    .bind(auth.0.workspace_id)
    .bind(&body.url)
    .bind(&events)
    .bind(sealed)
    .bind(&body.description)
    .execute(&mut *g.tx)
    .await?;
    audit::append(
        &mut g.tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "webhook.create",
            args: json!({"id": id, "url": body.url, "events": events}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    // The secret is shown exactly once.
    g.finish(
        StatusCode::CREATED,
        json!({"id": id, "url": body.url, "events": events, "status": "active", "secret": secret}),
    )
    .await
}

#[derive(sqlx::FromRow, Serialize)]
struct EndpointView {
    id: Uuid,
    url: String,
    events: Vec<String>,
    status: String,
    description: Option<String>,
    consecutive_failures: i32,
    created_at: DateTime<Utc>,
}

pub async fn list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Manage)?;
    let rows: Vec<EndpointView> = sqlx::query_as(
        "SELECT id, url, events, status, description, consecutive_failures, created_at \
         FROM webhook_endpoints WHERE workspace_id = $1 ORDER BY created_at DESC, id",
    )
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    Ok(envelope_list(rows, None))
}

pub async fn delete(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("DELETE FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2")
        .bind(id)
        .bind(auth.0.workspace_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(not_found("webhook"));
    }
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "webhook.delete",
            args: json!({"id": id}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(StatusCode::OK, json!({"id": id, "deleted": true})))
}

type DeliveryRow = (Uuid, String, i32, String, Option<i32>, DateTime<Utc>);

pub async fn deliveries(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let rows: Vec<DeliveryRow> = sqlx::query_as(
        "SELECT d.id, d.event_type, d.attempts, d.status, d.last_status_code, d.created_at \
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id \
         WHERE d.endpoint_id = $1 AND e.workspace_id = $2 ORDER BY d.created_at DESC LIMIT 100",
    )
    .bind(id)
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, t, a, s, c, at)| {
            json!({"id": id, "event_type": t, "attempts": a, "status": s, "last_status_code": c, "created_at": at})
        })
        .collect();
    Ok(envelope_list(items, None))
}

/// Queues a `test.ping` event for one endpoint.
pub async fn test(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let mut tx = st.db.begin().await?;
    let owned: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2")
            .bind(id)
            .bind(auth.0.workspace_id)
            .fetch_optional(&mut *tx)
            .await?;
    if owned.is_none() {
        return Err(not_found("webhook"));
    }
    let did = insert_delivery(
        &mut tx,
        id,
        "test.ping",
        json!({"message": "hello from mailcraft"}),
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(StatusCode::ACCEPTED, json!({"delivery_id": did})))
}

pub async fn replay(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let n = sqlx::query(
        "UPDATE webhook_deliveries d SET status = 'pending', attempts = 0, next_attempt_at = now() \
         FROM webhook_endpoints e WHERE d.id = $1 AND e.id = d.endpoint_id AND e.workspace_id = $2",
    )
    .bind(id)
    .bind(auth.0.workspace_id)
    .execute(&st.db)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(not_found("webhook delivery"));
    }
    Ok(envelope(
        StatusCode::ACCEPTED,
        json!({"delivery_id": id, "status": "pending"}),
    ))
}

async fn insert_delivery(
    conn: &mut PgConnection,
    endpoint: Uuid,
    event_type: &str,
    data: Value,
) -> Result<Uuid, sqlx::Error> {
    let id = Uuid::now_v7();
    let body = json!({"id": id, "type": event_type, "created_at": Utc::now(), "data": data});
    sqlx::query("INSERT INTO webhook_deliveries (id, endpoint_id, event_type, payload) VALUES ($1,$2,$3,$4)")
        .bind(id)
        .bind(endpoint)
        .bind(event_type)
        .bind(body)
        .execute(conn)
        .await?;
    Ok(id)
}

/// Fan an event out to every matching active endpoint. Call inside the state-changing
/// transaction: the delivery rows are the outbox.
pub async fn enqueue(
    conn: &mut PgConnection,
    workspace: Uuid,
    event_type: &str,
    data: Value,
) -> Result<usize, sqlx::Error> {
    let eps: Vec<(Uuid, Vec<String>)> = sqlx::query_as(
        "SELECT id, events FROM webhook_endpoints WHERE workspace_id = $1 AND status = 'active'",
    )
    .bind(workspace)
    .fetch_all(&mut *conn)
    .await?;
    let mut n = 0;
    for (id, events) in eps {
        if webhook::event_matches(&events, event_type) {
            insert_delivery(&mut *conn, id, event_type, data.clone()).await?;
            n += 1;
        }
    }
    Ok(n)
}

/// Outbox -> deliveries: turns new `email_events` rows into `email.<type>` webhook deliveries,
/// in one transaction with marking them done (at-least-once; payload `data` per SPEC 7.4).
pub async fn fan_out(st: &AppState, limit: i64) -> Result<usize, sqlx::Error> {
    let mut tx = st.db.begin().await?;
    let rows: Vec<(i64, Uuid, Uuid, String, Option<String>, Option<String>, Option<String>, DateTime<Utc>, Value)> =
        sqlx::query_as(
            "SELECT ev.id, ev.workspace_id, ev.email_id, ev.type, ev.bounce_class, ev.enhanced_code, ev.diagnostic, \
                    ev.occurred_at, jsonb_build_object('from', e.from_addr, 'to', e.to_addr, 'subject', e.subject, \
                    'stream', e.stream, 'env', e.env, 'tags', e.tags) \
             FROM email_events ev JOIN emails e ON e.id = ev.email_id \
             WHERE ev.outboxed_at IS NULL ORDER BY ev.id LIMIT $1 FOR UPDATE OF ev SKIP LOCKED",
        )
        .bind(limit)
        .fetch_all(&mut *tx)
        .await?;
    for (id, ws, email_id, ty, class, enh, diag, at, mut data) in rows.iter().cloned() {
        if let Some(m) = data.as_object_mut() {
            m.insert("email_id".into(), json!(email_id));
            m.insert("occurred_at".into(), json!(at));
            if let Some(c) = class {
                m.insert("bounce_class".into(), json!(c));
            }
            if let Some(c) = enh {
                m.insert("enhanced_code".into(), json!(c));
            }
            if let Some(c) = diag {
                m.insert("diagnostic".into(), json!(c));
            }
        }
        enqueue(&mut tx, ws, &format!("email.{ty}"), data).await?;
        sqlx::query("UPDATE email_events SET outboxed_at = now() WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(rows.len())
}

#[derive(sqlx::FromRow)]
struct Due {
    id: Uuid,
    endpoint_id: Uuid,
    payload: Value,
    attempts: i32,
    url: String,
    secret_enc: Vec<u8>,
    endpoint_status: String,
}

/// Claims and attempts due deliveries; returns how many were attempted. Claiming leases a row
/// for 60 s (`next_attempt_at`), so a crashed worker's delivery is retried: at-least-once.
pub async fn deliver_due(st: &AppState, limit: i64) -> Result<usize, sqlx::Error> {
    let due: Vec<Due> = sqlx::query_as(
        "WITH c AS (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now() \
                    ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $1) \
         UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '60 seconds' \
         FROM c, webhook_endpoints e WHERE d.id = c.id AND e.id = d.endpoint_id \
         RETURNING d.id, d.endpoint_id, d.payload, d.attempts, e.url, e.secret_enc, e.status AS endpoint_status",
    )
    .bind(limit)
    .fetch_all(&st.db)
    .await?;
    let n = due.len();
    for d in due {
        attempt(st, d).await?;
    }
    Ok(n)
}

async fn attempt(st: &AppState, d: Due) -> Result<(), sqlx::Error> {
    if d.endpoint_status != "active" {
        sqlx::query("UPDATE webhook_deliveries SET status = 'failed' WHERE id = $1")
            .bind(d.id)
            .execute(&st.db)
            .await?;
        return Ok(());
    }
    let made = d.attempts as u32 + 1;
    let outcome = send_once(st, &d).await;
    let (code, ok, retryable) = match &outcome {
        Ok(c) => (
            Some(i32::from(*c)),
            (200..300).contains(c),
            webhook::is_retryable_status(*c),
        ),
        Err(e) => {
            tracing::warn!(delivery = %d.id, error = %e, "webhook attempt failed");
            (None, false, true)
        }
    };
    let label = if ok {
        "delivered"
    } else if retryable {
        "retry"
    } else {
        "failed"
    };
    st.metrics
        .webhook_deliveries
        .with_label_values(&[label, &made.to_string()])
        .inc();
    let mut tx = st.db.begin().await?;
    if ok {
        sqlx::query("UPDATE webhook_deliveries SET status='delivered', attempts=$2, last_status_code=$3 WHERE id=$1")
            .bind(d.id)
            .bind(made as i32)
            .bind(code)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1")
            .bind(d.endpoint_id)
            .execute(&mut *tx)
            .await?;
    } else {
        let jitter = f64::from(u16::from_be_bytes(
            mailcraft_core::crypto::random_bytes::<2>(),
        )) / 65535.0;
        match retryable
            .then(|| webhook::retry_delay(made, jitter))
            .flatten()
        {
            Some(delay) => {
                sqlx::query(
                    "UPDATE webhook_deliveries SET attempts=$2, last_status_code=$3, \
                     next_attempt_at = now() + make_interval(secs => $4) WHERE id=$1",
                )
                .bind(d.id)
                .bind(made as i32)
                .bind(code)
                .bind(delay.as_secs_f64())
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query("UPDATE webhook_deliveries SET status='failed', attempts=$2, last_status_code=$3 WHERE id=$1")
                    .bind(d.id)
                    .bind(made as i32)
                    .bind(code)
                    .execute(&mut *tx)
                    .await?;
                // Only exhausting every attempt counts toward auto-disable.
                if retryable {
                    sqlx::query(
                        "UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, \
                         status = CASE WHEN consecutive_failures + 1 >= $2 THEN 'disabled' ELSE status END \
                         WHERE id = $1",
                    )
                    .bind(d.endpoint_id)
                    .bind(webhook::DISABLE_AFTER_EXHAUSTED)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }
    }
    tx.commit().await
}

async fn send_once(st: &AppState, d: &Due) -> Result<u16, String> {
    let secret = st
        .secrets
        .open(&d.secret_enc, d.endpoint_id.as_bytes())
        .map_err(|e| e.message)?;
    let secret = String::from_utf8(secret).map_err(|_| "secret is not utf-8".to_string())?;
    let allow = st.config.allow_private_webhooks;
    let (host, port) = ssrf::check_url(&d.url, allow).map_err(|e| e.message)?;
    let addr = ssrf::resolve_checked(&host, port, allow)
        .await
        .map_err(|e| e.message)?;
    let body = d.payload.to_string();
    let ts = Utc::now().timestamp();
    // Pin the connection to the address we just checked (no DNS rebinding); never follow redirects.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .resolve(&host, addr)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(&d.url)
        .header("content-type", "application/json")
        .body(body.clone());
    for (k, v) in webhook::headers(&secret, &d.id.to_string(), ts, &body) {
        req = req.header(k, v);
    }
    req.send()
        .await
        .map(|r| r.status().as_u16())
        .map_err(|e| e.to_string())
}
