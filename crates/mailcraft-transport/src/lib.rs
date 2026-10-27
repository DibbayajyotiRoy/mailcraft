//! Transport implementations for `mailcraft_core::transport::Transport`.
//!
//! Core's `DeliveryResult` has no Auth / RateLimited variants, so each transport also implements
//! [`ClassifiedTransport::submit`], which returns the full [`TransportError`] class. The engine
//! calls `submit`; `Transport::deliver` is the lossy core-trait view (Auth and RateLimited become
//! `Deferred` with an `auth:` / `rate_limited:` reason prefix).
//!
//! Default egress order (product decision, no hosted shared relay): Gmail OAuth (send as yourself)
//! -> BYO SES / SMTP relay -> own domain / direct.

pub mod error;
pub mod gmail;
pub mod oauth;
pub mod sandbox;
pub mod ses;
pub mod smtp;

pub use error::{ErrorClass, TransportError};
pub use gmail::{CapStore, GmailCredentials, GmailOAuth, MemoryCapStore};
pub use mailcraft_core::transport::{DeliveryResult, Outbound, Transport};
pub use sandbox::{Sandbox, SandboxOutcome};
pub use ses::{SesCredentials, SesV2};
pub use smtp::{SmtpConfig, SmtpRelay, TlsMode};

/// What a successful submit hands back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendReceipt {
    /// Gmail `id`, SES `MessageId`, SMTP reply text ("queued as ...").
    pub provider_message_id: Option<String>,
}

/// A transport that reports the engine-relevant error class. All transports here implement it.
#[async_trait::async_trait]
pub trait ClassifiedTransport: Transport {
    /// One delivery attempt to every envelope recipient in `rcpts` (To, Cc; never listed in
    /// headers if Bcc), in a single transaction. No internal retry. `Outbound::rcpt_to` is the
    /// primary recipient; core's single-recipient field cannot carry Cc, hence this parameter.
    async fn submit_all(
        &self,
        msg: &Outbound,
        rcpts: &[String],
    ) -> Result<SendReceipt, TransportError>;

    /// Single-recipient convenience (`msg.rcpt_to` only).
    async fn submit(&self, msg: &Outbound) -> Result<SendReceipt, TransportError> {
        self.submit_all(msg, std::slice::from_ref(&msg.rcpt_to))
            .await
    }
}

/// Lossy mapping onto core's `DeliveryResult`.
pub fn to_delivery_result(r: Result<SendReceipt, TransportError>) -> DeliveryResult {
    match r {
        Ok(rc) => DeliveryResult::Accepted {
            provider_message_id: rc.provider_message_id,
        },
        Err(e @ TransportError::Permanent(_)) => DeliveryResult::Rejected {
            smtp_code: e.smtp_code().unwrap_or(550),
            enhanced: e.enhanced_code(),
            reason: e.to_string(),
        },
        Err(e @ TransportError::Temporary(_)) => DeliveryResult::Deferred {
            smtp_code: e.smtp_code(),
            reason: e.to_string(),
        },
        Err(e @ TransportError::Auth(_)) => DeliveryResult::Deferred {
            smtp_code: e.smtp_code(),
            reason: format!("auth: {e}"),
        },
        Err(e @ TransportError::RateLimited { .. }) => DeliveryResult::Deferred {
            smtp_code: e.smtp_code(),
            reason: format!("rate_limited: {e}"),
        },
    }
}

/// Implements core's `Transport` on top of `ClassifiedTransport::submit`.
macro_rules! impl_transport {
    ($ty:ty, $id:literal) => {
        #[async_trait::async_trait]
        impl $crate::Transport for $ty {
            fn id(&self) -> &'static str {
                $id
            }
            async fn deliver(&self, msg: &$crate::Outbound) -> $crate::DeliveryResult {
                $crate::to_delivery_result($crate::ClassifiedTransport::submit(self, msg).await)
            }
        }
    };
}
pub(crate) use impl_transport;

#[cfg(test)]
pub(crate) fn sample() -> Outbound {
    let raw = "From: Ann <ann@example.com>\r\nTo: bob@example.org\r\nSubject: Hello\r\n\
Message-ID: <m1@example.com>\r\nList-Unsubscribe: <https://x.test/u/1>\r\n\
List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nplain body\r\n";
    Outbound {
        email_id: uuid::Uuid::nil(),
        stream: mailcraft_core::Stream::Transactional,
        mail_from: "bounce+abc@bounce.example.com".into(),
        rcpt_to: "bob@example.org".into(),
        raw: raw.as_bytes().to_vec(),
    }
}
