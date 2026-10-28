use std::sync::Arc;

use mailcraft_core::{
    crypto::SecretBox,
    services::{
        ContactService, DomainService, EventService, SegmentService, StubContactService,
        StubDomainService, StubEventService, StubSegmentService,
    },
};
use redis::aio::ConnectionManager;
use sqlx::PgPool;

use crate::metrics::Metrics;

#[derive(Clone)]
pub struct Config {
    /// Per-key API requests per minute.
    pub rate_limit_per_min: i64,
    /// Bearer token for `/metrics` (None = open; bind it internally).
    pub metrics_token: Option<String>,
    /// Permit webhook targets on private networks (dev/tests only).
    pub allow_private_webhooks: bool,
    /// HMAC secret for `/u/{token}`. The finalizer must sign with the same one
    /// (`FinalizerSettings::unsub_secret`). `MAILCRAFT_UNSUB_SECRET`, else derived from the secret key.
    pub unsub_secret: Vec<u8>,
    /// Gmail OAuth client (`MAILCRAFT_GOOGLE_CLIENT_ID` / `_SECRET`); self-hosters bring their own.
    pub google_oauth: Option<GoogleOauth>,
    /// `MAILCRAFT_INGEST_TOKEN`: authenticates `/ingest/raw` and `/ingest/ses`; unset = both disabled.
    pub ingest_token: Option<String>,
    /// `MAILCRAFT_SES_TOPIC_ARNS` (comma separated): SNS topics `/ingest/ses` accepts.
    pub ses_topic_arns: Vec<String>,
}

#[derive(Clone)]
pub struct GoogleOauth {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub auth_url: String,
    pub token_url: String,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|s| !s.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            rate_limit_per_min: std::env::var("MAILCRAFT_RATE_LIMIT_PER_MIN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(600),
            metrics_token: std::env::var("MAILCRAFT_METRICS_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            allow_private_webhooks: std::env::var("MAILCRAFT_ALLOW_PRIVATE_WEBHOOKS").as_deref()
                == Ok("1"),
            unsub_secret: env("MAILCRAFT_UNSUB_SECRET")
                .or_else(|| env("MAILCRAFT_SECRET_KEY").map(|k| format!("unsub:{k}")))
                .unwrap_or_default()
                .into_bytes(),
            ingest_token: env("MAILCRAFT_INGEST_TOKEN"),
            ses_topic_arns: env("MAILCRAFT_SES_TOPIC_ARNS")
                .map(|v| v.split(',').map(|a| a.trim().to_string()).collect())
                .unwrap_or_default(),
            google_oauth: env("MAILCRAFT_GOOGLE_CLIENT_ID").map(|client_id| GoogleOauth {
                client_id,
                client_secret: env("MAILCRAFT_GOOGLE_CLIENT_SECRET"),
                auth_url: mailcraft_transport::oauth::AUTH_URL.into(),
                token_url: mailcraft_transport::oauth::TOKEN_URL.into(),
            }),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: Option<ConnectionManager>,
    pub secrets: SecretBox,
    pub config: Config,
    pub metrics: Arc<Metrics>,
    pub domains: Arc<dyn DomainService>,
    pub contacts: Arc<dyn ContactService>,
    pub segments: Arc<dyn SegmentService>,
    pub events: Arc<dyn EventService>,
    /// Deliverability crate's own `SecretBox` over the same key; `None` with stub services.
    pub dkim_box: Option<mailcraft_deliverability::crypto::SecretBox>,
}

impl AppState {
    /// State with stub domain / contact / segment / event services (swap fields to wire real ones).
    pub fn new(
        db: PgPool,
        redis: Option<ConnectionManager>,
        secrets: SecretBox,
        config: Config,
    ) -> Self {
        Self {
            db,
            redis,
            secrets,
            config,
            metrics: Arc::new(Metrics::new()),
            domains: Arc::new(StubDomainService),
            contacts: Arc::new(StubContactService),
            segments: Arc::new(StubSegmentService),
            events: Arc::new(StubEventService),
            dkim_box: None,
        }
    }
}
