//! AES-256-GCM sealing for secrets at rest (DKIM private keys), keyed by `MAILCRAFT_SECRET_KEY`.
//!
//! NOTE for WP1: this is a local copy of the secret-box helper; unify with core's once it exists.
//! Wire format: `0x01 || nonce(12) || ciphertext+tag`. A fresh random nonce per seal.
use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, Payload},
};
use rand::RngCore;
use sha2::{Digest, Sha256};

const VERSION: u8 = 1;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("MAILCRAFT_SECRET_KEY is not set")]
    MissingKey,
    #[error(
        "MAILCRAFT_SECRET_KEY must be 32 bytes as hex (64 chars) or base64, or any passphrase of 16+ chars"
    )]
    BadKey,
    #[error("ciphertext is malformed or the key is wrong")]
    Decrypt,
}

#[derive(Clone)]
pub struct SecretBox(Aes256Gcm);

impl SecretBox {
    /// 32 raw bytes.
    pub fn from_bytes(key: &[u8; 32]) -> Self {
        Self(Aes256Gcm::new(key.into()))
    }

    /// Accepts 64 hex chars, 32-byte base64, or (>= 16 chars) a passphrase hashed with SHA-256.
    pub fn from_secret(s: &str) -> Result<Self, CryptoError> {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let s = s.trim();
        if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
            let mut k = [0u8; 32];
            for (i, c) in s.as_bytes().chunks(2).enumerate() {
                k[i] = u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap();
            }
            return Ok(Self::from_bytes(&k));
        }
        if let Ok(b) = STANDARD.decode(s)
            && let Ok(k) = <[u8; 32]>::try_from(b.as_slice())
        {
            return Ok(Self::from_bytes(&k));
        }
        if s.len() >= 16 {
            return Ok(Self::from_bytes(&Sha256::digest(s.as_bytes()).into()));
        }
        Err(CryptoError::BadKey)
    }

    pub fn from_env() -> Result<Self, CryptoError> {
        Self::from_secret(
            &std::env::var("MAILCRAFT_SECRET_KEY").map_err(|_| CryptoError::MissingKey)?,
        )
    }

    /// `aad` binds the ciphertext to its row (e.g. `domain_id:selector`), so a blob cannot be moved.
    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let ct = self
            .0
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .expect("aes-gcm encrypt does not fail on in-memory input");
        let mut out = vec![VERSION];
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        out
    }

    pub fn open(&self, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if sealed.len() < 13 + 16 || sealed[0] != VERSION {
            return Err(CryptoError::Decrypt);
        }
        self.0
            .decrypt(
                (&sealed[1..13]).into(),
                Payload {
                    msg: &sealed[13..],
                    aad,
                },
            )
            .map_err(|_| CryptoError::Decrypt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_aad_and_tamper() {
        let b = SecretBox::from_secret("a-long-enough-passphrase").unwrap();
        let s = b.seal(b"pem", b"d1:mc2026a");
        assert_eq!(b.open(&s, b"d1:mc2026a").unwrap(), b"pem");
        assert!(b.open(&s, b"d2:mc2026a").is_err(), "aad binds the row");
        let mut t = s.clone();
        *t.last_mut().unwrap() ^= 1;
        assert!(b.open(&t, b"d1:mc2026a").is_err());
        assert_ne!(b.seal(b"pem", b""), b.seal(b"pem", b""), "fresh nonce");
        assert!(SecretBox::from_secret("short").is_err());
        let hex = "00".repeat(32);
        assert!(SecretBox::from_secret(&hex).is_ok());
    }
}
