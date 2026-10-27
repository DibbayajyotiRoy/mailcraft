//! `TransportResolver` over the `transports` table. The plaintext config shapes are the ones
//! `transports.rs` writes (`config_enc` = SecretBox seal with the transport id as AAD).
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use mailcraft_core::{crypto::SecretBox, Error, Result};
use mailcraft_engine::{CapStorePg, ResolvedTransport, TransportResolver};
use mailcraft_transport::{
    ClassifiedTransport, GmailCredentials, GmailOAuth, SesCredentials, SesV2, SmtpConfig,
    SmtpRelay, TlsMode,
};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

fn str_of<'a>(c: &'a Value, k: &str) -> Option<&'a str> {
    c[k].as_str().filter(|v| !v.is_empty())
}

fn bad(m: impl Into<String>) -> Error {
    Error::new("transport_config_invalid", 500, m.into())
}

/// Row config -> live transport.
pub fn build(kind: &str, c: &Value, id: Uuid, daily_cap: Option<i32>, pool: &PgPool) -> Result<Arc<dyn ClassifiedTransport>> {
    match kind {
        "smtp-relay" => {
            let tls = match str_of(c, "tls").unwrap_or("starttls") {
                "none" => TlsMode::None,
                "implicit" => TlsMode::Implicit,
                _ => TlsMode::StartTls,
            };
            let cfg = SmtpConfig {
                host: str_of(c, "host").ok_or_else(|| bad("smtp-relay: host missing"))?.into(),
                port: c["port"].as_u64().and_then(|p| u16::try_from(p).ok()).ok_or_else(|| bad("smtp-relay: port missing"))?,
                tls,
                username: str_of(c, "username").map(String::from),
                password: str_of(c, "password").map(String::from),
                timeout: Duration::from_secs(30),
            };
            Ok(Arc::new(SmtpRelay::new(&cfg).map_err(|e| bad(e.to_string()))?))
        }
        "ses" => Ok(Arc::new(SesV2::new(
            SesCredentials {
                access_key_id: str_of(c, "access_key_id").ok_or_else(|| bad("ses: access_key_id missing"))?.into(),
                secret_access_key: str_of(c, "secret_access_key").ok_or_else(|| bad("ses: secret_access_key missing"))?.into(),
                session_token: str_of(c, "session_token").map(String::from),
            },
            str_of(c, "region").unwrap_or("us-east-1"),
        ))),
        "gmail-oauth" => Ok(Arc::new(GmailOAuth::new(
            GmailCredentials {
                client_id: str_of(c, "client_id").ok_or_else(|| bad("gmail: client_id missing"))?.into(),
                client_secret: str_of(c, "client_secret").map(String::from),
                refresh_token: str_of(c, "refresh_token").ok_or_else(|| bad("gmail: refresh_token missing"))?.into(),
            },
            daily_cap.map_or(500, |c| c.max(1) as usize),
            Arc::new(CapStorePg { pool: pool.clone(), transport_id: id }),
        ))),
        other => Err(Error::new("transport_unsupported", 422, format!("transport kind `{other}` is not available in this build"))),
    }
}

/// Built transports are cached for a minute: Gmail keeps its access token inside the object.
pub struct PgResolver {
    pool: PgPool,
    secrets: SecretBox,
    cache: Mutex<HashMap<Uuid, (Instant, ResolvedTransport)>>,
}

impl PgResolver {
    pub fn new(pool: PgPool, secrets: SecretBox) -> Self {
        Self { pool, secrets, cache: Default::default() }
    }
}

#[async_trait]
impl TransportResolver for PgResolver {
    async fn resolve(&self, ws: Uuid, transport_id: Option<Uuid>) -> Result<Option<ResolvedTransport>> {
        let row: Option<(Uuid, String, Vec<u8>, Option<i32>)> = sqlx::query_as(
            "SELECT id, kind, config_enc, daily_cap FROM transports WHERE workspace_id = $1 \
             AND ($2::uuid IS NULL OR id = $2) ORDER BY is_default DESC, created_at LIMIT 1",
        )
        .bind(ws)
        .bind(transport_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| Error::new("database_error", 500, e.to_string()).retryable())?;
        let Some((id, kind, enc, cap)) = row else { return Ok(None) };
        if let Some((at, r)) = self.cache.lock().unwrap().get(&id) {
            if at.elapsed() < Duration::from_secs(60) {
                return Ok(Some(r.clone()));
            }
        }
        let cfg: Value = serde_json::from_slice(&self.secrets.open(&enc, id.as_bytes())?).map_err(|e| bad(e.to_string()))?;
        let r = ResolvedTransport {
            id: Some(id),
            name: format!("{kind}:{}", &id.simple().to_string()[..8]),
            transport: build(&kind, &cfg, id, cap, &self.pool)?,
        };
        self.cache.lock().unwrap().insert(id, (Instant::now(), r.clone()));
        Ok(Some(r))
    }
}
