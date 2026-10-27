//! `mailcraft connect gmail`: OAuth 2.0 installed-app flow with loopback redirect + PKCE (RFC 7636 / 8252).
//! Device flow is NOT an option: Google's device flow does not allow Gmail scopes (see README).
use crate::{gmail::GmailCredentials, TransportError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

pub const GMAIL_SEND_SCOPE: &str = "https://www.googleapis.com/auth/gmail.send";
pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

impl Pkce {
    pub fn generate() -> Self {
        let verifier = random_b64(48); // 64 chars, inside the 43..=128 range
        Self {
            challenge: s256(&verifier),
            verifier,
        }
    }
}

pub fn auth_url(
    auth_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
    challenge: &str,
    state: &str,
    login_hint: Option<&str>,
) -> String {
    let mut u = reqwest::Url::parse(auth_endpoint).expect("auth endpoint");
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", scope)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            // offline + consent: make sure a refresh token is issued even on re-connect.
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        if let Some(h) = login_hint {
            q.append_pair("login_hint", h);
        }
    }
    u.to_string()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    Code(String),
    /// Authorization server error, e.g. `access_denied`.
    Denied(String),
    /// Not our callback (favicon, scanner, wrong state): keep listening.
    Ignore,
}

/// Parse the raw bytes of the first request on the loopback socket.
pub fn parse_callback(raw: &str, expected_state: &str) -> Callback {
    let target = match raw
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("GET "))
        .and_then(|l| l.split(' ').next())
    {
        Some(t) => t,
        None => return Callback::Ignore,
    };
    let url = match reqwest::Url::parse(&format!("http://127.0.0.1{target}")) {
        Ok(u) if u.path() == "/callback" => u,
        _ => return Callback::Ignore,
    };
    let get = |k: &str| {
        url.query_pairs()
            .find(|(a, _)| a == k)
            .map(|(_, v)| v.into_owned())
    };
    if get("state").as_deref() != Some(expected_state) {
        return Callback::Ignore; // CSRF guard
    }
    if let Some(e) = get("error") {
        return Callback::Denied(e);
    }
    get("code").map(Callback::Code).unwrap_or(Callback::Ignore)
}

#[derive(serde::Deserialize)]
struct TokenResp {
    refresh_token: Option<String>,
}

pub async fn exchange_code(
    http: &reqwest::Client,
    token_url: &str,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<GmailCredentials, TransportError> {
    let mut f = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    if let Some(s) = client_secret {
        f.push(("client_secret", s));
    }
    let r = http.post(token_url).form(&f).send().await?;
    if !r.status().is_success() {
        let s = r.status().as_u16();
        return Err(crate::gmail::classify_token_error(
            s,
            &r.text().await.unwrap_or_default(),
        ));
    }
    let t: TokenResp = r.json().await?;
    Ok(GmailCredentials {
        client_id: client_id.into(),
        client_secret: client_secret.map(str::to_owned),
        refresh_token: t.refresh_token.ok_or_else(|| {
            TransportError::Permanent("no refresh_token returned (revoke the app's access in your Google account and retry)".into())
        })?,
    })
}

pub struct ConnectOptions {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub login_hint: Option<String>,
    pub timeout: Duration,
    pub auth_endpoint: String,
    pub token_endpoint: String,
}

impl ConnectOptions {
    pub fn google(client_id: &str, client_secret: Option<&str>) -> Self {
        Self {
            client_id: client_id.into(),
            client_secret: client_secret.map(str::to_owned),
            login_hint: None,
            timeout: Duration::from_secs(300),
            auth_endpoint: AUTH_URL.into(),
            token_endpoint: TOKEN_URL.into(),
        }
    }
}

/// Binds 127.0.0.1:<random>, hands the consent URL to `show_url` (print it / open a browser), waits for the
/// redirect, exchanges the code, returns credentials for the caller to persist (encrypted).
pub async fn connect_gmail(
    opts: ConnectOptions,
    show_url: impl FnOnce(&str),
) -> Result<GmailCredentials, TransportError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| TransportError::Temporary(format!("bind: {e}")))?;
    let port = listener.local_addr().unwrap().port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let pkce = Pkce::generate();
    let state = random_b64(24);
    show_url(&auth_url(
        &opts.auth_endpoint,
        &opts.client_id,
        &redirect,
        GMAIL_SEND_SCOPE,
        &pkce.challenge,
        &state,
        opts.login_hint.as_deref(),
    ));

    let code = tokio::time::timeout(opts.timeout, async {
        loop {
            let Ok((mut s, _)) = listener.accept().await else { continue };
            let mut buf = vec![0u8; 8192];
            let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await.ok().and_then(Result::ok).unwrap_or(0);
            let (status, page, out) = match parse_callback(&String::from_utf8_lossy(&buf[..n]), &state) {
                Callback::Code(c) => ("200 OK", "mailcraft: Gmail connected. You can close this tab.", Some(Ok(c))),
                Callback::Denied(e) => ("200 OK", "mailcraft: access was not granted. You can close this tab.", Some(Err(e))),
                Callback::Ignore => ("404 Not Found", "not found", None),
            };
            let _ = s
                .write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len()).as_bytes())
                .await;
            if let Some(r) = out {
                return r;
            }
        }
    })
    .await
    .map_err(|_| TransportError::Temporary("timed out waiting for the browser redirect".into()))?
    .map_err(|e| TransportError::Auth(format!("authorization denied: {e}")))?;

    let http = reqwest::Client::new();
    exchange_code(
        &http,
        &opts.token_endpoint,
        &opts.client_id,
        opts.client_secret.as_deref(),
        &code,
        &pkce.verifier,
        &redirect,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{matchers::*, Mock, MockServer, ResponseTemplate};

    #[test]
    fn pkce_matches_rfc7636_vector() {
        assert_eq!(
            s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let p = Pkce::generate();
        assert!((43..=128).contains(&p.verifier.len()));
        assert_eq!(p.challenge, s256(&p.verifier));
    }

    #[test]
    fn auth_url_has_required_params() {
        let u = reqwest::Url::parse(&auth_url(
            AUTH_URL,
            "cid",
            "http://127.0.0.1:1/callback",
            GMAIL_SEND_SCOPE,
            "ch",
            "st",
            None,
        ))
        .unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["scope"], GMAIL_SEND_SCOPE);
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:1/callback");
    }

    #[test]
    fn callback_parsing() {
        let req = |q: &str| format!("GET /callback?{q} HTTP/1.1\r\nHost: x\r\n\r\n");
        assert_eq!(
            parse_callback(&req("code=4%2Fabc&state=S"), "S"),
            Callback::Code("4/abc".into())
        );
        assert_eq!(
            parse_callback(&req("code=abc&state=EVIL"), "S"),
            Callback::Ignore
        );
        assert_eq!(
            parse_callback(&req("error=access_denied&state=S"), "S"),
            Callback::Denied("access_denied".into())
        );
        assert_eq!(
            parse_callback("GET /favicon.ico HTTP/1.1\r\n\r\n", "S"),
            Callback::Ignore
        );
        assert_eq!(parse_callback("garbage", "S"), Callback::Ignore);
    }

    /// Full flow with a fake "browser" that hits the redirect, and a mock token endpoint.
    #[tokio::test]
    async fn connect_flow_end_to_end() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .and(body_string_contains("code=THECODE"))
            .and(body_string_contains("code_verifier="))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"access_token":"a","expires_in":3600,"refresh_token":"RT"}),
            ))
            .expect(1)
            .mount(&s)
            .await;

        let mut o = ConnectOptions::google("cid", Some("sec"));
        o.token_endpoint = format!("{}/token", s.uri());
        o.timeout = Duration::from_secs(10);
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let browser = tokio::spawn(async move {
            let url = reqwest::Url::parse(&rx.await.unwrap()).unwrap();
            let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            let http = reqwest::Client::new();
            // a stray request first (favicon) must not end the flow
            let _ = http
                .get(format!(
                    "{}/favicon.ico",
                    q["redirect_uri"].trim_end_matches("/callback")
                ))
                .send()
                .await;
            let r = http
                .get(format!(
                    "{}?code=THECODE&state={}",
                    q["redirect_uri"], q["state"]
                ))
                .send()
                .await
                .unwrap();
            assert!(r.text().await.unwrap().contains("Gmail connected"));
            q["code_challenge"].clone()
        });
        let creds = connect_gmail(o, |u| tx.send(u.to_string()).unwrap())
            .await
            .unwrap();
        assert_eq!(creds.refresh_token, "RT");
        let challenge = browser.await.unwrap();
        // verifier sent to the token endpoint must hash to the challenge sent in the URL
        let body = String::from_utf8(s.received_requests().await.unwrap()[0].body.clone()).unwrap();
        let v = body
            .split('&')
            .find_map(|p| p.strip_prefix("code_verifier="))
            .unwrap();
        assert_eq!(s256(v), challenge);
    }

    #[tokio::test]
    async fn denied_and_timeout() {
        let mut o = ConnectOptions::google("cid", None);
        o.timeout = Duration::from_millis(300);
        let e = connect_gmail(o, |_| {}).await.unwrap_err();
        assert_eq!(e.class(), crate::ErrorClass::Temporary);
    }
}
