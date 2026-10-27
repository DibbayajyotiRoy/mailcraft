//! Spam scoring integration point (rspamd `/checkv2`).
use async_trait::async_trait;
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct SpamConfig {
    /// Block when score > threshold (SpamAssassin default is 5; journeys use stricter, e.g. 3).
    pub threshold: f64,
    /// If the scorer is unreachable: true = accept, false = treat as failure (fallback copy).
    pub fail_open: bool,
}
impl Default for SpamConfig {
    fn default() -> Self {
        Self {
            threshold: 3.0,
            fail_open: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SpamVerdict {
    pub score: f64,
    pub symbols: Vec<(String, f64)>,
}

#[async_trait]
pub trait SpamChecker: Send + Sync {
    /// `rfc822` is the final rendered message bytes (headers + MIME body), as it will go on the wire.
    async fn check(&self, rfc822: &[u8]) -> Result<SpamVerdict, String>;
}

pub struct NoopSpamChecker;
#[async_trait]
impl SpamChecker for NoopSpamChecker {
    async fn check(&self, _: &[u8]) -> Result<SpamVerdict, String> {
        Ok(SpamVerdict {
            score: 0.0,
            symbols: vec![],
        })
    }
}

pub struct RspamdChecker {
    base_url: String,
    password: Option<String>,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct CheckV2 {
    score: f64,
    #[serde(default)]
    symbols: std::collections::HashMap<String, Sym>,
}
#[derive(Deserialize)]
struct Sym {
    score: f64,
}

impl RspamdChecker {
    pub fn new(
        base_url: &str,
        password: Option<String>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').into(),
            password,
            http,
        })
    }
}

#[async_trait]
impl SpamChecker for RspamdChecker {
    async fn check(&self, rfc822: &[u8]) -> Result<SpamVerdict, String> {
        let mut rb = self
            .http
            .post(format!("{}/checkv2", self.base_url))
            .body(rfc822.to_vec());
        if let Some(p) = &self.password {
            rb = rb.header("Password", p);
        }
        let resp = rb.send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("rspamd http {}", resp.status()));
        }
        let r: CheckV2 = resp.json().await.map_err(|e| e.to_string())?;
        let mut symbols: Vec<_> = r
            .symbols
            .into_iter()
            .filter(|(_, s)| s.score != 0.0)
            .map(|(k, s)| (k, s.score))
            .collect();
        symbols.sort_by(|a, b| b.1.abs().total_cmp(&a.1.abs()));
        Ok(SpamVerdict {
            score: r.score,
            symbols,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{header, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn rspamd_checkv2() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/checkv2")).and(header("Password", "pw"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "score": 4.2, "required_score": 15.0, "action": "add header",
                "symbols": {"FORGED_SENDER": {"score": 0.3}, "MIME_HTML_ONLY": {"score": 3.9}, "ZERO": {"score": 0.0}}})))
            .mount(&s).await;
        let c = RspamdChecker::new(&s.uri(), Some("pw".into()), Duration::from_secs(5)).unwrap();
        let v = c.check(b"Subject: hi\r\n\r\nbody").await.unwrap();
        assert_eq!(v.score, 4.2);
        assert_eq!(v.symbols[0].0, "MIME_HTML_ONLY");
        assert_eq!(v.symbols.len(), 2);
    }

    #[tokio::test]
    async fn rspamd_http_error_is_err() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&s)
            .await;
        let c = RspamdChecker::new(&s.uri(), None, Duration::from_secs(5)).unwrap();
        assert!(c.check(b"x").await.is_err());
    }
}
