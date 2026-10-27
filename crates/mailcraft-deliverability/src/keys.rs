//! DKIM key generation + selector naming.
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{SigningKey, pkcs8::EncodePrivateKey};
use rsa::RsaPrivateKey;
use rsa::pkcs8::{EncodePublicKey, LineEnding};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Algo {
    Rsa2048,
    Ed25519,
}

impl Algo {
    /// Value of `dkim_keys.algorithm`.
    pub fn db_str(self) -> &'static str {
        match self {
            Self::Rsa2048 => "rsa-sha256",
            Self::Ed25519 => "ed25519-sha256",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "rsa-sha256" => Some(Self::Rsa2048),
            "ed25519-sha256" => Some(Self::Ed25519),
            _ => None,
        }
    }
}

/// TXT record value for a public key (`v=DKIM1; k=..; p=..`).
pub fn txt_value(algo: Algo, public_b64: &str) -> String {
    let k = match algo {
        Algo::Rsa2048 => "rsa",
        Algo::Ed25519 => "ed25519",
    };
    format!("v=DKIM1; k={k}; p={public_b64}")
}

/// A generated DKIM key. `private_pem` is PKCS#8; store it 0600 (see bin).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DkimKey {
    pub selector: String,
    pub algo: Algo,
    pub private_pem: String,
    /// Base64 as it goes into `p=` (RSA: SPKI DER; Ed25519: raw 32 bytes per RFC 8463).
    pub public_b64: String,
}

impl DkimKey {
    pub fn generate(algo: Algo, selector: impl Into<String>) -> Result<Self, String> {
        let mut rng = rand::rngs::OsRng;
        let (private_pem, public_b64) = match algo {
            Algo::Rsa2048 => {
                let k = RsaPrivateKey::new(&mut rng, 2048).map_err(|e| e.to_string())?;
                let pem = rsa::pkcs8::EncodePrivateKey::to_pkcs8_pem(&k, LineEnding::LF)
                    .map_err(|e| e.to_string())?;
                let der = k
                    .to_public_key()
                    .to_public_key_der()
                    .map_err(|e| e.to_string())?;
                (pem.to_string(), B64.encode(der.as_bytes()))
            }
            Algo::Ed25519 => {
                let k = SigningKey::generate(&mut rng);
                let pem = k.to_pkcs8_pem(LineEnding::LF).map_err(|e| e.to_string())?;
                (pem.to_string(), B64.encode(k.verifying_key().as_bytes()))
            }
        };
        Ok(Self {
            selector: selector.into(),
            algo,
            private_pem,
            public_b64,
        })
    }

    /// Signing key for mail-auth (RSA). Errors if this is not an RSA key.
    #[allow(deprecated)] // from_pkcs8_der is the PKCS#8 entry point that avoids a rustls-pki-types dep
    pub fn rsa_signing_key(
        &self,
    ) -> Result<mail_auth::crypto::RsaKey<mail_auth::crypto::Sha256>, String> {
        use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
        if self.algo != Algo::Rsa2048 {
            return Err("not an RSA key".into());
        }
        let k = RsaPrivateKey::from_pkcs8_pem(&self.private_pem).map_err(|e| e.to_string())?;
        let der = k.to_pkcs8_der().map_err(|e| e.to_string())?;
        mail_auth::crypto::RsaKey::from_pkcs8_der(der.as_bytes()).map_err(|e| e.to_string())
    }

    /// Signing key for mail-auth (Ed25519). Errors if this is not an Ed25519 key.
    pub fn ed25519_signing_key(&self) -> Result<mail_auth::crypto::Ed25519Key, String> {
        use ed25519_dalek::pkcs8::DecodePrivateKey;
        if self.algo != Algo::Ed25519 {
            return Err("not an Ed25519 key".into());
        }
        let k = SigningKey::from_pkcs8_pem(&self.private_pem).map_err(|e| e.to_string())?;
        let der = k.to_pkcs8_der().map_err(|e| e.to_string())?;
        mail_auth::crypto::Ed25519Key::from_pkcs8_der(der.as_bytes()).map_err(|e| e.to_string())
    }

    /// TXT value for `<selector>._domainkey.<domain>`.
    pub fn txt_value(&self) -> String {
        txt_value(self.algo, &self.public_b64)
    }
}

/// `mc2026a`, `mc2026b`, ... `n` is the 0-based rotation index within the year.
pub fn selector(year: u32, n: u8) -> String {
    format!("mc{year}{}", (b'a' + n.min(25)) as char)
}

/// Next selector after `prev` (never reuses a name): same year -> next letter, new year -> `a`.
pub fn next_selector(prev: Option<&str>, year: u32) -> String {
    let n = prev
        .and_then(|p| p.strip_prefix(&format!("mc{year}")))
        .and_then(|l| l.bytes().next())
        .map_or(0, |c| c - b'a' + 1);
    selector(year, n)
}

/// Calendar year of a unix timestamp (civil-from-days, no chrono).
pub fn year_of(secs: u64) -> u32 {
    let z = (secs / 86400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_rotate_without_reuse() {
        assert_eq!(selector(2026, 0), "mc2026a");
        assert_eq!(next_selector(None, 2026), "mc2026a");
        assert_eq!(next_selector(Some("mc2026a"), 2026), "mc2026b");
        assert_eq!(next_selector(Some("mc2026b"), 2027), "mc2027a");
    }

    #[test]
    fn years() {
        assert_eq!(year_of(0), 1970);
        assert_eq!(year_of(1798761599), 2026); // 2026-12-31T23:59:59Z
        assert_eq!(year_of(1798761600), 2027);
    }

    #[test]
    fn ed25519_key_is_rfc8463_shaped() {
        let k = DkimKey::generate(Algo::Ed25519, "mc2026a").unwrap();
        assert_eq!(k.public_b64.len(), 44);
        assert!(k.private_pem.starts_with("-----BEGIN PRIVATE KEY-----"));
        assert!(k.txt_value().starts_with("v=DKIM1; k=ed25519; p="));
    }

    /// Minimal independent DER walker: SubjectPublicKeyInfo ::= SEQUENCE { SEQUENCE { OID rsaEncryption, NULL },
    /// BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }. Returns (n, e) without using any crypto crate.
    fn spki_rsa_parts(der: &[u8]) -> (Vec<u8>, Vec<u8>) {
        fn tlv(b: &[u8]) -> (u8, &[u8], &[u8]) {
            let (t, l) = (b[0], b[1] as usize);
            let (len, off) = if l < 0x80 {
                (l, 2)
            } else {
                let n = l & 0x7f;
                (
                    b[2..2 + n]
                        .iter()
                        .fold(0usize, |a, x| (a << 8) | *x as usize),
                    2 + n,
                )
            };
            (t, &b[off..off + len], &b[off + len..])
        }
        let (t, spki, rest) = tlv(der);
        assert!(
            t == 0x30 && rest.is_empty(),
            "outer SEQUENCE spans the whole input"
        );
        let (t, alg, rest) = tlv(spki);
        assert_eq!(t, 0x30);
        // OID 1.2.840.113549.1.1.1 + NULL
        assert_eq!(
            alg,
            [
                0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
            ]
        );
        let (t, bits, rest) = tlv(rest);
        assert!(t == 0x03 && rest.is_empty());
        assert_eq!(bits[0], 0, "no unused bits");
        let (t, rsa_pk, _) = tlv(&bits[1..]);
        assert_eq!(t, 0x30);
        let (t, n, rest) = tlv(rsa_pk);
        assert_eq!(t, 0x02);
        let (t, e, _) = tlv(rest);
        assert_eq!(t, 0x02);
        (n.to_vec(), e.to_vec())
    }

    #[test]
    fn rsa_public_key_is_standard_spki_der_base64() {
        use rsa::traits::PublicKeyParts;
        let k = DkimKey::generate(Algo::Rsa2048, "mc2026a").unwrap();
        assert!(!k.public_b64.contains(['\n', ' ', '-']) && !k.public_b64.contains("PUBLIC KEY"));
        let der = B64.decode(&k.public_b64).unwrap();
        let (n, e) = spki_rsa_parts(&der);
        assert_eq!(e, [0x01, 0x00, 0x01], "e = 65537");
        // n is a 2048-bit unsigned INTEGER: leading 0x00 pad + 256 bytes
        assert_eq!((n[0], n.len()), (0, 257));
        // the modulus matches the private key we will sign with
        let sk = RsaPrivateKey::from_pkcs8_pem_for_test(&k.private_pem);
        assert_eq!(&n[1..], sk.n().to_bytes_be().as_slice());
        // and the signing-key loader accepts the same PEM
        k.rsa_signing_key().unwrap();
        assert!(
            DkimKey::generate(Algo::Ed25519, "x")
                .unwrap()
                .rsa_signing_key()
                .is_err()
        );
    }

    trait FromPem {
        fn from_pkcs8_pem_for_test(pem: &str) -> RsaPrivateKey;
    }
    impl FromPem for RsaPrivateKey {
        fn from_pkcs8_pem_for_test(pem: &str) -> RsaPrivateKey {
            rsa::pkcs8::DecodePrivateKey::from_pkcs8_pem(pem).unwrap()
        }
    }

    #[test]
    fn rsa_key_roundtrips() {
        use rsa::pkcs8::DecodePrivateKey;
        let k = DkimKey::generate(Algo::Rsa2048, "mc2026a").unwrap();
        let sk = RsaPrivateKey::from_pkcs8_pem(&k.private_pem).unwrap();
        assert_eq!(rsa::traits::PublicKeyParts::size(&sk), 256);
        let der = B64.decode(&k.public_b64).unwrap();
        assert!(der.len() > 290); // SPKI of 2048-bit key is 294 bytes
    }
}
