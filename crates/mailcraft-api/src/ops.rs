//! Approvals queue, go-live + policy proposals, kill switch, audit log, health and metrics.
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use mailcraft_core::{audit::redact, auth::Scope, crypto::ct_eq, policy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{
        envelope, envelope_list, err, forbidden_scope, invalid, not_found, ApiJson, ApiResult,
    },
    idem::{Begin, Guard},
    state::AppState,
    webhooks,
};

// ---------------------------------------------------------------- approvals

#[derive(sqlx::FromRow, Serialize)]
struct ApprovalView {
    id: Uuid,
    kind: String,
    status: String,
    subject_id: Option<Uuid>,
    requested_by: Option<Uuid>,
    payload: Value,
    decided_by_key: Option<Uuid>,
    decided_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

const APPROVAL_COLS: &str =
    "id, kind, status, subject_id, requested_by, payload, decided_by_key, decided_at, created_at";

#[derive(Deserialize)]
pub struct ApprovalQ {
    status: Option<String>,
    limit: Option<i64>,
}

pub async fn approvals_list(
    State(st): State<AppState>,
    auth: Auth,
    Query(q): Query<ApprovalQ>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let rows: Vec<ApprovalView> = sqlx::query_as(&format!(
        "SELECT {APPROVAL_COLS} FROM approvals WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2) \
         ORDER BY created_at DESC, id LIMIT $3"
    ))
    .bind(auth.0.workspace_id)
    .bind(&q.status)
    .bind(q.limit.unwrap_or(50).clamp(1, 200))
    .fetch_all(&st.db)
    .await?;
    Ok(envelope_list(rows, None))
}

pub async fn approvals_get(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let row: ApprovalView = sqlx::query_as(&format!(
        "SELECT {APPROVAL_COLS} FROM approvals WHERE id = $1 AND workspace_id = $2"
    ))
    .bind(id)
    .bind(auth.0.workspace_id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("approval"))?;
    Ok(envelope(StatusCode::OK, row))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Decide {
    pub decision: Decision,
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approve,
    Reject,
}

/// Admin scope only: agent keys never hold it, so they can never decide approvals (SPEC 4.5).
pub async fn approvals_decide(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(body): ApiJson<Decide>,
) -> ApiResult {
    auth.require(Scope::Admin).map_err(|_| {
        forbidden_scope("admin")
            .hint_in("approvals are decided by humans; agents poll GET /v1/approvals/{id}")
    })?;
    let mut tx = st.db.begin().await?;
    let row: Option<(String, String, Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT kind, status, subject_id, payload FROM approvals WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    )
    .bind(id)
    .bind(auth.0.workspace_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (kind, status, _subject, payload) = row.ok_or_else(|| not_found("approval"))?;
    if status != "pending" {
        return Err(err(
            "approval_already_decided",
            409,
            format!("approval is already `{status}`"),
        ));
    }
    let approve = body.decision == Decision::Approve;
    match (kind.as_str(), approve) {
        ("email", true) => {
            sqlx::query(
                "UPDATE emails SET status = 'queued', next_attempt_at = COALESCE(scheduled_at, now()) \
                 WHERE workspace_id = $1 AND status = 'pending_approval' AND id::text = ANY($2)",
            )
            .bind(auth.0.workspace_id)
            .bind(email_ids(&payload))
            .execute(&mut *tx)
            .await?;
        }
        ("email", false) => {
            sqlx::query("UPDATE emails SET status = 'cancelled' WHERE workspace_id = $1 AND status = 'pending_approval' AND id::text = ANY($2)")
                .bind(auth.0.workspace_id)
                .bind(email_ids(&payload))
                .execute(&mut *tx)
                .await?;
        }
        ("go_live", true) => {
            sqlx::query("UPDATE workspaces SET live_enabled = true WHERE id = $1")
                .bind(auth.0.workspace_id)
                .execute(&mut *tx)
                .await?;
        }
        ("policy_change", true) => {
            let key_id = payload["key_id"]
                .as_str()
                .and_then(|s| s.parse::<Uuid>().ok());
            sqlx::query("UPDATE api_keys SET policy = $3 WHERE id = $1 AND workspace_id = $2")
                .bind(key_id)
                .bind(auth.0.workspace_id)
                .bind(&payload["policy"])
                .execute(&mut *tx)
                .await?;
        }
        _ => {}
    }
    let new_status = if approve { "approved" } else { "rejected" };
    sqlx::query(
        "UPDATE approvals SET status = $2, decided_by_key = $3, decided_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(new_status)
    .bind(auth.0.id)
    .execute(&mut *tx)
    .await?;
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "approval.decide",
            args: json!({"approval_id": id, "kind": kind}),
            decision: new_status,
            approval_id: Some(id),
        },
    )
    .await?;
    webhooks::enqueue(
        &mut tx,
        auth.0.workspace_id,
        "approval.decided",
        json!({"approval_id": id, "kind": kind, "status": new_status}),
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"id": id, "status": new_status}),
    ))
}

fn email_ids(payload: &Value) -> Vec<String> {
    payload["email_ids"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GoLive {
    #[serde(default)]
    pub note: Option<String>,
}

/// Agents (or anyone with `manage`) request go-live; only an admin decides it.
pub async fn go_live(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<GoLive>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let mut g = match Guard::begin(&st, &auth.0, &headers, "POST /v1/go-live-requests", &b).await? {
        Begin::Replay(r) => return Ok(r),
        Begin::Fresh(g) => g,
    };
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO approvals (id, workspace_id, kind, requested_by, payload) VALUES ($1,$2,'go_live',$3,$4)")
        .bind(id)
        .bind(auth.0.workspace_id)
        .bind(auth.0.id)
        .bind(json!({"note": b.note}))
        .execute(&mut *g.tx)
        .await?;
    audit::append(
        &mut g.tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "go_live.request",
            args: json!({"approval_id": id}),
            decision: "needs_approval",
            approval_id: Some(id),
        },
    )
    .await?;
    webhooks::enqueue(
        &mut g.tx,
        auth.0.workspace_id,
        "approval.requested",
        json!({"approval_id": id, "kind": "go_live"}),
    )
    .await?;
    g.finish(
        StatusCode::ACCEPTED,
        json!({"approval_id": id, "status": "pending"}),
    )
    .await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyProposal {
    pub key_id: Uuid,
    pub policy: Value,
}

/// Policy changes by agents are proposals a human approves (SPEC 14).
pub async fn policy_proposal(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<PolicyProposal>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    policy::validate(&b.policy).map_err(|m| invalid(m).field("policy"))?;
    let mut g = match Guard::begin(&st, &auth.0, &headers, "POST /v1/policy/proposals", &b).await? {
        Begin::Replay(r) => return Ok(r),
        Begin::Fresh(g) => g,
    };
    let owned: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM api_keys WHERE id = $1 AND workspace_id = $2")
            .bind(b.key_id)
            .bind(auth.0.workspace_id)
            .fetch_optional(&mut *g.tx)
            .await?;
    if owned.is_none() {
        return Err(not_found("key"));
    }
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO approvals (id, workspace_id, kind, subject_id, requested_by, payload) VALUES ($1,$2,'policy_change',$3,$4,$5)")
        .bind(id)
        .bind(auth.0.workspace_id)
        .bind(b.key_id)
        .bind(auth.0.id)
        .bind(json!({"key_id": b.key_id, "policy": b.policy}))
        .execute(&mut *g.tx)
        .await?;
    audit::append(
        &mut g.tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "policy.propose",
            args: json!({"approval_id": id, "key_id": b.key_id, "policy": b.policy}),
            decision: "needs_approval",
            approval_id: Some(id),
        },
    )
    .await?;
    g.finish(
        StatusCode::ACCEPTED,
        json!({"approval_id": id, "status": "pending"}),
    )
    .await
}

// -------------------------------------------------------------- kill switch

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct KillSwitch {
    pub on: bool,
    /// Omit for the workspace-wide switch; set to pause / resume a single key.
    #[serde(default)]
    pub key_id: Option<Uuid>,
}

pub async fn kill_switch_get(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    let on: bool = sqlx::query_scalar("SELECT kill_switch FROM workspaces WHERE id = $1")
        .bind(auth.0.workspace_id)
        .fetch_one(&st.db)
        .await?;
    let paused: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM api_keys WHERE workspace_id = $1 AND paused")
            .bind(auth.0.workspace_id)
            .fetch_all(&st.db)
            .await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"on": on, "paused_keys": paused}),
    ))
}

/// Anyone with `manage` (agents included) may engage; only `admin` (a human) disengages.
pub async fn kill_switch_set(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<KillSwitch>,
) -> ApiResult {
    if b.on {
        if auth.require(Scope::Manage).is_err() {
            auth.require(Scope::Admin)?;
        }
    } else {
        auth.require(Scope::Admin).map_err(|_| {
            forbidden_scope("admin").hint_in("only a human can disengage the kill switch")
        })?;
    }
    let mut g = match Guard::begin(&st, &auth.0, &headers, "POST /v1/kill-switch", &b).await? {
        Begin::Replay(r) => return Ok(r),
        Begin::Fresh(g) => g,
    };
    match b.key_id {
        None => {
            sqlx::query("UPDATE workspaces SET kill_switch = $2 WHERE id = $1")
                .bind(auth.0.workspace_id)
                .bind(b.on)
                .execute(&mut *g.tx)
                .await?;
        }
        Some(k) => {
            let n =
                sqlx::query("UPDATE api_keys SET paused = $3 WHERE id = $1 AND workspace_id = $2")
                    .bind(k)
                    .bind(auth.0.workspace_id)
                    .bind(b.on)
                    .execute(&mut *g.tx)
                    .await?
                    .rows_affected();
            if n == 0 {
                return Err(not_found("key"));
            }
        }
    }
    audit::append(
        &mut g.tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "kill_switch.set",
            args: json!({"on": b.on, "key_id": b.key_id}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    webhooks::enqueue(
        &mut g.tx,
        auth.0.workspace_id,
        "kill_switch.changed",
        json!({"on": b.on, "key_id": b.key_id}),
    )
    .await?;
    g.finish(StatusCode::OK, json!({"on": b.on, "key_id": b.key_id}))
        .await
}

// -------------------------------------------------------------------- audit

#[derive(Deserialize)]
pub struct AuditQ {
    limit: Option<i64>,
    before: Option<i64>,
}

pub async fn audit_list(
    State(st): State<AppState>,
    auth: Auth,
    Query(q): Query<AuditQ>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    type Row = (
        i64,
        DateTime<Utc>,
        String,
        Option<Uuid>,
        String,
        Value,
        String,
        Option<Uuid>,
    );
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, at, actor_type, actor_id, action, args, decision, approval_id FROM audit_log \
         WHERE workspace_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3",
    )
    .bind(auth.0.workspace_id)
    .bind(q.before)
    .bind(limit + 1)
    .fetch_all(&st.db)
    .await?;
    let more = rows.len() as i64 > limit;
    let items: Vec<Value> = rows
        .into_iter()
        .take(limit as usize)
        .map(|(id, at, at_t, aid, action, args, decision, ap)| {
            json!({"id": id, "at": at, "actor_type": at_t, "actor_id": aid, "action": action, "args": redact(&args), "decision": decision, "approval_id": ap})
        })
        .collect();
    let next = if more {
        items.last().map(|v| v["id"].to_string())
    } else {
        None
    };
    Ok(envelope_list(items, next))
}

pub async fn audit_verify(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Admin)?;
    Ok(envelope(
        StatusCode::OK,
        audit::verify(&st.db, auth.0.workspace_id).await?,
    ))
}

pub async fn account_status(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    let (name, kill, live): (String, bool, bool) =
        sqlx::query_as("SELECT name, kill_switch, live_enabled FROM workspaces WHERE id = $1")
            .bind(auth.0.workspace_id)
            .fetch_one(&st.db)
            .await?;
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM approvals WHERE workspace_id = $1 AND status = 'pending'",
    )
    .bind(auth.0.workspace_id)
    .fetch_one(&st.db)
    .await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"workspace": name, "kill_switch": kill, "live_enabled": live, "pending_approvals": pending,
               "key": {"id": auth.0.id, "name": auth.0.name, "env": auth.0.env, "scopes": auth.0.scopes}}),
    ))
}

// ------------------------------------------------------------ health/metrics

pub async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// Postgres + migrations must be fine; Redis only warns (SPEC 7.1).
pub async fn readyz(State(st): State<AppState>) -> Response {
    let db =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _sqlx_migrations WHERE NOT success")
            .fetch_one(&st.db)
            .await;
    let (db_ok, detail) = match db {
        Ok(0) => (true, "ok".to_string()),
        Ok(n) => (false, format!("{n} failed migration(s)")),
        Err(e) => {
            tracing::error!(error = %e, "readyz: database check failed");
            (false, "database unreachable or not migrated".to_string())
        }
    };
    let redis = match st.redis.clone() {
        None => "not_configured",
        Some(mut r) => match redis::cmd("PING").query_async::<String>(&mut r).await {
            Ok(_) => "ok",
            Err(_) => "unreachable",
        },
    };
    let body = json!({"ok": db_ok, "checks": {"postgres": detail, "redis": redis}, "warnings": if redis == "unreachable" { json!(["redis unreachable: caps fall back to Postgres"]) } else { json!([]) }});
    (
        if db_ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(body),
    )
        .into_response()
}

pub async fn metrics(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(t) = &st.config.metrics_token {
        let given = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        if !ct_eq(given.as_bytes(), t.as_bytes()) {
            return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        }
    }
    // Gauges are computed at scrape time from Postgres.
    if let Ok(rows) = sqlx::query_as::<_, (String, i64)>(
        "SELECT kind, count(*) FROM approvals WHERE status = 'pending' GROUP BY kind",
    )
    .fetch_all(&st.db)
    .await
    {
        st.metrics.approvals_pending.reset();
        for (k, n) in rows {
            st.metrics.approvals_pending.with_label_values(&[&k]).set(n);
        }
    }
    if let Ok(n) = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE kill_switch")
        .fetch_one(&st.db)
        .await
    {
        st.metrics
            .kill_switch
            .with_label_values(&[] as &[&str])
            .set(i64::from(n > 0));
    }
    if let Ok(rows) = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT status, stream, count(*) FROM emails WHERE status IN ('queued','deferred','pending_approval') GROUP BY status, stream",
    )
    .fetch_all(&st.db)
    .await
    {
        st.metrics.queue_depth.reset();
        for (s, t, n) in rows {
            st.metrics.queue_depth.with_label_values(&[&s, &t]).set(n);
        }
    }
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        st.metrics.render(),
    )
        .into_response()
}
