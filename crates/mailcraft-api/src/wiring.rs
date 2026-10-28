//! Glue that joins the packages: the engine's `Finalizer` and `LinkMaker` over
//! `mailcraft-deliverability`, and the one-process runtime (API + send engine + automations tick
//! + webhooks) with graceful shutdown.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use chrono::Utc;
use mailcraft_automations as auto;
use mailcraft_core::{crypto::SecretBox, Result, Stream};
use mailcraft_deliverability::{
    finalize::{DefaultFinalizer, Finalizer as _, Job, TenantConfig},
    store::{
        postgres::{PgDomains, PgKeys},
        FinalizerSettings, TenantConfigLoader,
    },
    unsubscribe::{self, Category, UnsubToken},
};
use mailcraft_engine::{FinalizeCtx, Finalizer, LinkMaker};
use sqlx::PgPool;
use uuid::Uuid;

use crate::resolver::PgResolver;

const UNSUB_TTL_SECS: u64 = 90 * 86_400;

fn category(s: Stream) -> Category {
    match s {
        Stream::Marketing => Category::Product,
        Stream::Transactional => Category::Transactional,
    }
}

pub(crate) fn public_url() -> String {
    std::env::var("MAILCRAFT_PUBLIC_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "http://localhost:8080".into())
        .trim_end_matches('/')
        .to_string()
}

// ------------------------------------------------------------------ finalizer

/// DKIM, Message-ID, Feedback-ID, List-Unsubscribe (marketing) via `DefaultFinalizer`. The tenant
/// config (parsed private keys) is cached per domain for a minute. The unsubscribe token is
/// `/u/{token}`'s: tenant = workspace id, contact = contact id (nil when the recipient is not a
/// contact yet, which makes the one-click a no-op rather than an error).
pub struct DeliverabilityFinalizer {
    domains: PgDomains,
    keys: PgKeys,
    settings: FinalizerSettings,
    unsub_secret: Vec<u8>,
    cache: Mutex<HashMap<Uuid, (Instant, Arc<TenantConfig>)>>,
}

impl DeliverabilityFinalizer {
    pub fn new(pool: PgPool, secrets: SecretBox, unsub_secret: &[u8]) -> Self {
        Self {
            domains: PgDomains::new(pool.clone()),
            keys: PgKeys::new(pool, secrets),
            settings: FinalizerSettings {
                verp_secret: crate::ingest::verp_secret(unsub_secret),
                unsub_secret: unsub_secret.to_vec(),
                unsub_base_url: public_url(),
                // e.g. unsub@mx.example.com; needs MAILCRAFT_INBOUND_SMTP_BIND + an MX for that host.
                unsub_mailto: std::env::var("MAILCRAFT_UNSUB_MAILTO")
                    .ok()
                    .filter(|m| !m.is_empty()),
                unsub_ttl_secs: UNSUB_TTL_SECS,
                feedback_sender_id: "mailcraft".into(),
                transactional_unsubscribe: false,
            },
            unsub_secret: unsub_secret.to_vec(),
            cache: Default::default(),
        }
    }

    async fn tenant(&self, domain_id: Uuid) -> Result<Arc<TenantConfig>> {
        if let Some((at, t)) = self.cache.lock().unwrap().get(&domain_id) {
            if at.elapsed() < Duration::from_secs(60) {
                return Ok(t.clone());
            }
        }
        let (cfg, _) = TenantConfigLoader {
            domains: &self.domains,
            keys: &self.keys,
            settings: &self.settings,
        }
        .load(domain_id)
        .await?;
        let t = Arc::new(cfg);
        self.cache
            .lock()
            .unwrap()
            .insert(domain_id, (Instant::now(), t.clone()));
        Ok(t)
    }
}

#[async_trait]
impl Finalizer for DeliverabilityFinalizer {
    fn return_path(&self, email_id: Uuid, host: &str) -> String {
        // MAC-signed VERP, checked by the inbound receiver before it trusts a bounce.
        crate::ingest::return_path(&self.unsub_secret, email_id, host)
    }

    async fn finalize(&self, ctx: &FinalizeCtx, raw: Vec<u8>) -> Result<Vec<u8>> {
        // No domain (Gmail path): the provider signs.
        let Some(domain_id) = ctx.domain_id else {
            return Ok(raw);
        };
        let tenant = self.tenant(domain_id).await?;
        let job = Job {
            email_id: ctx.email_id,
            stream: ctx.stream,
            category: category(ctx.stream),
            contact_id: ctx.contact_id.unwrap_or_default().to_string(),
            campaign_id: "mailcraft".into(),
            now: Utc::now().timestamp().max(0) as u64,
        };
        DefaultFinalizer.finalize(&raw, &tenant, &job)
    }
}

// ------------------------------------------------------------------ links

/// Unsubscribe / preferences URLs for template rendering; same token as the List-Unsubscribe header.
pub struct PgLinks {
    pub base: String,
    pub secret: Vec<u8>,
}

impl LinkMaker for PgLinks {
    fn links(&self, ws: Uuid, contact: Option<Uuid>, stream: Stream) -> (String, String) {
        let tok = unsubscribe::issue(
            &self.secret,
            &UnsubToken {
                tenant: ws.simple().to_string(),
                contact: contact.unwrap_or_default().to_string(),
                category: category(stream),
                exp: Utc::now().timestamp().max(0) as u64 + UNSUB_TTL_SECS,
            },
        );
        match tok {
            // ponytail: no separate preferences page yet; /u/{token} GET is the confirm page for both.
            Ok(t) => {
                let u = format!("{}/u/{t}", self.base);
                (u.clone(), u)
            }
            Err(_) => (String::new(), String::new()), // transactional: nothing to unsubscribe from
        }
    }
}

// ------------------------------------------------------------------ runtime

/// The API state (real services, same secret) plus the send engine that shares its pool.
pub async fn assemble(
    pool: PgPool,
    redis: Option<redis::aio::ConnectionManager>,
    secret_key: &str,
    config: crate::Config,
) -> anyhow::Result<(crate::AppState, Arc<mailcraft_engine::Engine>)> {
    let st = crate::AppState::with_services(
        pool.clone(),
        redis,
        secret_key,
        config,
        auto::personalizer_from_env(pool.clone()),
    )?;
    let limits = match std::env::var("REDIS_URL").ok().filter(|u| !u.is_empty()) {
        Some(url) => match mailcraft_engine::Limits::redis(&url).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "engine limits: redis unavailable, using in-process");
                mailcraft_engine::Limits::in_process()
            }
        },
        None => mailcraft_engine::Limits::in_process(),
    };
    let secrets = st.secrets.clone();
    let unsub = st.config.unsub_secret.clone();
    let engine = mailcraft_engine::Engine::new(
        pool.clone(),
        Arc::new(PgResolver::new(pool.clone(), secrets.clone())),
    )
    .finalizer(Arc::new(DeliverabilityFinalizer::new(
        pool, secrets, &unsub,
    )))
    .links(Arc::new(PgLinks {
        base: public_url(),
        secret: unsub,
    }))
    .limits(Arc::new(limits));
    Ok((st, Arc::new(engine)))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

/// `mailcraft-server serve`: API + send engine + automations tick + webhooks in one process.
/// On SIGINT / SIGTERM the HTTP server drains, then the workers finish their in-flight batch.
pub async fn serve(
    pool: PgPool,
    redis: Option<redis::aio::ConnectionManager>,
    secret_key: &str,
    addr: &str,
) -> anyhow::Result<()> {
    let (st, engine) = assemble(pool.clone(), redis, secret_key, crate::Config::from_env()).await?;
    let (stop, rx) = tokio::sync::watch::channel(false);
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(engine.run(rx.clone()));
    tasks.spawn(crate::run_background(st.clone(), rx.clone()));
    // The API's own automations engine only ingests events; this one runs the timers.
    let journeys = auto::Engine::new(
        pool.clone(),
        auto::personalizer_from_env(pool),
        auto::EngineConfig::default(),
    );
    let stop_rx = rx.clone();
    let mut rx2 = rx;
    tasks.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        while !*rx2.borrow() {
            tokio::select! { _ = tick.tick() => {}, _ = rx2.changed() => break }
            if let Err(e) = journeys.tick(Utc::now()).await {
                tracing::error!(error = %e, "automations tick");
            }
        }
    });
    if let Some(bind) = std::env::var("MAILCRAFT_INBOUND_SMTP_BIND")
        .ok()
        .filter(|b| !b.is_empty())
    {
        let max = std::env::var("MAILCRAFT_INBOUND_MAX_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5 << 20);
        let l = tokio::net::TcpListener::bind(&bind).await?;
        tracing::info!(%bind, "inbound SMTP (bounces, complaints, mailto unsubscribe)");
        tasks.spawn(crate::smtp_in::serve(st.clone(), l, max, stop_rx));
    }
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "mailcraft-server listening (api + engine + automations + webhooks)");
    axum::serve(listener, crate::router(st))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("shutting down: draining workers");
    let _ = stop.send(true);
    while tasks.join_next().await.is_some() {}
    Ok(())
}
