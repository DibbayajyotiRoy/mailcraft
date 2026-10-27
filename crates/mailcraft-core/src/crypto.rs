//! Hashing, constant-time compare and AES-256-GCM secret boxes (SPEC 14: secrets at rest).
use aes_gcm::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{Error, Result};

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

/// `n` random base62 characters (rejection sampling, no modulo bias).
pub fn random_base62(n: usize) -> String {
    const A: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(n);
    let mut buf = [0u8; 64];
    while out.len() < n {
        OsRng.fill_bytes(&mut buf);
        for b in buf {
            if b < 248 && out.len() < n {
                out.push(A[(b % 62) as usize] as char);
            }
        }
    }
    out
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

/// AES-256-GCM with a random per-row nonce. Blob layout: `nonce(12) || ciphertext+tag`.
/// `aad` binds the blob to its row (e.g. the endpoint id) so blobs cannot be swapped.
#[derive(Clone)]
pub struct SecretBox(Aes256Gcm);

impl SecretBox {
    /// Accepts `MAILCRAFT_SECRET_KEY` as 64 hex chars or base64 of 32 bytes.
    pub fn from_env_value(s: &str) -> Result<Self> {
        let s = s.trim();
        let bytes = if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
            (0..32)
                .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
                .collect::<Vec<_>>()
        } else {
            STANDARD.decode(s).unwrap_or_default()
        };
        Self::from_key(&bytes)
    }
    /// Like `from_env_value`, but a non-hex / non-base64 value of 16+ chars is a passphrase
    /// (SHA-256 of it is the key).
    pub fn from_secret(s: &str) -> Result<Self> {
        Self::from_env_value(s).or_else(|e| {
            if s.trim().len() >= 16 {
                Self::from_key(&sha256(s.trim().as_bytes()))
            } else {
                Err(e)
            }
        })
    }
    pub fn from_key(key: &[u8]) -> Result<Self> {
        Aes256Gcm::new_from_slice(key).map(Self).map_err(|_| {
            Error::new(
                "invalid_secret_key",
                500,
                "MAILCRAFT_SECRET_KEY must be 32 bytes",
            )
            .hint("generate one with: openssl rand -hex 32")
        })
    }
    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ct = self
            .0
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .expect("aes-gcm encrypt cannot fail for in-memory input");
        [nonce.as_slice(), &ct].concat()
    }
    pub fn open(&self, blob: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        if blob.len() < 28 {
            return Err(Error::new("decrypt_failed", 500, "sealed blob too short"));
        }
        let (n, ct) = blob.split_at(12);
        self.0
            .decrypt(n.into(), Payload { msg: ct, aad })
            .map_err(|_| Error::new("decrypt_failed", 500, "secret could not be decrypted"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_roundtrip_and_aad_binding() {
        let b = SecretBox::from_key(&[7u8; 32]).unwrap();
        let blob = b.seal(b"hunter2", b"row-1");
        assert_eq!(b.open(&blob, b"row-1").unwrap(), b"hunter2");
        assert!(b.open(&blob, b"row-2").is_err());
        let mut bad = blob.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(b.open(&bad, b"row-1").is_err());
        assert!(SecretBox::from_env_value("short").is_err());
        assert!(SecretBox::from_env_value(&"ab".repeat(32)).is_ok());
    }

    #[test]
    fn base62_len_and_alphabet() {
        let t = random_base62(32);
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric()));
        assert!(ct_eq(&sha256(b"a"), &sha256(b"a")));
        assert!(!ct_eq(b"a", b"b"));
    }
}
