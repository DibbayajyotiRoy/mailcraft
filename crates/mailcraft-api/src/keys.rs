//! `/v1/keys`: API key CRUD. Admin scope only; keys minted over the API can never hold `admin`
//! (SPEC 4.5: agent keys cannot raise their own limits). Admin keys come from `bootstrap`.
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use mailcraft_core::{
    address,
    auth::{generate_token, KeyEnv, Scope},
    policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{envelope, envelope_list, err, invalid, not_found, ApiJson, ApiResult},
    idem::{Begin, Guard},
    state::AppState,
};

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateKey {
    pub name: String,
    pub env: KeyEnv,
    pub scopes: Vec<Scope>,
    #[serde(default)]
    pub domain_id: Option<Uuid>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub recipient_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub daily_send_cap: Option<i32>,
    #[serde(default)]
    pub minute_send_cap: Option<i32>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
}

fn validate(k: &CreateKey, allow_admin: bool) -> ApiResult<()> {
    if k.name.trim().is_empty() || k.name.len() > 100 {
        return Err(invalid("name must be 1-100 characters").field("name"));
    }
    if k.scopes.is_empty() {
        return Err(invalid("at least one scope is required").field("scopes"));
    }
    if !allow_admin && k.scopes.contains(&Scope::Admin) {
        return Err(err(
            "forbidden_scope",
            403,
            "keys created over the API cannot hold the `admin` scope",
        )
        .field("scopes")
        .hint_in("admin keys are minted by an operator with `mailcraft-server bootstrap`"));
    }
    if let Some(p) = &k.policy {
        policy::validate(p).map_err(|m| invalid(m).field("policy"))?;
    }
    for c in [k.daily_send_cap, k.minute_send_cap].into_iter().flatten() {
        if c < 1 {
            return Err(invalid("send caps must be >= 1").field("daily_send_cap"));
        }
    }
    for a in k.recipient_allowlist.iter().flatten() {
        let ok = match a.strip_prefix('@') {
            Some(d) => address::parse_mailbox(&format!("x@{d}")).is_some(),
            None => address::parse_mailbox(a).is_some(),
        };
        if !ok {
            return Err(
                invalid(format!("`{a}` is not an address or @domain")).field("recipient_allowlist")
            );
        }
    }
    Ok(())
}

/// Inserts a key and returns `(id, plaintext token)`. The token is never stored.
pub async fn insert_key(
    conn: &mut PgConnection,
    workspace: Uuid,
    k: &CreateKey,
) -> Result<(Uuid, String), sqlx::Error> {
    let t = generate_token(k.env);
    let scopes: Vec<&str> = k.scopes.iter().map(|s| s.as_str()).collect();
    let allow = k
        .recipient_allowlist
        .as_ref()
        .map(|v| v.iter().map(|s| s.to_ascii_lowercase()).collect::<Vec<_>>());
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash, env, scopes, domain_id, policy, \
         recipient_allowlist, daily_send_cap, minute_send_cap, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&k.name)
    .bind(&t.prefix)
    .bind(&t.hash[..])
    .bind(k.env.as_str())
    .bind(&scopes)
    .bind(k.domain_id)
    .bind(k.policy.clone().unwrap_or_else(|| json!({})))
    .bind(allow)
    .bind(k.daily_send_cap)
    .bind(k.minute_send_cap)
    .bind(k.expires_at)
    .execute(conn)
    .await?;
    Ok((id, t.token))
}

pub async fn create(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(body): ApiJson<CreateKey>,
) -> ApiResult {
    auth.require(Scope::Admin)?;
    validate(&body, false)?;
    if let Some(d) = body.domain_id {
        let ok: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM domains WHERE id = $1 AND workspace_id = $2")
                .bind(d)
                .bind(auth.0.workspace_id)
                .fetch_optional(&st.db)
                .await?;
        if ok.is_none() {
            return Err(invalid("domain_id does not exist").field("domain_id"));
        }
    }
    // The replayed response carries the secret; idempotent retries are meant to recover it.
    let mut g = match Guard::begin(&st, &auth.0, &headers, "POST /v1/keys", &body).await? {
        Begin::Replay(r) => return Ok(r),
        Begin::Fresh(g) => g,
    };
    let (id, token) = insert_key(&mut g.tx, auth.0.workspace_id, &body).await?;
    audit::append(
        &mut g.tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "key.create",
            args: json!({"key_id": id, "name": body.name, "env": body.env, "scopes": body.scopes, "policy": body.policy}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    g.finish(StatusCode::CREATED, json!({"id": id, "name": body.name, "env": body.env, "scopes": body.scopes, "token": token, "prefix": &token[..12]}))
        .await
}

#[derive(sqlx::FromRow, Serialize)]
struct KeyView {
    id: Uuid,
    name: String,
    prefix: String,
    env: String,
    scopes: Vec<String>,
    domain_id: Option<Uuid>,
    policy: Value,
    recipient_allowlist: Option<Vec<String>>,
    daily_send_cap: Option<i32>,
    minute_send_cap: Option<i32>,
    paused: bool,
    expires_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

const COLS: &str = "id, name, prefix, env, scopes, domain_id, policy, recipient_allowlist, daily_send_cap, minute_send_cap, paused, expires_at, revoked_at, last_used_at, created_at";

pub async fn list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Admin)?;
    let rows: Vec<KeyView> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC, id"
    ))
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    Ok(envelope_list(rows, None))
}

pub async fn get(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Admin)?;
    let row: KeyView = sqlx::query_as(&format!(
        "SELECT {COLS} FROM api_keys WHERE id = $1 AND workspace_id = $2"
    ))
    .bind(id)
    .bind(auth.0.workspace_id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("key"))?;
    Ok(envelope(StatusCode::OK, row))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchKey {
    pub policy: Option<Value>,
    pub recipient_allowlist: Option<Vec<String>>,
    pub daily_send_cap: Option<i32>,
    pub minute_send_cap: Option<i32>,
}

pub async fn patch(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<PatchKey>,
) -> ApiResult {
    auth.require(Scope::Admin)?;
    if let Some(p) = &b.policy {
        policy::validate(p).map_err(|m| invalid(m).field("policy"))?;
    }
    for c in [b.daily_send_cap, b.minute_send_cap].into_iter().flatten() {
        if c < 1 {
            return Err(invalid("send caps must be >= 1"));
        }
    }
    let allow = b
        .recipient_allowlist
        .as_ref()
        .map(|v| v.iter().map(|s| s.to_ascii_lowercase()).collect::<Vec<_>>());
    let mut tx = st.db.begin().await?;
    let n = sqlx::query(
        "UPDATE api_keys SET policy = COALESCE($3, policy), recipient_allowlist = COALESCE($4, recipient_allowlist), \
         daily_send_cap = COALESCE($5, daily_send_cap), minute_send_cap = COALESCE($6, minute_send_cap) \
         WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(auth.0.workspace_id)
    .bind(&b.policy)
    .bind(allow)
    .bind(b.daily_send_cap)
    .bind(b.minute_send_cap)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(not_found("key"));
    }
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "key.update",
            args: json!({"key_id": id, "policy": b.policy, "daily_send_cap": b.daily_send_cap, "minute_send_cap": b.minute_send_cap, "recipient_allowlist": b.recipient_allowlist}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    get(State(st), auth, Path(id)).await
}

pub async fn revoke(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Admin)?;
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL")
        .bind(id)
        .bind(auth.0.workspace_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(not_found("key"));
    }
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "key.revoke",
            args: json!({"key_id": id}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(StatusCode::OK, json!({"id": id, "revoked": true})))
}
