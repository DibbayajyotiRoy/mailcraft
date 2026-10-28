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

pub(crate) async fn record(st: &AppState, auth: &Auth, action: &str, args: Value) -> ApiResult<()> {
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

/// Adds to each domain the transport it is bound to (`transport_id`) and, for a domain whose
/// addresses a mailbox relay logs in as or sends as (`relay_senders`; `relay_sender` is the first),
/// the marker that sends from those addresses need no domain records (see `senders::Routing`).
async fn with_relay(st: &AppState, ws: Uuid, mut d: Value) -> ApiResult<Value> {
    let relays = crate::senders::relays(st, ws).await?;
    let bound: std::collections::HashMap<Uuid, Uuid> = sqlx::query_as::<_, (Uuid, Uuid)>(
        "SELECT id, transport_id FROM domains WHERE workspace_id = $1 AND transport_id IS NOT NULL",
    )
    .bind(ws)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .collect();
    let mark = |v: &mut Value| {
        let name = v["name"].as_str().unwrap_or_default().to_ascii_lowercase();
        let addrs: Vec<&String> = relays
            .iter()
            .flat_map(|r| r.addresses())
            .filter(|a| mailcraft_core::address::domain_of(a).eq_ignore_ascii_case(&name))
            .collect();
        if let Some(first) = addrs.first() {
            v["relay_sender"] = json!(first);
            v["relay_senders"] = json!(addrs);
        }
        v["transport_id"] = v["id"]
            .as_str()
            .and_then(|i| i.parse::<Uuid>().ok())
            .and_then(|i| bound.get(&i))
            .map_or(Value::Null, |t| json!(t));
    };
    match d.as_array_mut() {
        Some(a) => a.iter_mut().for_each(mark),
        None => mark(&mut d),
    }
    Ok(d)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PatchDomain {
    /// Send from this domain through this transport; `null` = the workspace default.
    pub transport_id: Option<Uuid>,
}

pub async fn domains_patch(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<PatchDomain>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    if let Some(t) = b.transport_id {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM transports WHERE id = $1 AND workspace_id = $2)",
        )
        .bind(t)
        .bind(ws)
        .fetch_one(&st.db)
        .await?;
        if !ok {
            return Err(not_found("transport").field("transport_id"));
        }
    }
    let n = sqlx::query("UPDATE domains SET transport_id = $3 WHERE id = $1 AND workspace_id = $2")
        .bind(id)
        .bind(ws)
        .bind(b.transport_id)
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(not_found("domain"));
    }
    record(
        &st,
        &auth,
        "domain.update",
        json!({"domain_id": id, "transport_id": b.transport_id}),
    )
    .await?;
    let d = serde_json::to_value(st.domains.get(ws, id).await?).unwrap_or_default();
    Ok(envelope(StatusCode::OK, with_relay(&st, ws, d).await?))
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
    /// Only members of this list (id or name).
    list: Option<String>,
}

pub async fn contacts_list(
    State(st): State<AppState>,
    auth: Auth,
    Query(q): Query<ListQ>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let list = match q.list.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        Some(l) => Some(crate::lists::resolve(&st, ws, l).await?),
        None => None,
    };
    let p = st
        .contacts
        .list(ws, q.limit.unwrap_or(25).clamp(1, 100), q.cursor, q.q, list)
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
    /// Add every imported contact (new or existing) to this list (id or name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_id: Option<String>,
    /// Same, by display name: the list is found, or created (origin `import`) when new.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_name: Option<String>,
    /// Report what each row would do (`new`, `update` with the changed fields, `unchanged`, `skipped`)
    /// and change nothing, not even the list.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dry_run: bool,
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
    if b.dry_run {
        return import_preview(&st, ws, &b).await;
    }
    let list =
        crate::lists::for_import(&st, ws, b.list_id.as_deref(), b.list_name.as_deref()).await?;
    let r = idempotent!(
        st,
        auth,
        headers,
        "POST /v1/contacts/import",
        b,
        StatusCode::OK,
        async {
            let (mut imported, mut failed) = (0, Vec::new());
            let now = chrono::Utc::now();
            for (index, c) in b.contacts.iter().cloned().enumerate() {
                let email = c.email.clone();
                match st.contacts.upsert(ws, c).await {
                Ok(v) => {
                    imported += 1;
                    if let (Some(l), Some(id)) = (list, v["id"].as_str().and_then(|i| i.parse().ok())) {
                        mailcraft_automations::contacts::add_to_segment(&st.db, l, id, now).await.map_err(crate::services::ae)?;
                    }
                }
                // Infrastructure trouble would repeat for every row: stop and let the caller retry.
                Err(e) if e.status >= 500 => return Err(e),
                Err(e) => failed.push(json!({"index": index, "email": email, "error": {"code": e.code, "message": e.message}})),
            }
            }
            Ok::<_, mailcraft_core::Error>(
                json!({"imported": imported, "failed": failed, "list_id": list}),
            )
        }
    );
    record(
        &st,
        &auth,
        "contact.import",
        json!({"rows": b.contacts.len(), "list_id": list}),
    )
    .await?;
    r
}

/// Dry run of [`contacts_import`]: classifies every row against the stored contacts. Writes nothing.
async fn import_preview(st: &AppState, ws: Uuid, b: &ImportContacts) -> ApiResult {
    use crate::diff;
    use mailcraft_automations::contacts::{normalize_email, valid_timezone};
    let target = crate::lists::target(st, ws, b.list_id.as_deref(), b.list_name.as_deref()).await?;
    let emails: Vec<String> = b
        .contacts
        .iter()
        .filter_map(|c| normalize_email(&c.email).ok())
        .collect();
    let have = diff::existing(&st.db, ws, &emails).await?;
    let on_list = match target.as_ref().and_then(|t| t.id) {
        Some(l) => {
            let ids: Vec<Uuid> = have.values().map(|c| c.id).collect();
            diff::members(&st.db, l, &ids).await?
        }
        None => Default::default(),
    };
    let (mut new, mut update, mut unchanged, mut skipped, mut list_adds) = (0, 0, 0, 0, 0);
    let mut rows = Vec::with_capacity(b.contacts.len());
    for (index, c) in b.contacts.iter().enumerate() {
        let skip = |reason: &str, message: String| json!({"index": index, "email": c.email.trim(), "status": "skipped", "reason": reason, "message": message});
        let Ok(email) = normalize_email(&c.email) else {
            skipped += 1;
            rows.push(skip(
                "invalid_email",
                format!("`{}` is not a valid email address", c.email.trim()),
            ));
            continue;
        };
        if c.properties.as_ref().is_some_and(|p| !p.is_object()) {
            skipped += 1;
            rows.push(skip(
                "invalid_properties",
                "properties must be a JSON object".into(),
            ));
            continue;
        }
        let tz = c
            .timezone
            .as_deref()
            .or_else(|| c.properties.as_ref().and_then(|p| p["timezone"].as_str()))
            .map(str::trim)
            .filter(|t| !t.is_empty());
        if let Some(t) = tz.filter(|t| !valid_timezone(t)) {
            skipped += 1;
            rows.push(skip(
                "invalid_timezone",
                format!("`{t}` is not an IANA timezone (e.g. Europe/Berlin)"),
            ));
            continue;
        }
        let existing = have.get(&email);
        let changes = existing.map_or_else(Vec::new, |e| {
            diff::changes(
                e,
                c.first_name.as_deref(),
                c.last_name.as_deref(),
                tz,
                c.properties.as_ref(),
            )
        });
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
        let list = target.as_ref().map(|_| {
            if existing.is_some_and(|e| on_list.contains(&e.id)) {
                "already"
            } else {
                "add"
            }
        });
        list_adds += usize::from(list == Some("add"));
        // A new contact has nothing to compare with: say what it would be created with.
        let values = (status == "new").then(|| {
            json!({"first_name": c.first_name, "last_name": c.last_name, "timezone": tz, "properties": c.properties})
        });
        rows.push(json!({"index": index, "email": email, "status": status, "changes": changes, "list": list, "values": values}));
    }
    Ok(envelope(
        StatusCode::OK,
        json!({
            "dry_run": true,
            "summary": {"new": new, "update": update, "unchanged": unchanged, "skipped": skipped, "list_adds": list_adds},
            "list": target.map(|t| json!({"id": t.id, "name": t.name, "exists": t.id.is_some()})),
            "rows": rows,
        }),
    ))
}
