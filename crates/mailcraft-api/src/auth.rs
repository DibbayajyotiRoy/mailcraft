//! Bearer-key authentication, scopes and per-key API rate limiting (SPEC 4.5, 14).
use axum::{extract::FromRequestParts, http::request::Parts};
use mailcraft_core::{
    auth::{hash_token, token_env, KeyEnv, Scope},
    crypto::ct_eq,
    Error,
};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    error::{err, forbidden_scope, ApiError},
    state::AppState,
};

#[derive(Debug, Clone)]
pub struct ApiKey {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub env: KeyEnv,
    pub scopes: Vec<Scope>,
    pub domain_id: Option<Uuid>,
    pub policy: Value,
    pub allowlist: Option<Vec<String>>,
    pub daily_cap: Option<i32>,
    pub minute_cap: Option<i32>,
    pub paused: bool,
}

#[derive(sqlx::FromRow)]
struct KeyRow {
    id: Uuid,
    workspace_id: Uuid,
    name: String,
    token_hash: Vec<u8>,
    env: String,
    scopes: Vec<String>,
    domain_id: Option<Uuid>,
    policy: Value,
    recipient_allowlist: Option<Vec<String>>,
    daily_send_cap: Option<i32>,
    minute_send_cap: Option<i32>,
    paused: bool,
}

pub struct Auth(pub ApiKey);

impl Auth {
    pub fn require(&self, scope: Scope) -> Result<(), ApiError> {
        if self.0.scopes.contains(&scope) {
            Ok(())
        } else {
            Err(forbidden_scope(scope.as_str()))
        }
    }
}

fn unauthenticated() -> ApiError {
    ApiError(
        Error::new(
            "unauthenticated",
            401,
            "missing, invalid, revoked or expired API key",
        )
        .hint("send `Authorization: Bearer mc_test_...` or `mc_live_...`"),
    )
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, ApiError> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .ok_or_else(unauthenticated)?;
        token_env(token).ok_or_else(unauthenticated)?;
        let hash = hash_token(token);
        let row: KeyRow = sqlx::query_as(
            "SELECT id, workspace_id, name, token_hash, env, scopes, domain_id, policy, \
                    recipient_allowlist, daily_send_cap, minute_send_cap, paused \
             FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL \
               AND (expires_at IS NULL OR expires_at > now())",
        )
        .bind(&hash[..])
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(unauthenticated)?;
        if !ct_eq(&row.token_hash, &hash) {
            return Err(unauthenticated());
        }
        let key = ApiKey {
            id: row.id,
            workspace_id: row.workspace_id,
            name: row.name,
            env: KeyEnv::parse(&row.env).unwrap_or(KeyEnv::Test),
            scopes: row.scopes.iter().filter_map(|s| Scope::parse(s)).collect(),
            domain_id: row.domain_id,
            policy: row.policy,
            allowlist: row.recipient_allowlist,
            daily_cap: row.daily_send_cap,
            minute_cap: row.minute_send_cap,
            paused: row.paused,
        };
        crate::caps::rate_limit(st, &key).await?;
        // Throttled to one write a minute per key.
        let _ = sqlx::query(
            "UPDATE api_keys SET last_used_at = now() WHERE id = $1 \
             AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')",
        )
        .bind(key.id)
        .execute(&st.db)
        .await;
        Ok(Auth(key))
    }
}

pub fn too_many(code: &'static str, msg: String, hint: &str) -> ApiError {
    ApiError(Error::new(code, 429, msg).hint(hint).retryable())
}

pub fn deny(code: &'static str, status: u16, msg: impl Into<String>) -> ApiError {
    err(code, status, msg)
}
