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
    error::{envelope, envelope_list, invalid, not_found, ApiError, ApiJson, ApiResult},
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

/// Marks a domain whose mailbox the default relay logs in as (`relay_sender`): sends from that
/// address need no domain records (see `emails::mailbox_relay_sender`).
async fn with_relay(st: &AppState, ws: Uuid, mut d: Value) -> ApiResult<Value> {
    if let Some(m) = crate::emails::mailbox_relay_sender(st, ws).await? {
        let dom = mailcraft_core::address::domain_of(&m).to_ascii_lowercase();
        let mark = |v: &mut Value| {
            if v["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(&dom))
            {
                v["relay_sender"] = json!(m);
            }
        };
        match d.as_array_mut() {
            Some(a) => a.iter_mut().for_each(mark),
            None => mark(&mut d),
        }
    }
    Ok(d)
}

pub async fn domains_list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    let ws = auth.0.workspace_id;
    let list = serde_json::to_value(st.domains.list(ws).await?).unwrap_or_default();
    Ok(envelope_list(with_relay(&st, ws, list).await?, None))
}

pub async fn domains_get(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let ws = auth.0.workspace_id;
    let d = serde_json::to_value(st.domains.get(ws, id).await?).unwrap_or_default();
    Ok(envelope(StatusCode::OK, with_relay(&st, ws, d).await?))
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
    /// Case-insensitive substring of email / first name / last name.
    q: Option<String>,
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
            q.q,
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
    let r = idempotent!(
        st,
        auth,
        headers,
        "POST /v1/segments",
        b,
        StatusCode::CREATED,
        st.segments.create(ws, &b.name, b.filter.clone())
    );
    record(&st, &auth, "segment.create", json!({"name": b.name})).await?;
    r
}

/// Full replace: `filter: null` (or absent) makes it a manual list.
pub async fn segments_update(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<CreateSegment>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    if b.name.trim().is_empty() {
        return Err(invalid("name is required").field("name"));
    }
    let v = st
        .segments
        .update(auth.0.workspace_id, id, b.name.trim(), b.filter)
        .await?;
    record(
        &st,
        &auth,
        "segment.update",
        json!({"segment": id, "name": b.name}),
    )
    .await?;
    Ok(envelope(StatusCode::OK, v))
}

pub async fn segments_delete(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    st.segments.delete(auth.0.workspace_id, id).await?;
    record(&st, &auth, "segment.delete", json!({"segment": id})).await?;
    Ok(envelope(StatusCode::OK, json!({"id": id, "deleted": true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewSegment {
    pub filter: Value,
}

/// Who a filter matches right now (count + a few examples). Stores nothing.
pub async fn segments_preview(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<PreviewSegment>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    Ok(envelope(
        StatusCode::OK,
        st.segments.preview(auth.0.workspace_id, b.filter).await?,
    ))
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

// ------------------------------------------------- domain DKIM + DNS provider

use mailcraft_deliverability::{
    dns::cloudflare::Cloudflare,
    service as dsvc,
    store::{
        postgres::{PgDomains, PgKeys},
        DomainStore, KeyStore,
    },
};

/// Deliverability stores for a domain the caller owns. 501 when the state has no real services.
async fn dstores(st: &AppState, auth: &Auth, id: Uuid) -> ApiResult<(PgDomains, PgKeys)> {
    let secret = st
        .dkim_box
        .clone()
        .ok_or_else(|| ApiError(mailcraft_core::Error::not_implemented("domains")))?;
    let domains = PgDomains::new(st.db.clone());
    match domains.get(id).await? {
        Some(d) if d.workspace_id == auth.0.workspace_id => {}
        _ => return Err(not_found("domain")),
    }
    Ok((domains, PgKeys::new(st.db.clone(), secret)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivateDkim {
    pub selector: String,
}

/// Switch signing to a standby selector (after `rotate-dkim` and its record verified).
pub async fn dkim_activate(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<ActivateDkim>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let (_, keys) = dstores(&st, &auth, id).await?;
    if !keys
        .list(id)
        .await?
        .iter()
        .any(|k| k.selector == b.selector)
    {
        return Err(not_found("dkim selector"));
    }
    dsvc::activate_dkim(&keys, id, &b.selector, chrono::Utc::now().timestamp()).await?;
    record(
        &st,
        &auth,
        "domain.activate_dkim",
        json!({"domain_id": id, "selector": b.selector}),
    )
    .await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"keys": keys.list(id).await?}),
    ))
}

/// Delete retired keys older than 7 days (and their records).
pub async fn dkim_purge(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let (domains, keys) = dstores(&st, &auth, id).await?;
    let gone =
        dsvc::purge_retired_dkim(&domains, &keys, id, chrono::Utc::now().timestamp()).await?;
    record(
        &st,
        &auth,
        "domain.purge_dkim",
        json!({"domain_id": id, "selectors": gone}),
    )
    .await?;
    Ok(envelope(StatusCode::OK, json!({"purged": gone})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DnsSync {
    /// Only `cloudflare` today.
    pub provider: String,
    /// Report the changes without writing them.
    #[serde(default)]
    pub dry_run: bool,
    /// Zone:Read + DNS:Edit token; used for this call only. Falls back to `CLOUDFLARE_API_TOKEN`.
    #[serde(default)]
    pub api_token: Option<String>,
}

pub async fn dns_sync(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<DnsSync>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    if b.provider != "cloudflare" {
        return Err(invalid("provider must be `cloudflare`").field("provider"));
    }
    let token = b
        .api_token
        .clone()
        .or_else(|| std::env::var("CLOUDFLARE_API_TOKEN").ok())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            invalid("no Cloudflare token")
                .field("api_token")
                .hint_in("pass api_token or set CLOUDFLARE_API_TOKEN on the server")
        })?;
    let (domains, _) = dstores(&st, &auth, id).await?;
    let changes = dsvc::sync_cloudflare(&domains, &Cloudflare::new(token), id, b.dry_run).await?;
    if !b.dry_run {
        record(
            &st,
            &auth,
            "domain.dns_sync",
            json!({"domain_id": id, "provider": "cloudflare", "changes": changes.len()}),
        )
        .await?;
    }
    Ok(envelope(
        StatusCode::OK,
        json!({"provider": "cloudflare", "dry_run": b.dry_run, "changes": changes}),
    ))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PatchContact {
    /// `""` clears the name.
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    /// IANA name; `""` clears it.
    #[serde(default)]
    pub timezone: Option<String>,
    /// Merged shallowly into existing properties; a `null` value deletes that key.
    #[serde(default)]
    pub properties: Option<Value>,
}

pub async fn contacts_patch(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
    ApiJson(b): ApiJson<PatchContact>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let mut changed: Vec<&str> = Vec::new();
    for (k, set) in [
        ("first_name", b.first_name.is_some()),
        ("last_name", b.last_name.is_some()),
        ("timezone", b.timezone.is_some()),
        ("properties", b.properties.is_some()),
    ] {
        if set {
            changed.push(k);
        }
    }
    let v = st
        .contacts
        .update(
            ws,
            &id,
            UpsertContact {
                email: String::new(),
                first_name: b.first_name,
                last_name: b.last_name,
                timezone: b.timezone,
                properties: b.properties,
            },
        )
        .await?;
    // Field names only: values are personal data.
    record(
        &st,
        &auth,
        "contact.update",
        json!({"contact": id, "fields": changed}),
    )
    .await?;
    Ok(envelope(StatusCode::OK, v))
}

pub async fn contacts_activity(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    Ok(envelope(
        StatusCode::OK,
        st.contacts.activity(auth.0.workspace_id, &id).await?,
    ))
}

const IMPORT_MAX: usize = 5000;

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ImportContacts {
    pub contacts: Vec<UpsertContact>,
}

/// Upsert up to 5000 contacts in one call. A bad row is reported and skipped, never fatal.
pub async fn contacts_import(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<ImportContacts>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    if b.contacts.is_empty() || b.contacts.len() > IMPORT_MAX {
        return Err(invalid(format!("contacts needs 1-{IMPORT_MAX} entries")).field("contacts"));
    }
    let ws = auth.0.workspace_id;
    let r = idempotent!(
        st,
        auth,
        headers,
        "POST /v1/contacts/import",
        b,
        StatusCode::OK,
        async {
            let (mut imported, mut failed) = (0, Vec::new());
            for (index, c) in b.contacts.iter().cloned().enumerate() {
                let email = c.email.clone();
                match st.contacts.upsert(ws, c).await {
                Ok(_) => imported += 1,
                // Infrastructure trouble would repeat for every row: stop and let the caller retry.
                Err(e) if e.status >= 500 => return Err(e),
                Err(e) => failed.push(json!({"index": index, "email": email, "error": {"code": e.code, "message": e.message}})),
            }
            }
            Ok::<_, mailcraft_core::Error>(json!({"imported": imported, "failed": failed}))
        }
    );
    record(
        &st,
        &auth,
        "contact.import",
        json!({"rows": b.contacts.len()}),
    )
    .await?;
    r
}
