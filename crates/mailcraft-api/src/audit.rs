//! Hash-chained, append-only audit log (SPEC 14). Chain maths lives in `mailcraft_core::audit`.
use chrono::{DateTime, TimeZone, Utc};
use mailcraft_core::audit::{redact, row_hash, AuditRow};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::{auth::ApiKey, error::ApiError};

pub enum Actor<'a> {
    Key(&'a ApiKey),
    System,
}

pub struct Entry<'a> {
    pub action: &'a str,
    pub args: Value,
    pub decision: &'a str,
    pub approval_id: Option<Uuid>,
}

/// Appends one row inside the caller's transaction. A per-workspace advisory lock serialises
/// writers so `prev_hash` always points at the true predecessor.
pub async fn append(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Actor<'_>,
    e: Entry<'_>,
) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('audit:' || $1::text, 0))")
        .bind(workspace)
        .execute(&mut *conn)
        .await?;
    let prev: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT row_hash FROM audit_log WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(workspace)
    .fetch_optional(&mut *conn)
    .await?;
    let (actor_type, actor_id) = match actor {
        Actor::Key(k) => ("api_key", Some(k.id)),
        Actor::System => ("system", None),
    };
    let at = Utc::now();
    let row = AuditRow {
        workspace_id: workspace,
        at_micros: at.timestamp_micros(),
        actor_type: actor_type.into(),
        actor_id,
        action: e.action.into(),
        args: redact(&e.args),
        decision: e.decision.into(),
        approval_id: e.approval_id,
    };
    let hash = row_hash(prev.as_deref(), &row);
    sqlx::query(
        "INSERT INTO audit_log (workspace_id, at, actor_type, actor_id, action, args, decision, approval_id, prev_hash, row_hash) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(workspace)
    .bind(at)
    .bind(actor_type)
    .bind(actor_id)
    .bind(e.action)
    .bind(&row.args)
    .bind(e.decision)
    .bind(e.approval_id)
    .bind(prev)
    .bind(&hash[..])
    .execute(conn)
    .await?;
    Ok(())
}

/// Append in its own transaction (for decisions on requests that are rejected, so the
/// attempt is still recorded).
pub async fn append_standalone(
    db: &PgPool,
    workspace: Uuid,
    actor: Actor<'_>,
    e: Entry<'_>,
) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    append(&mut tx, workspace, actor, e).await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct VerifyReport {
    pub ok: bool,
    pub checked: u64,
    pub first_bad_id: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    at: DateTime<Utc>,
    actor_type: String,
    actor_id: Option<Uuid>,
    action: String,
    args: Value,
    decision: String,
    approval_id: Option<Uuid>,
    prev_hash: Option<Vec<u8>>,
    row_hash: Vec<u8>,
}

/// Recomputes the whole chain for a workspace; reports the first row that does not match.
pub async fn verify(db: &PgPool, workspace: Uuid) -> Result<VerifyReport, ApiError> {
    use futures_lite::StreamExt;
    let mut rows = sqlx::query_as::<_, Row>(
        "SELECT id, at, actor_type, actor_id, action, args, decision, approval_id, prev_hash, row_hash \
         FROM audit_log WHERE workspace_id = $1 ORDER BY id",
    )
    .bind(workspace)
    .fetch(db);
    let mut prev: Option<Vec<u8>> = None;
    let mut checked = 0;
    while let Some(r) = rows.next().await {
        let r = r?;
        let expect = row_hash(
            prev.as_deref(),
            &AuditRow {
                workspace_id: workspace,
                at_micros: Utc.from_utc_datetime(&r.at.naive_utc()).timestamp_micros(),
                actor_type: r.actor_type,
                actor_id: r.actor_id,
                action: r.action,
                args: r.args,
                decision: r.decision,
                approval_id: r.approval_id,
            },
        );
        if r.prev_hash != prev || r.row_hash != expect {
            return Ok(VerifyReport {
                ok: false,
                checked,
                first_bad_id: Some(r.id),
            });
        }
        prev = Some(r.row_hash);
        checked += 1;
    }
    Ok(VerifyReport {
        ok: true,
        checked,
        first_bad_id: None,
    })
}
