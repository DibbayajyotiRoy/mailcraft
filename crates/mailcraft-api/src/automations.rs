//! `/v1/automations`: install (validated `Definition`), list/get, publish (activate), pause/resume,
//! archive/unarchive, test run, runs (+ one run's step log), and the known event names.
//! Execution belongs to the automations `Engine` the engine worker ticks; these routes only edit state.
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use mailcraft_automations::{ContactInput, Definition, Engine, EngineConfig, NoopPersonalizer};
use mailcraft_core::auth::Scope;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{
        envelope, envelope_list, err, invalid, json_or_default, not_found, ApiError, ApiJson,
        ApiResult,
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
        "SELECT {COLS} FROM automations WHERE workspace_id = $1 AND (($4::text IS NULL AND status <> 'archived') OR status = $4) AND (created_at, id::text) < ($2, $3) \
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
    out["stats"] = step_stats(&st, a.id).await?;
    out["steps"] = steps;
    out["trigger"] = json!(a.trigger_event);
    Ok(envelope(StatusCode::OK, out))
}

/// Per step key, over every run of every version: `entered` runs that reached the step (ran it or
/// sit on it), `active` still on it (active or waiting), `failed` hit a fatal error there, `exited`
/// left the automation while on it, `completed` = the rest (moved past it).
async fn step_stats(st: &AppState, automation: Uuid) -> ApiResult<Value> {
    use std::collections::{BTreeMap, BTreeSet};
    // (step, run, fatal error logged there)
    let logged: Vec<(String, Uuid, bool)> = sqlx::query_as(
        "SELECT s.step_key, s.run_id, bool_or(COALESCE((s.result->>'failed')::boolean, false)) \
         FROM automation_run_steps s JOIN automation_runs r ON r.id = s.run_id \
         WHERE r.automation_id = $1 AND s.step_key NOT LIKE '\\_%' GROUP BY 1, 2",
    )
    .bind(automation)
    .fetch_all(&st.db)
    .await?;
    let on: Vec<(String, Uuid, String)> = sqlx::query_as(
        "SELECT current_step, id, state FROM automation_runs WHERE automation_id = $1 AND current_step IS NOT NULL",
    )
    .bind(automation)
    .fetch_all(&st.db)
    .await?;
    #[derive(Default)]
    struct S {
        runs: BTreeSet<Uuid>,
        failed: BTreeSet<Uuid>,
        active: u64,
        exited: u64,
    }
    let mut m: BTreeMap<String, S> = BTreeMap::new();
    for (k, run, failed) in logged {
        let e = m.entry(k).or_default();
        e.runs.insert(run);
        if failed {
            e.failed.insert(run);
        }
    }
    for (k, run, state) in on {
        let e = m.entry(k).or_default();
        e.runs.insert(run);
        match state.as_str() {
            "active" | "waiting" => e.active += 1,
            "exited" => e.exited += 1,
            "failed" => {
                e.failed.insert(run);
            }
            _ => {}
        }
    }
    Ok(Value::Object(
        m.into_iter()
            .map(|(k, s)| {
                let (entered, failed) = (s.runs.len() as u64, s.failed.len() as u64);
                let completed = entered.saturating_sub(s.active + s.exited + failed);
                (k, json!({"entered": entered, "completed": completed, "failed": failed, "active": s.active, "exited": s.exited}))
            })
            .collect(),
    ))
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
    if a.status == "archived" {
        return Err(err(
            "invalid_state",
            409,
            "automation is `archived`; unarchive it before publishing",
        ));
    }
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

/// Archived automations leave the default list and never run; only a draft or paused one can be archived.
pub async fn archive(State(st): State<AppState>, auth: Auth, Path(id): Path<String>) -> ApiResult {
    set_status(
        &st,
        &auth,
        &id,
        &["draft", "paused"],
        "archived",
        "automation.archive",
    )
    .await
}

/// Back to `draft`: publish it again to go live.
pub async fn unarchive(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult {
    set_status(
        &st,
        &auth,
        &id,
        &["archived"],
        "draft",
        "automation.unarchive",
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestRunBody {
    pub email: String,
    #[serde(default)]
    pub first_name: Option<String>,
    /// Properties of the simulated trigger event (`event.*` in filters, `$event.x` in variables).
    #[serde(default)]
    pub properties: Option<Value>,
    #[serde(default)]
    pub contact_properties: Option<Value>,
}

/// Start a run for one contact now, whatever the automation's status, skipping its entry rule. A test
/// key keeps every email in the sandbox; a live key sends for real once the workspace is live.
pub async fn test_run(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
    ApiJson(b): ApiJson<TestRunBody>,
) -> ApiResult {
    if auth.require(Scope::Send).is_err() {
        auth.require(Scope::Manage)?;
    }
    let ws = auth.0.workspace_id;
    let a = find(&st, ws, &id).await?;
    if a.status == "archived" {
        return Err(err(
            "invalid_state",
            409,
            "automation is `archived`; unarchive it to test it",
        ));
    }
    let engine = Engine::new(
        st.db.clone(),
        Arc::new(NoopPersonalizer),
        EngineConfig::default(),
    );
    let env = auth.0.env.as_str();
    let contact = ContactInput {
        email: b.email,
        first_name: b.first_name,
        properties: b.contact_properties,
        ..Default::default()
    };
    let (run_id, contact_id) = engine
        .start_test_run(
            ws,
            a.id,
            contact.clone(),
            b.properties.unwrap_or(Value::Null),
            env,
            Utc::now(),
        )
        .await
        .map_err(|e| ApiError(ae(e)))?;
    audit::append_standalone(
        &st.db,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "automation.test_run",
            args: json!({"automation_id": a.id, "run_id": run_id, "email": contact.email, "env": env}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    Ok(envelope(
        StatusCode::ACCEPTED,
        json!({"run_id": run_id, "automation_id": a.id, "contact_id": contact_id, "env": env, "status": "started"}),
    ))
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
    contact_email: String,
    state: String,
    current_step: Option<String>,
    next_wake_at: Option<DateTime<Utc>>,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    /// Why an `exited` run left (`goal`, `suppressed`, `topic_opt_out`, `exit_step`, ...).
    exit_reason: Option<String>,
    /// Started by a dashboard/API test run.
    test: bool,
}

const RUN_COLS: &str = "r.id, r.version, r.contact_id, c.email AS contact_email, r.state, r.current_step, r.next_wake_at, \
    r.started_at, r.ended_at, r.context->>'exit_reason' AS exit_reason, (r.context->'test') IS NOT NULL AS test";

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
    let mut rows: Vec<RunView> = sqlx::query_as(&format!(
        "SELECT {RUN_COLS} FROM automation_runs r JOIN contacts c ON c.id = r.contact_id \
         WHERE r.automation_id = $1 AND ($4::text IS NULL OR r.state = $4) AND (r.started_at, r.id::text) < ($2, $3) \
         ORDER BY r.started_at DESC, r.id::text DESC LIMIT $5"
    ))
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

/// One run with its step log (`step_key`, what the engine decided, when): why an email was held, a wait
/// timed out, the run exited.
pub async fn run_get(
    State(st): State<AppState>,
    auth: Auth,
    Path((id, run)): Path<(String, String)>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let a = find(&st, auth.0.workspace_id, &id).await?;
    let run = Uuid::parse_str(&run).map_err(|_| not_found("run"))?;
    let r: RunView = sqlx::query_as(&format!(
        "SELECT {RUN_COLS} FROM automation_runs r JOIN contacts c ON c.id = r.contact_id WHERE r.id = $1 AND r.automation_id = $2"
    ))
    .bind(run)
    .bind(a.id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("run"))?;
    let steps: Vec<(String, Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT step_key, result, at FROM automation_run_steps WHERE run_id = $1 ORDER BY id",
    )
    .bind(run)
    .fetch_all(&st.db)
    .await?;
    let mut out = serde_json::to_value(&r).unwrap_or_default();
    out["steps"] = steps
        .into_iter()
        .map(|(key, result, at)| json!({"step_key": key, "result": result, "at": at}))
        .collect();
    Ok(envelope(StatusCode::OK, out))
}

/// Event names this workspace has tracked in the last 90 days, newest first (trigger suggestions).
pub async fn event_names(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    let rows: Vec<(String, i64, DateTime<Utc>)> = sqlx::query_as(
        "SELECT name, count(*), max(received_at) FROM track_events \
         WHERE workspace_id = $1 AND received_at > now() - interval '90 days' \
         GROUP BY name ORDER BY max(received_at) DESC LIMIT 100",
    )
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    Ok(envelope(
        StatusCode::OK,
        rows.into_iter()
            .map(|(name, count, last_seen_at)| json!({"name": name, "count": count, "last_seen_at": last_seen_at}))
            .collect::<Vec<_>>(),
    ))
}
