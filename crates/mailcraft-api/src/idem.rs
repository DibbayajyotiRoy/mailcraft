//! `Idempotency-Key` handling (SPEC 4.2): same key + same request within 24 h replays the
//! stored response; same key + different request is `409 idempotency_key_reused`.
//!
//! The key row is claimed inside the same transaction as the work, so two concurrent
//! requests with one key serialise on the unique index and the loser replays.
use axum::{
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use mailcraft_core::{audit::canonical_json, crypto::sha256, Error};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};

use crate::{
    auth::ApiKey,
    error::{envelope, request_id, ApiError, ApiResult},
    state::AppState,
};

pub struct Guard {
    pub tx: Transaction<'static, Postgres>,
    key: Option<String>,
    workspace: uuid::Uuid,
    claim: uuid::Uuid,
}

pub enum Begin {
    Replay(Response),
    Fresh(Guard),
}

pub fn header_key(h: &HeaderMap) -> Result<Option<String>, ApiError> {
    match h.get("idempotency-key") {
        None => Ok(None),
        Some(v) => {
            let s = v
                .to_str()
                .map_err(|_| crate::error::invalid("Idempotency-Key must be ASCII"))?;
            if s.is_empty() || s.len() > 256 {
                return Err(
                    crate::error::invalid("Idempotency-Key must be 1-256 characters")
                        .field("Idempotency-Key"),
                );
            }
            Ok(Some(s.to_string()))
        }
    }
}

impl Guard {
    /// Starts a transaction and, when the header is present, claims or replays the key.
    pub async fn begin(
        st: &AppState,
        key: &ApiKey,
        headers: &HeaderMap,
        route: &str,
        body: &impl Serialize,
    ) -> ApiResult<Begin> {
        let idem = header_key(headers)?;
        let mut tx = st.db.begin().await?;
        let Some(k) = &idem else {
            return Ok(Begin::Fresh(Guard {
                tx,
                key: None,
                workspace: key.workspace_id,
                claim: uuid::Uuid::now_v7(),
            }));
        };
        let value = serde_json::to_value(body).unwrap_or(Value::Null);
        let hash = sha256(format!("{route}\n{}", canonical_json(&value)).as_bytes());
        // Expired claims are purged lazily, per key.
        sqlx::query(
            "DELETE FROM idempotency_keys WHERE workspace_id = $1 AND key = $2 \
             AND created_at < now() - interval '24 hours'",
        )
        .bind(key.workspace_id)
        .bind(k)
        .execute(&mut *tx)
        .await?;
        let claimed = sqlx::query(
            "INSERT INTO idempotency_keys (workspace_id, key, request_hash, response, status_code) \
             VALUES ($1,$2,$3,'{}',0) ON CONFLICT DO NOTHING",
        )
        .bind(key.workspace_id)
        .bind(k)
        .bind(&hash[..])
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if claimed == 1 {
            return Ok(Begin::Fresh(Guard {
                tx,
                key: idem,
                workspace: key.workspace_id,
                claim: uuid::Uuid::now_v7(),
            }));
        }
        let (h, resp, code): (Vec<u8>, Value, i32) = sqlx::query_as(
            "SELECT request_hash, response, status_code FROM idempotency_keys \
             WHERE workspace_id = $1 AND key = $2",
        )
        .bind(key.workspace_id)
        .bind(k)
        .fetch_one(&mut *tx)
        .await?;
        if h != hash {
            return Err(ApiError(
                Error::new(
                    "idempotency_key_reused",
                    409,
                    "this Idempotency-Key was already used with a different request",
                )
                .hint("use a fresh key for a different request, or resend the identical request to replay"),
            ));
        }
        let status = StatusCode::from_u16(code as u16).unwrap_or(StatusCode::OK);
        let mut r = (status, Json(resp)).into_response();
        r.headers_mut()
            .insert("idempotent-replay", HeaderValue::from_static("true"));
        Ok(Begin::Replay(r))
    }

    /// Per-row key for `emails.idempotency_key` (unique per workspace, so it carries this claim's
    /// id: a key reused after the 24 h window must not collide with the old rows).
    pub fn row_key(&self, item: usize, rcpt: usize) -> Option<String> {
        self.key
            .as_ref()
            .map(|k| format!("{k}#{}.{item}.{rcpt}", self.claim.simple()))
    }

    /// Stores the response under the key (if any) and commits.
    pub async fn finish(mut self, status: StatusCode, data: impl Serialize) -> ApiResult<Response> {
        if let Some(k) = &self.key {
            let stored = json!({ "ok": true, "data": data, "request_id": request_id() });
            sqlx::query(
                "UPDATE idempotency_keys SET response = $3, status_code = $4 \
                 WHERE workspace_id = $1 AND key = $2",
            )
            .bind(self.workspace)
            .bind(k)
            .bind(&stored)
            .bind(status.as_u16() as i32)
            .execute(&mut *self.tx)
            .await?;
        }
        self.tx.commit().await?;
        Ok(envelope(status, data))
    }
}

/// Maintenance: purge expired rows.
pub async fn purge(db: &sqlx::PgPool) -> Result<u64, sqlx::Error> {
    Ok(
        sqlx::query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'")
            .execute(db)
            .await?
            .rows_affected(),
    )
}
