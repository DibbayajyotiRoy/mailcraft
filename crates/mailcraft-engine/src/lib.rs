//! Queue worker (SPEC 8.3). Postgres is the queue: workers claim due `emails` rows with
//! `FOR UPDATE SKIP LOCKED`, run the dequeue gates, assemble MIME, hand it to the `Finalizer`
//! (DKIM etc.), deliver through a transport and record the outcome plus `email_events` rows
//! (the webhook outbox). A reaper requeues rows whose lease expired.
//!
//! Redis (via [`Limits`]) only holds volatile caps/throttles/pauses; without it the engine
//! degrades to Postgres counts and in-process limiters, and mail is never lost.

mod limits;
mod metrics;
pub mod mime;
mod traits;
mod worker;

pub use limits::Limits;
pub use metrics::Metrics;
pub use traits::{
    FinalizeCtx, Finalizer, NoopFinalizer, PgSuppressions, ResolvedTransport, StaticResolver,
    SuppressionCheck, TransportResolver,
};
pub use worker::{CapStorePg, Engine, EngineConfig, CLAIM_SQL};

/// Envelope sender: VERP `bounce+<email id>@<return path host>` (deliverability.md 4.1).
/// The bounce processor recovers the email from the token.
pub fn verp_mail_from(email_id: uuid::Uuid, return_path_host: &str) -> String {
    format!("bounce+{}@{return_path_host}", email_id.simple())
}

/// Recover the email id from a VERP local part (`bounce+<token>`), the inverse of [`verp_mail_from`].
pub fn parse_verp(addr: &str) -> Option<uuid::Uuid> {
    let tok = addr.split('@').next()?.strip_prefix("bounce+")?;
    uuid::Uuid::parse_str(tok).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn verp_roundtrip() {
        let id = uuid::Uuid::new_v4();
        let a = super::verp_mail_from(id, "bounce.example.com");
        assert_eq!(super::parse_verp(&a), Some(id));
        assert_eq!(super::parse_verp("someone@x.com"), None);
    }
}
