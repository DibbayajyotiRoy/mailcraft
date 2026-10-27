//! API key shape, scopes and environments (SPEC 4.5).
use serde::{Deserialize, Serialize};

use crate::crypto::{random_base62, sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Read,
    Send,
    Manage,
    Admin,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Send => "send",
            Scope::Manage => "manage",
            Scope::Admin => "admin",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "read" => Scope::Read,
            "send" => Scope::Send,
            "manage" => Scope::Manage,
            "admin" => Scope::Admin,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyEnv {
    Test,
    Live,
}

impl KeyEnv {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyEnv::Test => "test",
            KeyEnv::Live => "live",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "test" => Some(KeyEnv::Test),
            "live" => Some(KeyEnv::Live),
            _ => None,
        }
    }
}

pub struct NewToken {
    pub token: String,
    /// Display prefix, e.g. `mc_test_ab12`.
    pub prefix: String,
    pub hash: [u8; 32],
}

/// `mc_<env>_<32 base62>`; only the SHA-256 is stored (the secret is high-entropy).
pub fn generate_token(env: KeyEnv) -> NewToken {
    let token = format!("mc_{}_{}", env.as_str(), random_base62(32));
    NewToken {
        prefix: token[..12].to_string(),
        hash: sha256(token.as_bytes()),
        token,
    }
}

/// Cheap shape check so garbage never reaches the database.
pub fn token_env(token: &str) -> Option<KeyEnv> {
    let (env, rest) = if let Some(r) = token.strip_prefix("mc_test_") {
        (KeyEnv::Test, r)
    } else if let Some(r) = token.strip_prefix("mc_live_") {
        (KeyEnv::Live, r)
    } else {
        return None;
    };
    (rest.len() == 32 && rest.chars().all(|c| c.is_ascii_alphanumeric())).then_some(env)
}

pub fn hash_token(token: &str) -> [u8; 32] {
    sha256(token.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape() {
        let t = generate_token(KeyEnv::Test);
        assert_eq!(token_env(&t.token), Some(KeyEnv::Test));
        assert_eq!(t.prefix.len(), 12);
        assert_eq!(hash_token(&t.token), t.hash);
        assert_eq!(token_env("mc_live_short"), None);
        assert_eq!(token_env("sk_live_x"), None);
    }
}
