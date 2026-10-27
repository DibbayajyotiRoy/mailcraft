//! Thin handlers over the service traits in `mailcraft_core::services` (domains: WP3;
//! contacts, segments, events: WP4). Auth, scopes, idempotency and audit live here; logic does not.
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use mailcraft_core::{
    auth::Scope,
    services::{AddDomain, TrackEvent, UpsertContact},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{envelope, envelope_list, invalid, ApiJson, ApiResult},
    idem::{header_key, Begin, Guard},
    state::AppState,
};

async fn record(st: &AppState, auth: &Auth, action: &str, args: Value) -> ApiResult<()> {
    audit::append_standalone(
        &st.db,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action,
            args,
            decision: "auto",
            approval_id: None,
        },
    )
    .await
}

/// Runs `f` once per idempotency key: the stored response is replayed on retries. The service
/// call happens between begin and finish, so a failure leaves the key unclaimed.
macro_rules! idempotent {
    ($st:expr, $auth:expr, $headers:expr, $route:expr, $body:expr, $status:expr, $f:expr) => {{
        match Guard::begin(&$st, &$auth.0, &$headers, $route, &$body).await? {
            Begin::Replay(r) => return Ok(r),
            Begin::Fresh(g) => {
                let out = $f.await?;
                g.finish($status, out).await
            }
        }
    }};
}

// ------------------------------------------------------------------ domains

pub async fn domains_add(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<AddDomain>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let r = idempotent!(
        st,
        auth,
        headers,
        "POST /v1/domains",
        b,
        StatusCode::CREATED,
        st.domains.add(ws, b.clone())
    );
    record(&st, &auth, "domain.add", json!({"domain": b.domain})).await?;
    r
}

pub async fn domains_list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    Ok(envelope_list(
        st.domains.list(auth.0.workspace_id).await?,
        None,
    ))
}

pub async fn domains_get(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    Ok(envelope(
        StatusCode::OK,
        st.domains.get(auth.0.workspace_id, id).await?,
    ))
}

pub async fn domains_verify(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let v = st.domains.verify(auth.0.workspace_id, id).await?;
    Ok(envelope(StatusCode::OK, v))
}

pub async fn domains_rotate(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let v = st.domains.rotate_dkim(auth.0.workspace_id, id).await?;
    record(&st, &auth, "domain.rotate_dkim", json!({"domain_id": id})).await?;
    Ok(envelope(StatusCode::OK, v))
}

pub async fn domains_delete(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    st.domains.delete(auth.0.workspace_id, id).await?;
    record(&st, &auth, "domain.delete", json!({"domain_id": id})).await?;
    Ok(envelope(StatusCode::OK, json!({"id": id, "deleted": true})))
}

// ----------------------------------------------------------------- contacts

pub async fn contacts_upsert(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<UpsertContact>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    idempotent!(
        st,
        auth,
        headers,
        "PUT /v1/contacts",
        b,
        StatusCode::OK,
        st.contacts.upsert(ws, b.clone())
    )
}

#[derive(Deserialize)]
pub struct ListQ {
    limit: Option<u32>,
    cursor: Option<String>,
}

pub async fn contacts_list(
    State(st): State<AppState>,
    auth: Auth,
    Query(q): Query<ListQ>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let p = st
        .contacts
        .list(
            auth.0.workspace_id,
            q.limit.unwrap_or(25).clamp(1, 100),
            q.cursor,
        )
        .await?;
    Ok(envelope_list(p.items, p.next_cursor))
}

pub async fn contacts_get(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    Ok(envelope(
        StatusCode::OK,
        st.contacts.get(auth.0.workspace_id, &id).await?,
    ))
}

pub async fn contacts_delete(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    st.contacts.delete(auth.0.workspace_id, &id).await?;
    record(&st, &auth, "contact.delete", json!({"contact": id})).await?;
    Ok(envelope(StatusCode::OK, json!({"deleted": true})))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Suppress {
    #[serde(default)]
    pub reason: Option<String>,
}

pub async fn contacts_suppress(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
    ApiJson(b): ApiJson<Suppress>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let reason = b.reason.unwrap_or_else(|| "manual".into());
    st.contacts
        .suppress(auth.0.workspace_id, &id, &reason)
        .await?;
    record(
        &st,
        &auth,
        "contact.suppress",
        json!({"contact": id, "reason": reason}),
    )
    .await?;
    Ok(envelope(StatusCode::OK, json!({"suppressed": true})))
}

// ----------------------------------------------------------------- segments

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateSegment {
    pub name: String,
    #[serde(default)]
    pub filter: Option<Value>,
}

pub async fn segments_create(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<CreateSegment>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    if b.name.trim().is_empty() {
        return Err(invalid("name is required").field("name"));
    }
    let ws = auth.0.workspace_id;
    idempotent!(
        st,
        auth,
        headers,
        "POST /v1/segments",
        b,
        StatusCode::CREATED,
        st.segments.create(ws, &b.name, b.filter.clone())
    )
}

pub async fn segments_list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Manage)?;
    Ok(envelope_list(
        st.segments.list(auth.0.workspace_id).await?,
        None,
    ))
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Members {
    pub emails: Vec<String>,
}

pub async fn segments_members(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    ApiJson(b): ApiJson<Members>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    if b.emails.is_empty() || b.emails.len() > 1000 {
        return Err(invalid("emails needs 1-1000 entries").field("emails"));
    }
    let ws = auth.0.workspace_id;
    let route = format!("POST /v1/segments/{id}/members");
    idempotent!(
        st,
        auth,
        headers,
        &route,
        b,
        StatusCode::OK,
        st.segments.add_members(ws, id, b.emails.clone())
    )
}

// ------------------------------------------------------------------- events

/// Track an event. `send` scope suffices (apps emit events with send-only keys, SPEC 7.1).
pub async fn events_track(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(mut b): ApiJson<TrackEvent>,
) -> ApiResult {
    if auth.require(Scope::Send).is_err() {
        auth.require(Scope::Manage)?;
    }
    if b.name.trim().is_empty() || b.name.len() > 128 {
        return Err(invalid("event name must be 1-128 characters").field("name"));
    }
    let ws = auth.0.workspace_id;
    b.idempotency_key = header_key(&headers)?;
    if b.dry_run {
        return Ok(envelope(StatusCode::OK, st.events.track(ws, b).await?));
    }
    idempotent!(
        st,
        auth,
        headers,
        "POST /v1/events",
        b,
        StatusCode::ACCEPTED,
        st.events.track(ws, b.clone())
    )
}
