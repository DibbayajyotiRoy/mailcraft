//! axum HTTP API. `openapi.yaml` (repo root) is the single source of truth; every route here
//! must be in it (checked by `tests/api.rs::every_openapi_route_is_mounted`).
pub mod audit;
pub mod auth;
pub mod caps;
pub mod emails;
pub mod error;
pub mod idem;
pub mod integrations;
pub mod keys;
pub mod metrics;
pub mod ops;
pub mod ssrf;
pub mod state;
pub mod webhooks;

use std::time::{Duration, Instant};

use axum::{
    extract::{DefaultBodyLimit, MatchedPath, Request, State},
    http::{header, HeaderValue},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Router,
};
use mailcraft_core::{
    auth::{KeyEnv, Scope},
    Error,
};
use sqlx::PgPool;
use uuid::Uuid;

pub use error::{ApiError, ApiResult};
pub use state::{AppState, Config};

const OPENAPI: &str = include_str!("../../../openapi.yaml");

async fn openapi_yaml() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/yaml")], OPENAPI)
}

async fn fallback() -> ApiError {
    ApiError(Error::new("not_found", 404, "no such route").hint("see GET /openapi.yaml"))
}

/// Request id, access metrics, security headers.
async fn request_layer(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let id = format!("req_{}", Uuid::now_v7().simple());
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_string(), |m| m.as_str().to_string());
    let start = Instant::now();
    let mut res = error::REQUEST_ID.scope(id.clone(), next.run(req)).await;
    st.metrics
        .http_requests
        .with_label_values(&[&route, res.status().as_str()])
        .inc();
    st.metrics
        .http_duration
        .with_label_values(&[&route])
        .observe(start.elapsed().as_secs_f64());
    let h = res.headers_mut();
    h.insert("x-request-id", HeaderValue::from_str(&id).unwrap());
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub fn router(st: AppState) -> Router {
    Router::new()
        .route("/healthz", get(ops::healthz))
        .route("/readyz", get(ops::readyz))
        .route("/metrics", get(ops::metrics))
        .route("/openapi.yaml", get(openapi_yaml))
        // emails
        .route("/v1/emails", post(emails::send).get(emails::list))
        .route("/v1/emails/batch", post(emails::batch))
        .route("/v1/emails/{id}", get(emails::get))
        .route("/v1/emails/{id}/cancel", post(emails::cancel))
        .route("/v1/emails/{id}/events", get(emails::events))
        // keys
        .route("/v1/keys", post(keys::create).get(keys::list))
        .route(
            "/v1/keys/{id}",
            get(keys::get).patch(keys::patch).delete(keys::revoke),
        )
        // domains (WP3 service)
        .route(
            "/v1/domains",
            post(integrations::domains_add).get(integrations::domains_list),
        )
        .route(
            "/v1/domains/{id}",
            get(integrations::domains_get).delete(integrations::domains_delete),
        )
        .route(
            "/v1/domains/{id}/verify",
            post(integrations::domains_verify),
        )
        .route(
            "/v1/domains/{id}/rotate-dkim",
            post(integrations::domains_rotate),
        )
        // contacts / segments / events (WP4 services)
        .route(
            "/v1/contacts",
            put(integrations::contacts_upsert).get(integrations::contacts_list),
        )
        .route(
            "/v1/contacts/{id}",
            get(integrations::contacts_get).delete(integrations::contacts_delete),
        )
        .route(
            "/v1/contacts/{id}/suppress",
            post(integrations::contacts_suppress),
        )
        .route(
            "/v1/segments",
            post(integrations::segments_create).get(integrations::segments_list),
        )
        .route(
            "/v1/segments/{id}/members",
            post(integrations::segments_members),
        )
        .route("/v1/events", post(integrations::events_track))
        // approvals, go-live, policy, kill switch, audit
        .route("/v1/approvals", get(ops::approvals_list))
        .route("/v1/approvals/{id}", get(ops::approvals_get))
        .route("/v1/approvals/{id}/decide", post(ops::approvals_decide))
        .route("/v1/go-live-requests", post(ops::go_live))
        .route("/v1/policy/proposals", post(ops::policy_proposal))
        .route(
            "/v1/kill-switch",
            get(ops::kill_switch_get).post(ops::kill_switch_set),
        )
        .route("/v1/audit", get(ops::audit_list))
        .route("/v1/audit/verify", get(ops::audit_verify))
        .route("/v1/account/status", get(ops::account_status))
        // webhooks
        .route("/v1/webhooks", post(webhooks::create).get(webhooks::list))
        .route("/v1/webhooks/{id}", delete(webhooks::delete))
        .route("/v1/webhooks/{id}/test", post(webhooks::test))
        .route("/v1/webhooks/{id}/deliveries", get(webhooks::deliveries))
        .route("/v1/webhook-deliveries/{id}/replay", post(webhooks::replay))
        .fallback(fallback)
        .layer(DefaultBodyLimit::max(5 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(st.clone(), request_layer))
        .with_state(st)
}

/// Creates the first workspace (if none) and an admin key with all scopes. Returns the
/// plaintext token, which is never stored. Used by `mailcraft-server bootstrap` and by `init`.
pub async fn bootstrap(db: &PgPool, name: &str) -> Result<(Uuid, String), sqlx::Error> {
    let mut tx = db.begin().await?;
    let ws: Uuid = match sqlx::query_scalar("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")
        .fetch_optional(&mut *tx)
        .await?
    {
        Some(id) => id,
        None => {
            sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ($1) RETURNING id")
                .bind(name)
                .fetch_one(&mut *tx)
                .await?
        }
    };
    let spec = keys::CreateKey {
        name: "bootstrap-admin".into(),
        env: KeyEnv::Live,
        scopes: vec![Scope::Read, Scope::Send, Scope::Manage, Scope::Admin],
        domain_id: None,
        policy: None,
        recipient_allowlist: None,
        daily_send_cap: None,
        minute_send_cap: None,
        expires_at: None,
    };
    let (_, token) = keys::insert_key(&mut tx, ws, &spec).await?;
    audit::append(
        &mut tx,
        ws,
        audit::Actor::System,
        audit::Entry {
            action: "bootstrap",
            args: serde_json::json!({"name": name}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await
    .map_err(|e| sqlx::Error::Protocol(e.0.message))?;
    tx.commit().await?;
    Ok((ws, token))
}

/// Background loops owned by the API process: webhook delivery and idempotency purge.
/// (Email sending, bounce handling and fan-out of `email_events` belong to the engine.)
pub async fn run_background(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut n: u64 = 0;
    loop {
        tick.tick().await;
        if let Err(e) = webhooks::deliver_due(&st, 50).await {
            tracing::error!(error = %e, "webhook delivery loop");
        }
        n += 1;
        if n.is_multiple_of(1800) {
            let _ = idem::purge(&st.db).await;
        }
    }
}
