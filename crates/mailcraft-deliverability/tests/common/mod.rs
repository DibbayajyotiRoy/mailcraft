#![allow(dead_code)]
use mailcraft_deliverability::token::Verp;

pub const MSG_ID: &str = "0123456789abcdef01234567";

pub fn verp() -> Verp {
    Verp::new(b"verp-test-secret".to_vec(), "bounces.mail.example.test")
}

/// Load a fixture, substituting the VERP return-path and message id placeholders.
pub fn fixture(name: &str) -> Vec<u8> {
    let p = format!("{}/tests/fixtures/{name}.eml", env!("CARGO_MANIFEST_DIR"));
    let s = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"));
    s.replace("{{VERP}}", &verp().return_path(MSG_ID))
        .replace("{{MSGID}}", MSG_ID)
        .into_bytes()
}
