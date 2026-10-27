use async_trait::async_trait;
use mailcraft_core::transport::{DeliveryResult, Outbound, Transport};

/// Authenticated submission to a BYO relay (Postmark, Mailgun, Brevo, SMTP2GO, ...).
/// Stub: real client is `mail-send` over rustls on 587/465 (SPEC 9.1).
#[derive(Debug, Clone)]
pub struct SmtpRelay {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

#[async_trait]
impl Transport for SmtpRelay {
    fn id(&self) -> &'static str {
        "smtp-relay"
    }
    async fn deliver(&self, _msg: &Outbound) -> DeliveryResult {
        // Not implemented: defer so a queued message is never lost or falsely marked sent.
        DeliveryResult::Deferred {
            smtp_code: None,
            reason: "smtp-relay transport not implemented".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailcraft_core::Stream;

    #[tokio::test]
    async fn stub_defers_never_claims_success() {
        let t = SmtpRelay {
            host: "smtp.example.com".into(),
            port: 587,
            username: "u".into(),
            password: "p".into(),
        };
        let m = Outbound {
            email_id: uuid::Uuid::nil(),
            stream: Stream::Transactional,
            mail_from: "a@b".into(),
            rcpt_to: "c@d".into(),
            raw: vec![],
        };
        assert!(matches!(
            t.deliver(&m).await,
            DeliveryResult::Deferred { .. }
        ));
    }
}
