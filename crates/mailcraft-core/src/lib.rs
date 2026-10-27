//! Domain types, structured errors and plugin traits. No I/O lives here.
//! See SPEC.md section 9 (plugin traits) and 4.3 (errors).

pub mod error;
pub mod llm;
pub mod retry;
pub mod transport;

pub use error::{Error, ErrorBody, Result};

use serde::{Deserialize, Serialize};

/// Separate reputation streams (deliverability.md 3.2). A transactional send
/// can never carry marketing blocks, tracking or List-Unsubscribe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    Transactional,
    Marketing,
}

/// Per-key policy decision for an action (agent-native.md section 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    Auto,
    NeedsApproval,
    Blocked,
}

/// Email lifecycle states (SPEC 8, `emails.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmailStatus {
    Queued,
    PendingApproval,
    Sending,
    Deferred,
    Sent,
    Delivered,
    Bounced,
    Failed,
    Suppressed,
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_serialize_snake_case() {
        assert_eq!(
            serde_json::to_string(&EmailStatus::PendingApproval).unwrap(),
            "\"pending_approval\""
        );
        assert_eq!(
            serde_json::to_string(&Policy::NeedsApproval).unwrap(),
            "\"needs_approval\""
        );
    }
}
