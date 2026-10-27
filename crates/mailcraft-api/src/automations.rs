//! `/v1/automations`: install (validated `Definition`), list/get, publish (activate), pause/resume, runs.
//! Execution belongs to the automations `Engine` the engine worker ticks; these routes only edit state.
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use mailcraft_automations::{Definition, Engine, EngineConfig, NoopPersonalizer};
use mailcraft_core::auth::Scope;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{
        envelope, envelope_list, invalid, json_or_default, not_found, ApiError, ApiJson, ApiResult,
    },
    page,
    services::ae,
    state::AppState,
};

#[derive(sqlx::FromRow, Serialize)]
struct AutomationView {
    id: Uuid,
    name: String,
    status: String,
    trigger_event: String,
    entry_rule: String,
    entry_days: Option<i32>,
    goal: Option<Value>,
    approval: String,
    caps: Value,
    current_version: i32,
    created_at: DateTime<Utc>,
}

const COLS: &str = "id, name, status, trigger_event, entry_rule, entry_days, goal, approval, caps, current_version, created_at";

async fn find(st: &AppState, ws: Uuid, id_or_name: &str) -> ApiResult<AutomationView> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM automations WHERE workspace_id = $1 AND (id::text = $2 OR name = $2)"
    ))
    .bind(ws)
    .bind(id_or_name)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("automation"))
}

/// Accepts the `Definition` as is, or the client form with a top-level `trigger` (event name, or the trigger
/// step's config object) that becomes the first step.
fn definition(mut raw: Value) -> ApiResult<Definition> {
    if let Some(t) = raw.as_object_mut().and_then(|o| o.remove("trigger")) {
        let config = if t.is_string() {
            json!({"event": t})
        } else {
            t
        };
        let steps = raw["steps"]
            .as_array_mut()
            .ok_or_else(|| invalid("steps must be an array").field("steps"))?;
        if steps.iter().any(|s| s["type"] == "trigger") {
            return Err(
                invalid("give either `trigger` or a trigger step, not both").field("trigger")
            );
        }
        let next = steps
            .first()
            .and_then(|s| s["key"].as_str())
            .map(String::from);
        let mut step = json!({"key": "trigger", "type": "trigger", "config": config});
        if let Some(n) = next {
            step["next"] = json!(n);
        }
        steps.insert(0, step);
    }
    serde_json::from_value(raw)
        .map_err(|e| invalid(e.to_string()).hint_in("see openapi.yaml for the request schema"))
}

/// Installs a new version (or creates the automation) in `draft`; `publish` activates it.
pub async fn install(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(raw): ApiJson<Value>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let def = definition(raw)?;
    let ws = auth.0.workspace_id;
    let mut g = begin!(st, auth, headers, "POST /v1/automations", def);
    // `install` validates and writes on the pool; the idempotency claim commits with the response.
    let (id, version) = mailcraft_automations::install(&st.db, ws, &def)
        .await
        .map_err(|e| ApiError(ae(e)))?;
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "automation.install",
            args: json!({"automation_id": id, "name": def.name, "version": version}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    let status: String = sqlx::query_scalar("SELECT status FROM automations WHERE id = $1")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    g.finish(StatusCode::CREATED, json!({"id": id, "name": def.name, "version": version, "status": status, "trigger": def.trigger_event(), "steps": def.steps})).await
}

#[derive(Deserialize)]
pub struct ListQ {
    limit: Option<u32>,
    cursor: Option<String>,
    status: Option<String>,
}

pub async fn list(State(st): State<AppState>, auth: Auth, Query(q): Query<ListQ>) -> ApiResult {
    auth.require(Scope::Read)?;
    let (at, after) = page::decode(q.cursor.as_deref())?;
    let lim = page::limit(q.limit);
    let mut rows: Vec<AutomationView> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM automations WHERE workspace_id = $1 AND ($4::text IS NULL OR status = $4) AND (created_at, id::text) < ($2, $3) \
         ORDER BY created_at DESC, id::text DESC LIMIT $5"
    ))
    .bind(auth.0.workspace_id)
    .bind(at)
    .bind(after)
    .bind(&q.status)
    .bind(lim + 1)
    .fetch_all(&st.db)
    .await?;
    let next = (rows.len() as i64 > lim).then(|| {
        rows.truncate(lim as usize);
        let l = rows.last().unwrap();
        page::encode(l.created_at, l.id)
    });
    Ok(envelope_list(rows, next))
}

pub async fn get(State(st): State<AppState>, auth: Auth, Path(id): Path<String>) -> ApiResult {
    auth.require(Scope::Read)?;
    let a = find(&st, auth.0.workspace_id, &id).await?;
    let steps: Value = sqlx::query_scalar(
        "SELECT steps FROM automation_versions WHERE automation_id = $1 AND version = $2",
    )
    .bind(a.id)
    .bind(a.current_version)
    .fetch_one(&st.db)
    .await?;
    let mut out = serde_json::to_value(&a).unwrap_or_default();
    out["steps"] = steps;
    out["trigger"] = json!(a.trigger_event);
    Ok(envelope(StatusCode::OK, out))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct PublishBody {
    /// Mark contacts that already match the trigger as entered-and-exited, so existing users are not mailed.
    #[serde(default)]
    pub backfill_suppress: bool,
}

pub async fn publish(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let b: PublishBody = json_or_default(&body)?;
    let ws = auth.0.workspace_id;
    let a = find(&st, ws, &id).await?;
    let engine = Engine::new(
        st.db.clone(),
        Arc::new(NoopPersonalizer),
        EngineConfig::default(),
    );
    engine
        .activate(a.id, b.backfill_suppress, Utc::now())
        .await
        .map_err(|e| ApiError(ae(e)))?;
    audit::append_standalone(
        &st.db,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "automation.publish",
            args: json!({"automation_id": a.id, "backfill_suppress": b.backfill_suppress}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"id": a.id, "name": a.name, "status": "active", "version": a.current_version}),
    ))
}

async fn set_status(
    st: &AppState,
    auth: &Auth,
    id: &str,
    from: &[&str],
    to: &str,
    action: &'static str,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let a = find(st, ws, id).await?;
    if !from.contains(&a.status.as_str()) {
        return Err(crate::error::err(
            "invalid_state",
            409,
            format!(
                "automation is `{}`; {action} needs {}",
                a.status,
                from.join(" or ")
            ),
        ));
    }
    sqlx::query("UPDATE automations SET status = $2 WHERE id = $1")
        .bind(a.id)
        .bind(to)
        .execute(&st.db)
        .await?;
    audit::append_standalone(
        &st.db,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action,
            args: json!({"automation_id": a.id}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"id": a.id, "name": a.name, "status": to}),
    ))
}

pub async fn pause(State(st): State<AppState>, auth: Auth, Path(id): Path<String>) -> ApiResult {
    set_status(&st, &auth, &id, &["active"], "paused", "automation.pause").await
}

pub async fn resume(State(st): State<AppState>, auth: Auth, Path(id): Path<String>) -> ApiResult {
    set_status(&st, &auth, &id, &["paused"], "active", "automation.resume").await
}

#[derive(Deserialize)]
pub struct RunsQ {
    limit: Option<u32>,
    cursor: Option<String>,
    status: Option<String>,
}

#[derive(sqlx::FromRow, Serialize)]
struct RunView {
    id: Uuid,
    version: i32,
    contact_id: Uuid,
    state: String,
    current_step: Option<String>,
    next_wake_at: Option<DateTime<Utc>>,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
}

pub async fn runs(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
    Query(q): Query<RunsQ>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let a = find(&st, auth.0.workspace_id, &id).await?;
    if q.status
        .as_deref()
        .is_some_and(|s| !["active", "waiting", "completed", "exited", "failed"].contains(&s))
    {
        return Err(
            invalid("status must be active|waiting|completed|exited|failed").field("status"),
        );
    }
    let (at, after) = page::decode(q.cursor.as_deref())?;
    let lim = page::limit(q.limit);
    let mut rows: Vec<RunView> = sqlx::query_as(
        "SELECT id, version, contact_id, state, current_step, next_wake_at, started_at, ended_at FROM automation_runs \
         WHERE automation_id = $1 AND ($4::text IS NULL OR state = $4) AND (started_at, id::text) < ($2, $3) \
         ORDER BY started_at DESC, id::text DESC LIMIT $5",
    )
    .bind(a.id)
    .bind(at)
    .bind(after)
    .bind(&q.status)
    .bind(lim + 1)
    .fetch_all(&st.db)
    .await?;
    let next = (rows.len() as i64 > lim).then(|| {
        rows.truncate(lim as usize);
        let l = rows.last().unwrap();
        page::encode(l.started_at, l.id)
    });
    Ok(envelope_list(rows, next))
}
