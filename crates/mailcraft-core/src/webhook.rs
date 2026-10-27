//! Standard Webhooks / Svix-style signing and the delivery retry schedule (SPEC 7.4).
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::crypto::{ct_eq, random_bytes};

pub const MAX_ATTEMPTS: u32 = 8;
/// Consecutive fully-exhausted deliveries before an endpoint is auto-disabled.
pub const DISABLE_AFTER_EXHAUSTED: i32 = 5;
pub const TIMESTAMP_TOLERANCE_SECS: i64 = 300;

/// New endpoint secret: `whsec_` + base64(32 random bytes). The HMAC key is the decoded bytes.
pub fn new_secret() -> String {
    format!("whsec_{}", STANDARD.encode(random_bytes::<32>()))
}

fn key_of(secret: &str) -> Vec<u8> {
    let raw = secret.strip_prefix("whsec_").unwrap_or(secret);
    STANDARD
        .decode(raw)
        .unwrap_or_else(|_| raw.as_bytes().to_vec())
}

/// `v1,<base64 HMAC-SHA256>` over `"{id}.{timestamp}.{body}"`.
pub fn sign(secret: &str, id: &str, timestamp: i64, body: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&key_of(secret)).expect("hmac takes any key length");
    mac.update(format!("{id}.{timestamp}.{body}").as_bytes());
    format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes()))
}

/// Header pairs to send: Standard Webhooks names plus the `svix-*` twins.
pub fn headers(secret: &str, id: &str, timestamp: i64, body: &str) -> Vec<(&'static str, String)> {
    let sig = sign(secret, id, timestamp, body);
    vec![
        ("webhook-id", id.to_string()),
        ("webhook-timestamp", timestamp.to_string()),
        ("webhook-signature", sig.clone()),
        ("svix-id", id.to_string()),
        ("svix-timestamp", timestamp.to_string()),
        ("svix-signature", sig),
    ]
}

/// Receiver-side check (constant time, 5 minute window). `sig_header` may hold several
/// space-separated `v1,...` entries (key rotation).
pub fn verify(
    secret: &str,
    id: &str,
    timestamp: i64,
    body: &str,
    sig_header: &str,
    now: i64,
) -> bool {
    if (now - timestamp).abs() > TIMESTAMP_TOLERANCE_SECS {
        return false;
    }
    let expected = sign(secret, id, timestamp, body);
    sig_header
        .split(' ')
        .fold(false, |ok, s| ct_eq(s.as_bytes(), expected.as_bytes()) | ok)
}

const DELAYS_SECS: [u64; 7] = [5, 300, 1800, 7200, 18000, 36000, 36000];

/// Delay before the next attempt after `attempts_made` (>=1) tries, +/-10% jitter
/// (`jitter` in 0.0..=1.0). `None` once all 8 attempts are used.
pub fn retry_delay(attempts_made: u32, jitter: f64) -> Option<Duration> {
    let base = *DELAYS_SECS.get(attempts_made.checked_sub(1)? as usize)?;
    let f = 0.9 + 0.2 * jitter.clamp(0.0, 1.0);
    Some(Duration::from_secs_f64(base as f64 * f))
}

/// 5xx, 408, 429 retry; every other non-2xx is final.
pub fn is_retryable_status(code: u16) -> bool {
    code >= 500 || code == 408 || code == 429
}

/// Does an endpoint's `events` filter select `event_type`? Supports `*` and `email.*`.
pub fn event_matches(filters: &[String], event_type: &str) -> bool {
    filters.iter().any(|f| {
        f == "*"
            || f == event_type
            || f.strip_suffix(".*").is_some_and(|p| {
                event_type
                    .strip_prefix(p)
                    .is_some_and(|r| r.starts_with('.'))
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip() {
        let s = new_secret();
        let sig = sign(&s, "evt_1", 1000, r#"{"a":1}"#);
        assert!(sig.starts_with("v1,"));
        assert!(verify(&s, "evt_1", 1000, r#"{"a":1}"#, &sig, 1100));
        assert!(
            !verify(&s, "evt_1", 1000, r#"{"a":2}"#, &sig, 1100),
            "body tamper"
        );
        assert!(
            !verify(&s, "evt_2", 1000, r#"{"a":1}"#, &sig, 1100),
            "id tamper"
        );
        assert!(
            !verify(&s, "evt_1", 1000, r#"{"a":1}"#, &sig, 1000 + 301),
            "stale"
        );
        assert!(verify(
            &s,
            "evt_1",
            1000,
            r#"{"a":1}"#,
            &format!("v1,AAAA {sig}"),
            1000
        ));
    }

    #[test]
    fn known_vector_matches_standard_webhooks() {
        // secret bytes "12345678901234567890123456789012", message "msg_1.1.{}"
        let secret = format!(
            "whsec_{}",
            STANDARD.encode(b"12345678901234567890123456789012")
        );
        let sig = sign(&secret, "msg_1", 1, "{}");
        let mut mac = Hmac::<Sha256>::new_from_slice(b"12345678901234567890123456789012").unwrap();
        mac.update(b"msg_1.1.{}");
        assert_eq!(
            sig,
            format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes()))
        );
    }

    #[test]
    fn schedule_matches_spec() {
        let d: Vec<u64> = (1..8)
            .map(|n| retry_delay(n, 0.5).unwrap().as_secs())
            .collect();
        assert_eq!(d, [5, 300, 1800, 7200, 18000, 36000, 36000]);
        assert!(retry_delay(8, 0.5).is_none());
        assert!(retry_delay(0, 0.5).is_none());
        assert!(retry_delay(2, 0.0).unwrap().as_secs() == 270);
    }

    #[test]
    fn retry_and_filters() {
        assert!(is_retryable_status(503) && is_retryable_status(429) && is_retryable_status(408));
        assert!(!is_retryable_status(400) && !is_retryable_status(404));
        let f = vec!["email.*".to_string()];
        assert!(event_matches(&f, "email.sent"));
        assert!(!event_matches(&f, "emails.sent"));
        assert!(!event_matches(&f, "domain.verified"));
        assert!(event_matches(&["*".into()], "x"));
    }
}
