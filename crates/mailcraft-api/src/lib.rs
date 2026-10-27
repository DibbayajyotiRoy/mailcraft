//! axum HTTP API. `openapi.yaml` (repo root) is the single source of truth; every route here
//! must be in it (checked by `tests/api.rs::every_openapi_route_is_mounted`).
/// Claims the `Idempotency-Key` (or replays the stored response) and opens the work transaction.
macro_rules! begin {
    ($st:expr, $auth:expr, $headers:expr, $route:expr, $body:expr) => {
        match $crate::idem::Guard::begin(&$st, &$auth.0, &$headers, $route, &$body).await? {
            $crate::idem::Begin::Replay(r) => return Ok(r),
            $crate::idem::Begin::Fresh(g) => g,
        }
    };
}

pub mod admin;
pub mod audit;
pub mod auth;
pub mod automations;
pub mod caps;
pub mod emails;
pub mod error;
pub mod idem;
pub mod integrations;
pub mod keys;
pub mod metrics;
pub mod ops;
pub mod page;
pub mod public;
pub mod resolver;
pub mod services;
pub mod ssrf;
pub mod state;
pub mod templates;
pub mod transports;
pub mod webhooks;
pub mod wiring;

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
        // public (signed token / first-run)
        .route(
            "/u/{token}",
            get(public::unsubscribe).post(public::unsubscribe),
        )
        .route("/v1/setup", post(admin::setup))
        // ops
        .route("/v1/doctor", get(admin::doctor))
        .route("/v1/stats/overview", get(admin::stats_overview))
        .route(
            "/v1/settings",
            get(admin::settings_get).put(admin::settings_put),
        )
        .route("/v1/policy", get(admin::policy_get).put(admin::policy_put))
        .route(
            "/v1/event-definitions",
            post(admin::event_defs_create).get(admin::event_defs_list),
        )
        .route("/v1/suppressions", get(admin::suppressions_list))
        .route("/v1/suppressions/{id}", delete(admin::suppressions_delete))
        // transports
        .route(
            "/v1/transports",
            post(transports::create).get(transports::list),
        )
        .route(
            "/v1/transports/gmail/oauth/start",
            post(transports::oauth_start),
        )
        .route(
            "/v1/transports/gmail/oauth/complete",
            post(transports::oauth_complete),
        )
        .route("/v1/transports/{id}", delete(transports::delete))
        .route("/v1/transports/{id}/test", post(transports::test))
        // templates
        .route(
            "/v1/templates",
            post(templates::create).get(templates::list),
        )
        .route("/v1/templates/import", post(templates::import_route))
        .route(
            "/v1/templates/{id}",
            get(templates::get).patch(templates::patch),
        )
        .route("/v1/templates/{id}/publish", post(templates::publish))
        .route("/v1/templates/{id}/preview", post(templates::preview))
        .route("/v1/templates/{id}/export", get(templates::export))
        .route("/v1/content/lint", post(templates::lint))
        // automations
        .route(
            "/v1/automations",
            post(automations::install).get(automations::list),
        )
        .route("/v1/automations/{id}", get(automations::get))
        .route("/v1/automations/{id}/publish", post(automations::publish))
        .route("/v1/automations/{id}/pause", post(automations::pause))
        .route("/v1/automations/{id}/resume", post(automations::resume))
        .route("/v1/automations/{id}/runs", get(automations::runs))
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
        .route(
            "/v1/domains/{id}/dkim/activate",
            post(integrations::dkim_activate),
        )
        .route(
            "/v1/domains/{id}/dkim/purge",
            post(integrations::dkim_purge),
        )
        .route("/v1/domains/{id}/dns/sync", post(integrations::dns_sync))
        // contacts / segments / events (WP4 services)
        .route(
            "/v1/contacts",
            put(integrations::contacts_upsert).get(integrations::contacts_list),
        )
        .route(
            "/v1/contacts/{id}",
            get(integrations::contacts_get)
                .patch(integrations::contacts_patch)
                .delete(integrations::contacts_delete),
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

/// Background loops owned by the API process: webhook fan-out + delivery and idempotency purge.
/// (Sending is the engine's job; automations tick in `wiring::serve`.) Stops on `shutdown`.
pub async fn run_background(st: AppState, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut n: u64 = 0;
    while !*shutdown.borrow() {
        tokio::select! { _ = tick.tick() => {}, _ = shutdown.changed() => break }
        if let Err(e) = webhooks::fan_out(&st, 200).await {
            tracing::error!(error = %e, "webhook fan-out loop");
        }
        if let Err(e) = webhooks::deliver_due(&st, 50).await {
            tracing::error!(error = %e, "webhook delivery loop");
        }
        n += 1;
        if n.is_multiple_of(3600) {
            let _ = idem::purge(&st.db).await;
        }
    }
}
