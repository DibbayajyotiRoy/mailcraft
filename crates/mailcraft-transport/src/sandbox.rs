//! Sandbox transport for `mc_test_` keys: nothing leaves the box. The recipient's local part
//! (any domain, `+label` allowed) picks the simulated outcome (SPEC 4.5):
//! `delivered@`, `bounced@` (550 5.1.1), `complained@`, `suppressed@`, `deferred@` (4.2.0 then success).
//! Any other address is treated as delivered.
use crate::{ClassifiedTransport, Outbound, SendReceipt, TransportError};
use std::{collections::HashSet, sync::Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxOutcome {
    Delivered,
    Bounced,
    Complained,
    Suppressed,
    /// Defers on the first attempt, delivers afterwards.
    Deferred,
}

impl SandboxOutcome {
    /// Outcome for a recipient address.
    pub fn for_rcpt(rcpt: &str) -> Self {
        let local = rcpt
            .split('@')
            .next()
            .unwrap_or("")
            .split('+')
            .next()
            .unwrap_or("");
        match local.to_ascii_lowercase().as_str() {
            "bounced" => Self::Bounced,
            "complained" => Self::Complained,
            "suppressed" => Self::Suppressed,
            "deferred" => Self::Deferred,
            _ => Self::Delivered,
        }
    }
}

#[derive(Default)]
pub struct Sandbox {
    /// Raw messages "delivered" to the sandbox inbox (in memory; the engine owns persistence).
    inbox: Mutex<Vec<Outbound>>,
    deferred_once: Mutex<HashSet<Uuid>>,
}

impl Sandbox {
    pub fn new() -> Self {
        Self::default()
    }
    /// Store the message in the sandbox inbox and return the receipt (no outcome simulation).
    pub fn accept(&self, msg: &Outbound) -> SendReceipt {
        self.inbox.lock().unwrap().push(msg.clone());
        SendReceipt {
            provider_message_id: Some(format!("sandbox-{}", msg.email_id)),
        }
    }
    pub fn inbox(&self) -> Vec<Outbound> {
        self.inbox.lock().unwrap().clone()
    }
}

crate::impl_transport!(Sandbox, "sandbox");

#[async_trait::async_trait]
impl ClassifiedTransport for Sandbox {
    async fn submit(&self, msg: &Outbound) -> Result<SendReceipt, TransportError> {
        match SandboxOutcome::for_rcpt(&msg.rcpt_to) {
            SandboxOutcome::Bounced => Err(TransportError::Permanent(
                "550 5.1.1 sandbox: no such user".into(),
            )),
            SandboxOutcome::Deferred if self.deferred_once.lock().unwrap().insert(msg.email_id) => {
                Err(TransportError::Temporary(
                    "451 4.2.0 sandbox: try again later".into(),
                ))
            }
            // Suppression is a dequeue gate in the engine; at this layer it is accepted.
            _ => Ok(self.accept(msg)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{sample, DeliveryResult, Transport};

    #[test]
    fn magic_addresses_any_domain_and_label() {
        for (a, o) in [
            ("bounced@test.mailcraft.local", SandboxOutcome::Bounced),
            ("Complained+x@example.com", SandboxOutcome::Complained),
            ("suppressed@a.b", SandboxOutcome::Suppressed),
            ("deferred+1@a.b", SandboxOutcome::Deferred),
            ("delivered@a.b", SandboxOutcome::Delivered),
            ("someone@a.b", SandboxOutcome::Delivered),
        ] {
            assert_eq!(SandboxOutcome::for_rcpt(a), o, "{a}");
        }
    }

    #[tokio::test]
    async fn outcomes_map_to_delivery_results() {
        let sb = Sandbox::new();
        let mut m = sample();
        m.rcpt_to = "bounced@x.test".into();
        assert!(matches!(
            sb.deliver(&m).await,
            DeliveryResult::Rejected { smtp_code: 550, enhanced: Some(e), .. } if e == "5.1.1"
        ));
        m.rcpt_to = "deferred@x.test".into();
        assert!(matches!(
            sb.deliver(&m).await,
            DeliveryResult::Deferred {
                smtp_code: Some(451),
                ..
            }
        ));
        assert!(matches!(
            sb.deliver(&m).await,
            DeliveryResult::Accepted { .. }
        ));
        assert_eq!(sb.inbox().len(), 1);
    }
}
