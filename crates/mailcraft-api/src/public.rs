//! Unauthenticated routes: the signed one-click unsubscribe endpoint (RFC 8058, SPEC 12 #7).
use std::sync::Mutex;

use axum::{
    extract::{Path, State},
    http::{header, Method as HttpMethod, StatusCode},
    response::{IntoResponse, Response},
};
use mailcraft_deliverability::unsubscribe::{self, Category, Method, PreferenceStore};
use uuid::Uuid;

use crate::state::AppState;

/// `PreferenceStore` is sync; collect the unsubscribes and write them after `handle` returns.
#[derive(Default)]
struct Collect(Mutex<Vec<(String, String, Category)>>);

impl PreferenceStore for Collect {
    fn unsubscribe(&self, tenant: &str, contact: &str, category: Category, _now: u64) {
        self.0
            .lock()
            .unwrap()
            .push((tenant.into(), contact.into(), category));
    }
}

/// `GET /u/{token}` shows a confirm form (never unsubscribes); `POST` does, with no redirect.
/// Token tenant = workspace id, contact = contact id (hyphenated or simple uuid), category = topic key.
pub async fn unsubscribe(
    State(st): State<AppState>,
    method: HttpMethod,
    Path(token): Path<String>,
    body: String,
) -> Response {
    if st.config.unsub_secret.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "unsubscribe is not configured",
        )
            .into_response();
    }
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let seen = Collect::default();
    let m = if method == HttpMethod::POST {
        Method::Post
    } else {
        Method::Get
    };
    let r = unsubscribe::handle(m, &token, &body, &st.config.unsub_secret, now, &seen);
    let mut status = StatusCode::from_u16(r.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (tenant, contact, cat) in seen.0.into_inner().unwrap() {
        if let Err(e) = apply(&st, &tenant, &contact, cat).await {
            tracing::error!(error = %e, "unsubscribe write failed");
            status = StatusCode::INTERNAL_SERVER_ERROR;
        }
    }
    if status.is_server_error() {
        return (status, "could not record the unsubscribe, please retry").into_response();
    }
    (status, [(header::CONTENT_TYPE, r.content_type)], r.body).into_response()
}

async fn apply(
    st: &AppState,
    tenant: &str,
    contact: &str,
    cat: Category,
) -> Result<(), sqlx::Error> {
    let (Ok(ws), Ok(c)) = (Uuid::parse_str(tenant), Uuid::parse_str(contact)) else {
        return Ok(()); // validly signed but not ours: nothing to record
    };
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "INSERT INTO topics (workspace_id, key, name) VALUES ($1, $2, $2) ON CONFLICT (workspace_id, key) DO NOTHING",
    )
    .bind(ws)
    .bind(cat.as_str())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO contact_topics (contact_id, topic_id, opted_in) \
         SELECT c.id, t.id, false FROM contacts c, topics t WHERE c.id = $2 AND c.workspace_id = $1 AND t.workspace_id = $1 AND t.key = $3 \
         ON CONFLICT (contact_id, topic_id) DO UPDATE SET opted_in = false, updated_at = now()",
    )
    .bind(ws)
    .bind(c)
    .bind(cat.as_str())
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}
