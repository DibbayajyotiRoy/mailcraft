use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::Stream;

/// A fully rendered, DKIM-unsigned message ready for a transport.
/// `raw` is the RFC 5322 MIME produced by the engine (headers incl. List-Unsubscribe).
#[derive(Debug, Clone)]
pub struct Outbound {
    pub email_id: uuid::Uuid,
    pub stream: Stream,
    /// Envelope sender: VERP `bounce+<token>@bounce.<domain>` (deliverability.md 4.1).
    pub mail_from: String,
    pub rcpt_to: String,
    pub raw: Vec<u8>,
}

/// Outcome of one delivery attempt. Transports classify; the engine decides retries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum DeliveryResult {
    /// Accepted by the next hop (relay or recipient MX). Not yet "delivered" for relays.
    Accepted { provider_message_id: Option<String> },
    /// 4xx / connection error / throttled: retry later.
    Deferred {
        smtp_code: Option<u16>,
        reason: String,
    },
    /// 5xx at submit time: counts as a bounce, never retried.
    Rejected {
        smtp_code: u16,
        enhanced: Option<String>,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsRecord {
    pub record: String, // "DKIM" | "SPF" | "DMARC" | "ReturnPath" | "Tracking"
    #[serde(rename = "type")]
    pub kind: String, // "TXT" | "CNAME" | "MX"
    pub name: String,
    pub value: String,
    pub status: String, // "not_started" | "pending" | "verified" | "failed"
}

/// Delivery plugin. Implementations: smtp-relay, ses, gmail-oauth, direct, (later) kumomta.
#[async_trait]
pub trait Transport: Send + Sync {
    /// Stable id used in config and `emails.transport`: "smtp-relay", "ses", ...
    fn id(&self) -> &'static str;
    /// Attempt one delivery. Must not retry internally.
    async fn deliver(&self, msg: &Outbound) -> DeliveryResult;
    /// Records the user must publish for this transport (SES identity, relay DKIM, ...).
    /// Default: none (engine-generated DKIM/SPF/DMARC records apply).
    async fn dns_records(&self, _domain: &str) -> crate::Result<Vec<DnsRecord>> {
        Ok(vec![])
    }
}
