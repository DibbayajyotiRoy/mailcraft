use crate::{error::retry_after, ClassifiedTransport, Outbound, SendReceipt, TransportError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Debug, Clone)]
pub struct GmailCredentials {
    pub client_id: String,
    /// Desktop clients still get a secret from Google, but it is not confidential; PKCE is what protects the flow.
    pub client_secret: Option<String>,
    pub refresh_token: String,
}

/// Rolling-window send counter, persisted by the host so a restart does not reset Gmail's daily cap.
/// The engine implements this over Postgres (`emails.sent_at`); `MemoryCapStore` is for tests.
#[async_trait::async_trait]
pub trait CapStore: Send + Sync {
    /// Messages sent within the last `window`, and the age of the oldest of them.
    async fn usage(&self, window: Duration) -> (usize, Option<Duration>);
    /// Called after an accepted send. Stores that derive usage from sent rows may no-op.
    async fn record(&self);
}

#[derive(Default)]
pub struct MemoryCapStore(Mutex<VecDeque<Instant>>);

#[async_trait::async_trait]
impl CapStore for MemoryCapStore {
    async fn usage(&self, window: Duration) -> (usize, Option<Duration>) {
        let mut q = self.0.lock().unwrap();
        while q.front().is_some_and(|t| t.elapsed() >= window) {
            q.pop_front();
        }
        (q.len(), q.front().map(Instant::elapsed))
    }
    async fn record(&self) {
        self.0.lock().unwrap().push_back(Instant::now());
    }
}

const CAP_WINDOW: Duration = Duration::from_secs(24 * 3600);

struct Token {
    access: String,
    expires: Instant,
}

pub struct GmailOAuth {
    http: reqwest::Client,
    creds: GmailCredentials,
    token_url: String,
    api_base: String,
    token: tokio::sync::Mutex<Option<Token>>,
    cap_limit: usize,
    cap: Arc<dyn CapStore>,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    expires_in: u64,
}

impl GmailOAuth {
    /// `cap_limit`: 500 for free @gmail.com, 2000 for Workspace (rolling 24h).
    pub fn new(creds: GmailCredentials, cap_limit: usize, cap: Arc<dyn CapStore>) -> Self {
        Self::with_endpoints(
            creds,
            cap_limit,
            cap,
            "https://oauth2.googleapis.com/token",
            "https://gmail.googleapis.com",
        )
    }
    pub fn with_endpoints(
        creds: GmailCredentials,
        cap_limit: usize,
        cap: Arc<dyn CapStore>,
        token_url: &str,
        api_base: &str,
    ) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            creds,
            token_url: token_url.into(),
            api_base: api_base.trim_end_matches('/').into(),
            token: Default::default(),
            cap_limit,
            cap,
        }
    }
    pub async fn used(&self) -> usize {
        self.cap.usage(CAP_WINDOW).await.0
    }

    async fn access_token(&self, force: bool) -> Result<String, TransportError> {
        let mut g = self.token.lock().await;
        if !force {
            if let Some(t) = g
                .as_ref()
                .filter(|t| t.expires > Instant::now() + Duration::from_secs(60))
            {
                return Ok(t.access.clone());
            }
        }
        let mut form = vec![
            ("client_id", self.creds.client_id.as_str()),
            ("refresh_token", self.creds.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ];
        if let Some(s) = &self.creds.client_secret {
            form.push(("client_secret", s));
        }
        let r = self.http.post(&self.token_url).form(&form).send().await?;
        let status = r.status();
        if !status.is_success() {
            let body = r.text().await.unwrap_or_default();
            return Err(classify_token_error(status.as_u16(), &body));
        }
        let t: TokenResp = r.json().await?;
        *g = Some(Token {
            access: t.access_token.clone(),
            expires: Instant::now() + Duration::from_secs(t.expires_in),
        });
        Ok(t.access_token)
    }
}

/// Token endpoint errors: 400/401 `invalid_grant` (revoked, or Testing-mode 7-day expiry) and
/// `invalid_client` need an operator to re-run `mailcraft connect gmail`; 5xx is transient.
pub fn classify_token_error(status: u16, body: &str) -> TransportError {
    let msg = format!("token endpoint {status}: {body}");
    match status {
        400 | 401 => TransportError::Auth(msg),
        429 => TransportError::RateLimited {
            msg,
            retry_after: None,
        },
        _ => TransportError::Temporary(msg),
    }
}

/// Gmail API send errors. Body is `{"error":{"code":..,"message":..,"errors":[{"reason":..}],"status":..}}`.
pub fn classify_send_error(status: u16, retry: Option<Duration>, body: &str) -> TransportError {
    let msg = format!("gmail {status}: {body}");
    let reason = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["errors"][0]["reason"]
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let limited = matches!(
        reason.as_str(),
        "rateLimitExceeded" | "userRateLimitExceeded" | "dailyLimitExceeded" | "quotaExceeded"
    ) || body.contains("RESOURCE_EXHAUSTED")
        || body.contains("User-rate limit");
    match status {
        429 => TransportError::RateLimited {
            msg,
            retry_after: retry,
        },
        403 if limited => TransportError::RateLimited {
            msg,
            retry_after: retry,
        },
        401 | 403 => TransportError::Auth(msg),
        500..=599 => TransportError::Temporary(msg),
        _ => TransportError::Permanent(msg),
    }
}

crate::impl_transport!(GmailOAuth, "gmail-oauth");

#[async_trait::async_trait]
impl ClassifiedTransport for GmailOAuth {
    async fn submit_all(
        &self,
        msg: &Outbound,
        _rcpts: &[String],
    ) -> Result<SendReceipt, TransportError> {
        let (used, oldest) = self.cap.usage(CAP_WINDOW).await;
        if used >= self.cap_limit {
            return Err(TransportError::RateLimited {
                msg: format!("local daily cap of {} messages reached", self.cap_limit),
                retry_after: Some(CAP_WINDOW.saturating_sub(oldest.unwrap_or_default())),
            });
        }
        // Gmail reads recipients from the headers (the engine puts `rcpt_to` in To) and picks its own envelope.
        let body = serde_json::json!({ "raw": URL_SAFE_NO_PAD.encode(&msg.raw) });
        let url = format!("{}/gmail/v1/users/me/messages/send", self.api_base);

        let mut force = false;
        for attempt in 0..2 {
            let tok = self.access_token(force).await?;
            let r = self
                .http
                .post(&url)
                .bearer_auth(tok)
                .json(&body)
                .send()
                .await?;
            let status = r.status().as_u16();
            if status == 401 && attempt == 0 {
                force = true; // access token revoked/expired early: refresh once
                continue;
            }
            if r.status().is_success() {
                #[derive(Deserialize)]
                struct Sent {
                    id: String,
                }
                let s: Sent = r.json().await?;
                self.cap.record().await;
                return Ok(SendReceipt {
                    provider_message_id: Some(s.id),
                });
            }
            let ra = retry_after(r.headers());
            let text = r.text().await.unwrap_or_default();
            return Err(classify_send_error(status, ra, &text));
        }
        unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{sample, ErrorClass::*};
    use wiremock::{matchers::*, Mock, MockServer, ResponseTemplate};

    fn gm(s: &MockServer, cap: usize) -> GmailOAuth {
        GmailOAuth::with_endpoints(
            GmailCredentials {
                client_id: "cid".into(),
                client_secret: Some("sec".into()),
                refresh_token: "rt".into(),
            },
            cap,
            Arc::new(MemoryCapStore::default()),
            &format!("{}/token", s.uri()),
            &s.uri(),
        )
    }
    async fn token_ok(s: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .and(body_string_contains("refresh_token=rt"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"access_token":"AT","expires_in":3599})),
            )
            .mount(s)
            .await;
    }

    #[tokio::test]
    async fn sends_base64url_raw_with_bearer_and_caches_token() {
        let s = MockServer::start().await;
        token_ok(&s).await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/send"))
            .and(header("authorization", "Bearer AT"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({"id":"g123","threadId":"t","labelIds":["SENT"]}),
                ),
            )
            .expect(2)
            .mount(&s)
            .await;
        let t = gm(&s, 10);
        let rc = t.submit(&sample()).await.unwrap();
        assert_eq!(rc.provider_message_id.as_deref(), Some("g123"));
        t.submit(&sample()).await.unwrap();
        assert_eq!(t.used().await, 2);

        let reqs = s.received_requests().await.unwrap();
        assert_eq!(
            reqs.iter().filter(|r| r.url.path() == "/token").count(),
            1,
            "token must be cached"
        );
        let send = reqs
            .iter()
            .find(|r| r.url.path().ends_with("/send"))
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&send.body).unwrap();
        let raw =
            String::from_utf8(URL_SAFE_NO_PAD.decode(v["raw"].as_str().unwrap()).unwrap()).unwrap();
        assert!(raw.contains("Subject: Hello") && raw.contains("Message-ID: <m1@example.com>"));
        assert!(raw.contains("List-Unsubscribe-Post"));
    }

    #[tokio::test]
    async fn local_cap_blocks_without_http() {
        let s = MockServer::start().await;
        token_ok(&s).await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/send"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id":"x"})))
            .expect(1)
            .mount(&s)
            .await;
        let t = gm(&s, 1);
        t.submit(&sample()).await.unwrap();
        let e = t.submit(&sample()).await.unwrap_err();
        assert_eq!(e.class(), RateLimited);
        assert!(e.retry_after().unwrap() > Duration::from_secs(23 * 3600));
    }

    /// A store that already holds usage (as after a restart with a Postgres-backed store) blocks sends.
    #[tokio::test]
    async fn cap_comes_from_the_injected_store() {
        struct Full;
        #[async_trait::async_trait]
        impl CapStore for Full {
            async fn usage(&self, _: Duration) -> (usize, Option<Duration>) {
                (500, Some(Duration::from_secs(3600)))
            }
            async fn record(&self) {}
        }
        let s = MockServer::start().await;
        let t = GmailOAuth::with_endpoints(
            GmailCredentials {
                client_id: "c".into(),
                client_secret: None,
                refresh_token: "r".into(),
            },
            500,
            Arc::new(Full),
            &format!("{}/token", s.uri()),
            &s.uri(),
        );
        let e = t.submit(&sample()).await.unwrap_err();
        assert_eq!(e.class(), RateLimited);
        assert_eq!(e.retry_after(), Some(Duration::from_secs(23 * 3600)));
        assert!(s.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_grant_is_auth() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({"error":"invalid_grant","error_description":"Token has been expired or revoked."})))
            .mount(&s).await;
        assert_eq!(gm(&s, 5).submit(&sample()).await.unwrap_err().class(), Auth);
    }

    #[tokio::test]
    async fn expired_access_token_refreshes_once_then_succeeds() {
        let s = MockServer::start().await;
        token_ok(&s).await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/send"))
            .respond_with(ResponseTemplate::new(401))
            .up_to_n_times(1)
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/send"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id":"ok"})))
            .mount(&s)
            .await;
        let rc = gm(&s, 5).submit(&sample()).await.unwrap();
        assert_eq!(rc.provider_message_id.as_deref(), Some("ok"));
    }

    #[test]
    fn send_error_mapping() {
        let rl = r#"{"error":{"code":403,"errors":[{"reason":"userRateLimitExceeded"}]}}"#;
        let bad = r#"{"error":{"code":400,"errors":[{"reason":"invalidArgument"}],"message":"Invalid To header"}}"#;
        let forbid = r#"{"error":{"code":403,"errors":[{"reason":"insufficientPermissions"}]}}"#;
        assert_eq!(classify_send_error(403, None, rl).class(), RateLimited);
        assert_eq!(
            classify_send_error(429, Some(Duration::from_secs(7)), "").retry_after(),
            Some(Duration::from_secs(7))
        );
        assert_eq!(classify_send_error(403, None, forbid).class(), Auth);
        assert_eq!(classify_send_error(401, None, "").class(), Auth);
        assert_eq!(classify_send_error(400, None, bad).class(), Permanent);
        assert_eq!(classify_send_error(503, None, "").class(), Temporary);
        assert_eq!(classify_token_error(500, "").class(), Temporary);
    }
}
