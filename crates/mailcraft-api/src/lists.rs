//! `/v1/lists`: contact lists. A list is a manual segment (`segments.filter IS NULL`) that also knows
//! where its members came from (`origin`: manual | import | source), so automations (`segment.entered`,
//! `add_to_segment`), segment rules (`list:<id|name>`) and `GET /v1/contacts?list=` all work on it.
//! Deleting a list never deletes contacts or touches suppressions.
use std::collections::HashSet;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use mailcraft_core::auth::Scope;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{envelope, envelope_list, err, invalid, not_found, ApiError, ApiJson, ApiResult},
    integrations::record,
    services::segment_users,
    state::AppState,
};

const MEMBERS_MAX: usize = 1000;

#[derive(sqlx::FromRow, Serialize)]
pub struct ListView {
    id: Uuid,
    name: String,
    description: Option<String>,
    /// `manual` | `import` | `source`.
    origin: String,
    /// The contact source feeding this list; null once the source is deleted (`detached`).
    source_id: Option<Uuid>,
    detached: bool,
    member_count: i64,
    created_at: DateTime<Utc>,
}

const COLS: &str = "s.id, s.name, s.description, s.origin, s.source_id, (s.origin = 'source' AND s.source_id IS NULL) AS detached, \
    (SELECT count(*) FROM segment_members m WHERE m.segment_id = s.id) AS member_count, s.created_at";

async fn load(st: &AppState, ws: Uuid, id: Uuid) -> ApiResult<ListView> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM segments s WHERE s.id = $1 AND s.workspace_id = $2 AND s.filter IS NULL"
    ))
    .bind(id)
    .bind(ws)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("list"))
}

/// A list's id from an id or an exact name. Rule-based segments are not lists.
pub async fn resolve(st: &AppState, ws: Uuid, id_or_name: &str) -> ApiResult<Uuid> {
    sqlx::query_scalar(
        "SELECT id FROM segments WHERE workspace_id = $1 AND filter IS NULL AND (id::text = $2 OR name = $2)",
    )
    .bind(ws)
    .bind(id_or_name)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("list").field("list"))
}

pub(crate) fn name_of(raw: &str) -> ApiResult<String> {
    let n = raw.trim();
    if n.is_empty() || n.chars().count() > 100 || n.chars().any(char::is_control) {
        return Err(invalid("name must be 1-100 characters").field("name"));
    }
    Ok(n.to_string())
}

fn description_of(raw: &str) -> ApiResult<Option<String>> {
    let d = raw.trim();
    if d.chars().count() > 500 {
        return Err(invalid("description is at most 500 characters").field("description"));
    }
    Ok((!d.is_empty()).then(|| d.to_string()))
}

/// Segments and lists share one name space per workspace.
fn taken(e: sqlx::Error, name: &str) -> ApiError {
    if e.as_database_error()
        .is_some_and(|d| d.is_unique_violation())
    {
        return err(
            "invalid_state",
            409,
            format!("a list or segment named `{name}` already exists"),
        )
        .field("name")
        .hint_in("pick another name");
    }
    e.into()
}

/// `base`, or `base (2)`, `base (3)`... when a segment already has that name.
pub(crate) async fn unique_name(
    conn: &mut PgConnection,
    ws: Uuid,
    base: &str,
) -> Result<String, sqlx::Error> {
    for n in 1..100 {
        let candidate = if n == 1 {
            base.to_string()
        } else {
            format!("{base} ({n})")
        };
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM segments WHERE workspace_id = $1 AND name = $2)",
        )
        .bind(ws)
        .bind(&candidate)
        .fetch_one(&mut *conn)
        .await?;
        if !used {
            return Ok(candidate);
        }
    }
    Ok(format!("{base} ({})", Uuid::new_v4().simple()))
}

/// Where an import puts its contacts: an existing list, or one `list_name` would create (`id` None).
pub struct Target {
    pub id: Option<Uuid>,
    pub name: String,
}

/// Reads the import target without creating anything. `list_id` is an existing list (id or name);
/// `list_name` is found by name or is new. Both given is an error; neither is `None`.
pub async fn target(
    st: &AppState,
    ws: Uuid,
    list_id: Option<&str>,
    list_name: Option<&str>,
) -> ApiResult<Option<Target>> {
    match (
        list_id.map(str::trim).filter(|s| !s.is_empty()),
        list_name.map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (Some(_), Some(_)) => {
            Err(invalid("pass list_id or list_name, not both").field("list_name"))
        }
        (Some(l), None) => {
            let (id, name): (Uuid, String) = sqlx::query_as(
                "SELECT id, name FROM segments WHERE workspace_id = $1 AND filter IS NULL AND (id::text = $2 OR name = $2)",
            )
            .bind(ws)
            .bind(l)
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| not_found("list").field("list_id"))?;
            Ok(Some(Target { id: Some(id), name }))
        }
        (None, Some(n)) => {
            let n = name_of(n).map_err(|e| e.field("list_name"))?;
            let found: Option<(Uuid, bool)> = sqlx::query_as(
                "SELECT id, filter IS NULL FROM segments WHERE workspace_id = $1 AND name = $2",
            )
            .bind(ws)
            .bind(&n)
            .fetch_optional(&st.db)
            .await?;
            match found {
                Some((_, false)) => Err(err(
                    "invalid_state",
                    409,
                    format!("`{n}` is a rule-based segment, not a list"),
                )
                .field("list_name")),
                Some((id, true)) => Ok(Some(Target {
                    id: Some(id),
                    name: n,
                })),
                None => Ok(Some(Target { id: None, name: n })),
            }
        }
        (None, None) => Ok(None),
    }
}

/// Like [`target`], but a new `list_name` is created (origin `import`).
pub async fn for_import(
    st: &AppState,
    ws: Uuid,
    list_id: Option<&str>,
    list_name: Option<&str>,
) -> ApiResult<Option<Uuid>> {
    let Some(t) = target(st, ws, list_id, list_name).await? else {
        return Ok(None);
    };
    if t.id.is_some() {
        return Ok(t.id);
    }
    Ok(Some(
        sqlx::query_scalar(
            "INSERT INTO segments (workspace_id, name, origin) VALUES ($1, $2, 'import') \
             ON CONFLICT (workspace_id, name) DO UPDATE SET name = excluded.name RETURNING id",
        )
        .bind(ws)
        .bind(&t.name)
        .fetch_one(&st.db)
        .await?,
    ))
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateList {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

pub async fn create(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<CreateList>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let name = name_of(&b.name)?;
    let desc = description_of(b.description.as_deref().unwrap_or(""))?;
    let mut g = begin!(st, auth, headers, "POST /v1/lists", b);
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO segments (workspace_id, name, description, origin) VALUES ($1, $2, $3, 'manual') RETURNING id",
    )
    .bind(ws)
    .bind(&name)
    .bind(&desc)
    .fetch_one(&mut *g.tx)
    .await
    .map_err(|e| taken(e, &name))?;
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "list.create",
            args: json!({"list_id": id, "name": name}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    let v: ListView = sqlx::query_as(&format!("SELECT {COLS} FROM segments s WHERE s.id = $1"))
        .bind(id)
        .fetch_one(&mut *g.tx)
        .await?;
    g.finish(StatusCode::CREATED, v).await
}

pub async fn list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Manage)?;
    let rows: Vec<ListView> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM segments s WHERE s.workspace_id = $1 AND s.filter IS NULL ORDER BY s.name"
    ))
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    Ok(envelope_list(rows, None))
}

pub async fn get(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    Ok(envelope(
        StatusCode::OK,
        load(&st, auth.0.workspace_id, id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchList {
    #[serde(default)]
    pub name: Option<String>,
    /// `""` clears it.
    #[serde(default)]
    pub description: Option<String>,
}

pub async fn patch(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<PatchList>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let cur = load(&st, ws, id).await?;
    let name = b.name.as_deref().map(name_of).transpose()?;
    let desc = b.description.as_deref().map(description_of).transpose()?;
    if let Some(n) = name.as_deref().filter(|n| *n != cur.name) {
        // Automations may name the list; a rename would make every later poll of them fail.
        let users = segment_users(&st.db, ws, &[&cur.name])
            .await
            .map_err(ApiError::from)?;
        if !users.is_empty() {
            return Err(err(
                "invalid_state",
                409,
                format!(
                    "automation(s) refer to this list by name: {}",
                    users.join(", ")
                ),
            )
            .field("name")
            .hint_in("point those automations at the list's id, or change them first"));
        }
        sqlx::query("UPDATE segments SET name = $2 WHERE id = $1")
            .bind(id)
            .bind(n)
            .execute(&st.db)
            .await
            .map_err(|e| taken(e, n))?;
    }
    if let Some(d) = &desc {
        sqlx::query("UPDATE segments SET description = $2 WHERE id = $1")
            .bind(id)
            .bind(d)
            .execute(&st.db)
            .await?;
    }
    record(
        &st,
        &auth,
        "list.update",
        json!({"list_id": id, "name": name, "description_changed": desc.is_some()}),
    )
    .await?;
    Ok(envelope(StatusCode::OK, load(&st, ws, id).await?))
}

pub async fn delete(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    let cur = load(&st, ws, id).await?;
    if cur.source_id.is_some() {
        return Err(
            err("invalid_state", 409, "this list is fed by a contact source")
                .hint_in("delete the contact source (optionally with its list) instead"),
        );
    }
    // Membership rows go with the list; contacts, events and suppressions are untouched.
    st.segments.delete(ws, id).await?;
    record(
        &st,
        &auth,
        "list.delete",
        json!({"list_id": id, "name": cur.name, "members": cur.member_count}),
    )
    .await?;
    Ok(envelope(StatusCode::OK, json!({"id": id, "deleted": true})))
}

#[derive(Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Members {
    #[serde(default)]
    pub contact_ids: Vec<Uuid>,
    /// When adding, an address that is not a contact yet becomes one.
    #[serde(default)]
    pub emails: Vec<String>,
}

fn checked(b: &Members) -> ApiResult<Vec<Uuid>> {
    let n = b.contact_ids.len() + b.emails.len();
    if n == 0 || n > MEMBERS_MAX {
        return Err(invalid(format!(
            "contact_ids and emails need 1-{MEMBERS_MAX} entries in total"
        ))
        .field("contact_ids"));
    }
    let mut seen = HashSet::new();
    Ok(b.contact_ids
        .iter()
        .copied()
        .filter(|i| seen.insert(*i))
        .collect())
}

/// Add contacts by id and/or email. Idempotent.
pub async fn members_add(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<Members>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    load(&st, ws, id).await?;
    let ids = checked(&b)?;
    let (mut added, mut already, mut missing) = (0_i64, 0_i64, 0_i64);
    if !ids.is_empty() {
        let found: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM contacts WHERE workspace_id = $1 AND id = ANY($2)")
                .bind(ws)
                .bind(&ids)
                .fetch_all(&st.db)
                .await?;
        let n = sqlx::query(
            "INSERT INTO segment_members (segment_id, contact_id, added_at) SELECT $1, c, now() FROM unnest($2::uuid[]) c ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(&found)
        .execute(&st.db)
        .await?
        .rows_affected() as i64;
        added += n;
        already += found.len() as i64 - n;
        missing = (ids.len() - found.len()) as i64;
    }
    if !b.emails.is_empty() {
        let v = st.segments.add_members(ws, id, b.emails.clone()).await?;
        added += v["added"].as_i64().unwrap_or(0);
        already += v["already_members"].as_i64().unwrap_or(0);
    }
    record(
        &st,
        &auth,
        "list.members_add",
        json!({"list_id": id, "added": added}),
    )
    .await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"list_id": id, "added": added, "already_members": already, "not_found": missing}),
    ))
}

/// Remove contacts from the list by id and/or email. The contacts themselves stay.
pub async fn members_remove(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<Members>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let ws = auth.0.workspace_id;
    load(&st, ws, id).await?;
    let ids = checked(&b)?;
    let emails: Vec<String> = b.emails.iter().map(|e| e.trim().to_lowercase()).collect();
    let removed = sqlx::query(
        "DELETE FROM segment_members m USING contacts c WHERE m.segment_id = $1 AND c.id = m.contact_id \
         AND c.workspace_id = $2 AND (c.id = ANY($3) OR lower(c.email) = ANY($4))",
    )
    .bind(id)
    .bind(ws)
    .bind(&ids)
    .bind(&emails)
    .execute(&st.db)
    .await?
    .rows_affected();
    record(
        &st,
        &auth,
        "list.members_remove",
        json!({"list_id": id, "removed": removed}),
    )
    .await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"list_id": id, "removed": removed}),
    ))
}
