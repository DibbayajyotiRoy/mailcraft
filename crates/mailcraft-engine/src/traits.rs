//! Seams other work packages implement or wire.
use async_trait::async_trait;
use mailcraft_core::{Error, Result, Stream};
use mailcraft_transport::ClassifiedTransport;
use std::sync::Arc;
use uuid::Uuid;

/// A configured transport ready to send. `name` keys pauses and throttles, so make it stable.
#[derive(Clone)]
pub struct ResolvedTransport {
    /// `transports.id` when the transport is a stored row; recorded on `emails.transport_id`.
    pub id: Option<Uuid>,
    pub name: String,
    pub transport: Arc<dyn ClassifiedTransport>,
}

/// Picks (and builds, decrypting `transports.config_enc`) the transport for an email.
/// WP1/API wires the real one; `None` means "nothing configured": the email waits.
#[async_trait]
pub trait TransportResolver: Send + Sync {
    async fn resolve(
        &self,
        workspace_id: Uuid,
        transport_id: Option<Uuid>,
    ) -> Result<Option<ResolvedTransport>>;
}

/// One fixed transport for every email (tests, single-transport installs).
pub struct StaticResolver(pub ResolvedTransport);

#[async_trait]
impl TransportResolver for StaticResolver {
    async fn resolve(&self, _: Uuid, _: Option<Uuid>) -> Result<Option<ResolvedTransport>> {
        Ok(Some(self.0.clone()))
    }
}

/// Per-email links injected into templates at render time: (unsubscribe_url, preferences_url).
pub trait LinkMaker: Send + Sync {
    fn links(&self, workspace_id: Uuid, email_id: Uuid, stream: Stream) -> (String, String);
}

/// No public URL configured: templates still render, links are empty.
pub struct NoLinks;
impl LinkMaker for NoLinks {
    fn links(&self, _: Uuid, _: Uuid, _: Stream) -> (String, String) {
        (String::new(), String::new())
    }
}

pub struct FinalizeCtx {
    pub email_id: Uuid,
    pub workspace_id: Uuid,
    pub domain_id: Option<Uuid>,
    pub stream: Stream,
    /// Domain of the From address (DKIM `d=` candidate).
    pub from_domain: String,
}

/// Last step before the wire: DKIM signing, Feedback-ID, List-Unsubscribe, ... (WP3 implements).
/// Takes the assembled RFC 5322 bytes, returns the bytes to send.
#[async_trait]
pub trait Finalizer: Send + Sync {
    async fn finalize(&self, ctx: &FinalizeCtx, raw: Vec<u8>) -> Result<Vec<u8>>;
}

pub struct NoopFinalizer;

#[async_trait]
impl Finalizer for NoopFinalizer {
    async fn finalize(&self, _: &FinalizeCtx, raw: Vec<u8>) -> Result<Vec<u8>> {
        Ok(raw)
    }
}

/// Dequeue-time suppression gate. A `true` ends the email as `suppressed`; an `Err` delays it
/// (fail closed). WP3 can extend this with topic / unsubscribe checks.
#[async_trait]
pub trait SuppressionCheck: Send + Sync {
    async fn is_suppressed(&self, workspace_id: Uuid, email: &str) -> Result<bool>;
}

/// Checks the `suppressions` table.
pub struct PgSuppressions(pub sqlx::PgPool);

#[async_trait]
impl SuppressionCheck for PgSuppressions {
    async fn is_suppressed(&self, workspace_id: Uuid, email: &str) -> Result<bool> {
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = lower($2))")
            .bind(workspace_id)
            .bind(email.trim())
            .fetch_one(&self.0)
            .await
            .map_err(db_err)
    }
}

pub(crate) fn db_err(e: sqlx::Error) -> Error {
    Error::new("database_error", 500, e.to_string()).retryable()
}
