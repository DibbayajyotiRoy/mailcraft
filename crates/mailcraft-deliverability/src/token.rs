//! HMAC helpers + VERP token codec (`<msg-id>.<mac>`), shared by unsubscribe and bounce paths.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub(crate) fn b64(b: &[u8]) -> String {
    B64.encode(b)
}
pub(crate) fn unb64(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

/// HMAC-SHA256 truncated to `n` bytes (<= 32).
pub(crate) fn mac_trunc(secret: &[u8], data: &[u8], n: usize) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    m.update(data);
    m.finalize().into_bytes()[..n].to_vec()
}

/// Constant-time check of a truncated tag.
pub(crate) fn mac_verify(secret: &[u8], data: &[u8], tag: &[u8]) -> bool {
    let mut m = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    m.update(data);
    m.verify_truncated_left(tag).is_ok()
}

/// VERP codec. Return-path is `<prefix><token>@<domain>`; token = `<msg_id>.<mac>`.
/// The MAC stops anyone who knows a message id from forging bounces that suppress a recipient.
#[derive(Clone, Debug)]
pub struct Verp {
    pub secret: Vec<u8>,
    pub prefix: String, // e.g. "bounces+"
    pub domain: String, // e.g. "bounces.mail.example.com"
}

impl Verp {
    pub fn new(secret: impl Into<Vec<u8>>, domain: impl Into<String>) -> Self {
        Self {
            secret: secret.into(),
            prefix: "bounces+".into(),
            domain: domain.into(),
        }
    }
    pub fn encode(&self, msg_id: &str) -> String {
        format!(
            "{msg_id}.{}",
            b64(&mac_trunc(&self.secret, msg_id.as_bytes(), 6))
        )
    }
    /// Verified decode: returns the msg id only if the MAC matches.
    pub fn decode(&self, token: &str) -> Option<String> {
        let (id, tag) = token.rsplit_once('.')?;
        mac_verify(&self.secret, id.as_bytes(), &unb64(tag)?).then(|| id.to_string())
    }
    pub fn return_path(&self, msg_id: &str) -> String {
        format!("{}{}@{}", self.prefix, self.encode(msg_id), self.domain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verp_roundtrip_and_forgery() {
        let v = Verp::new(b"s3cret".to_vec(), "bounces.example.test");
        let t = v.encode("abc123");
        assert_eq!(v.decode(&t).as_deref(), Some("abc123"));
        assert!(v.decode("abc124.AAAAAAAA").is_none());
        assert!(Verp::new(b"other".to_vec(), "x").decode(&t).is_none());
    }
}
