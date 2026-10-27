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
        }
    }
}
