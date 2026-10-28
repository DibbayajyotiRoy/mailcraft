//! `/v1/transports`: delivery paths (smtp-relay with presets, ses, gmail-oauth). Manage scope.
//!
//! `transports.config_enc` = `SecretBox::seal(json, transport_id bytes)`. Plaintext JSON per kind:
//! * `smtp-relay`: `{host, port, tls: "starttls"|"implicit"|"none", username?, password?}`
//! * `ses`: `{region, access_key_id, secret_access_key, session_token?}`
//! * `gmail-oauth`: `{client_id, client_secret?, refresh_token, email?}`
//!
//! Secrets are write-only: no response or audit row contains them.
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chrono::{DateTime, Utc};
use mailcraft_core::auth::Scope;
use mailcraft_transport::{
    oauth::{self, Pkce, GMAIL_SEND_SCOPE},
    smtp::{SmtpConfig, PRESETS},
    TlsMode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{envelope, envelope_list, err, invalid, not_found, ApiJson, ApiResult},
    state::AppState,
};

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateTransport {
    /// `smtp-relay` or `ses`. Gmail goes through `/v1/transports/gmail/oauth/*`.
    pub kind: String,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// `test` | `low-volume` | `production` (default).
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub daily_cap: Option<i32>,
    #[serde(default)]
    pub is_default: Option<bool>,
    pub config: Value,
}

fn s<'a>(c: &'a Value, k: &str) -> Option<&'a str> {
    c[k].as_str().filter(|v| !v.is_empty())
}

fn need<'a>(c: &'a Value, k: &str) -> ApiResult<&'a str> {
    s(c, k).ok_or_else(|| invalid(format!("config.{k} is required")).field(&format!("config.{k}")))
}

/// Validates and canonicalises the request into `(stored config, public detail)`.
fn build(b: &CreateTransport) -> ApiResult<(Value, Value)> {
    let c = &b.config;
    match b.kind.as_str() {
        "smtp-relay" => {
            let (host, port, tls, user) = match &b.preset {
                Some(p) => {
                    if !PRESETS.iter().any(|x| x.0 == p) {
                        return Err(invalid(format!(
                            "unknown preset `{p}` (known: {})",
                            PRESETS.iter().map(|x| x.0).collect::<Vec<_>>().join(", ")
                        ))
                        .field("preset"));
                    }
                    let user =
                        s(c, "username").unwrap_or(if p == "resend" { "resend" } else { "" });
                    if user.is_empty() {
                        return Err(invalid(format!(
                            "preset `{p}` needs config.username ({})",
                            PRESETS.iter().find(|x| x.0 == p).map_or("", |x| x.4)
                        ))
                        .field("config.username"));
                    }
                    let cfg =
                        SmtpConfig::from_preset(p, user, need(c, "password")?, s(c, "region"))
                            .ok_or_else(|| invalid("unknown preset").field("preset"))?;
                    (cfg.host, cfg.port, cfg.tls, Some(user.to_string()))
                }
                None => {
                    let tls = match s(c, "tls").unwrap_or("starttls") {
                        "starttls" => TlsMode::StartTls,
                        "implicit" => TlsMode::Implicit,
                        "none" => TlsMode::None,
                        t => {
                            return Err(invalid(format!(
                                "config.tls `{t}` is not starttls|implicit|none"
                            ))
                            .field("config.tls"))
                        }
                    };
                    let port = c["port"]
                        .as_u64()
                        .and_then(|p| u16::try_from(p).ok())
                        .filter(|p| *p > 0);
                    (
                        need(c, "host")?.to_string(),
                        port.ok_or_else(|| {
                            invalid("config.port must be 1-65535").field("config.port")
                        })?,
                        tls,
                        s(c, "username").map(String::from),
                    )
                }
            };
            // Plaintext is for local test sinks only.
            if tls == TlsMode::None && !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
                return Err(invalid("tls `none` is only allowed for localhost").field("config.tls"));
            }
            let tls_s = match tls {
                TlsMode::StartTls => "starttls",
                TlsMode::Implicit => "implicit",
                TlsMode::None => "none",
            };
            let mailbox_sender = c["mailbox_sender"].as_bool().unwrap_or(false);
            if mailbox_sender && user.is_none() {
                return Err(invalid(
                    "config.mailbox_sender needs config.username (the mailbox address)",
                )
                .field("config.mailbox_sender"));
            }
            let secret = json!({"host": host, "port": port, "tls": tls_s, "username": user, "password": s(c, "password"), "mailbox_sender": mailbox_sender});
            Ok((
                secret,
                json!({"host": host, "port": port, "tls": tls_s, "preset": b.preset, "mailbox_sender": mailbox_sender}),
            ))
        }
        "ses" => {
            let region = need(c, "region")?;
            let secret = json!({"region": region, "access_key_id": need(c, "access_key_id")?, "secret_access_key": need(c, "secret_access_key")?, "session_token": s(c, "session_token")});
            Ok((secret, json!({"region": region})))
        }
        "gmail-oauth" => {
            Err(invalid("connect Gmail with POST /v1/transports/gmail/oauth/start").field("kind"))
        }
        k => Err(invalid(format!(
            "unsupported transport kind `{k}` (smtp-relay, ses)"
        ))
        .field("kind")),
    }
}

#[derive(sqlx::FromRow, Serialize)]
struct TransportView {
    id: Uuid,
    kind: String,
    name: String,
    label: String,
    is_default: bool,
    daily_cap: Option<i32>,
    created_at: DateTime<Utc>,
}

const COLS: &str = "id, kind, name, label, is_default, daily_cap, created_at";

#[allow(clippy::too_many_arguments)] // one INSERT, one caller shape
async fn insert(
    tx: &mut sqlx::PgConnection,
    st: &AppState,
    ws: Uuid,
    kind: &str,
    name: &str,
    label: &str,
    daily_cap: Option<i32>,
    make_default: Option<bool>,
    secret: &Value,
) -> ApiResult<TransportView> {
    let id = Uuid::now_v7();
    let first: bool =
        sqlx::query_scalar("SELECT NOT EXISTS (SELECT 1 FROM transports WHERE workspace_id = $1)")
            .bind(ws)
            .fetch_one(&mut *tx)
            .await?;
    let is_default = make_default.unwrap_or(first);
    if is_default {
        sqlx::query("UPDATE transports SET is_default = false WHERE workspace_id = $1")
            .bind(ws)
            .execute(&mut *tx)
            .await?;
    }
    let enc = st
        .secrets
        .seal(secret.to_string().as_bytes(), id.as_bytes());
    Ok(sqlx::query_as(&format!(
        "INSERT INTO transports (id, workspace_id, kind, name, config_enc, is_default, label, daily_cap) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING {COLS}"
    ))
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(name)
    .bind(enc)
    .bind(is_default)
    .bind(label)
    .bind(daily_cap)
    .fetch_one(&mut *tx)
    .await?)
}

pub async fn create(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(b): ApiJson<CreateTransport>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let label = b.label.clone().unwrap_or_else(|| "production".into());
    if !["test", "low-volume", "production"].contains(&label.as_str()) {
        return Err(invalid("label must be test, low-volume or production").field("label"));
    }
    if b.daily_cap.is_some_and(|c| c < 1) {
        return Err(invalid("daily_cap must be >= 1").field("daily_cap"));
    }
    let (secret, detail) = build(&b)?;
    let mut g = begin!(st, auth, headers, "POST /v1/transports", b);
    let name = b
        .name
        .clone()
        .or_else(|| b.preset.clone())
        .unwrap_or_else(|| b.kind.clone());
    let v = insert(
        &mut g.tx,
        &st,
        auth.0.workspace_id,
        &b.kind,
        &name,
        &label,
        b.daily_cap,
        b.is_default,
        &secret,
    )
    .await?;
    audit::append(
        &mut g.tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "transport.create",
            args: json!({"transport_id": v.id, "kind": b.kind, "name": name, "detail": detail}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    let mut out = serde_json::to_value(&v).unwrap_or_default();
    out["detail"] = detail;
    out["status"] = json!("ready");
    g.finish(StatusCode::CREATED, out).await
}

pub async fn list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Manage)?;
    let rows: Vec<TransportView> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM transports WHERE workspace_id = $1 ORDER BY created_at, id"
    ))
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    Ok(envelope_list(rows, None))
}

pub async fn delete(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let mut tx = st.db.begin().await?;
    let used: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM emails WHERE transport_id = $1)")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if used {
        return Err(err(
            "transport_in_use",
            409,
            "emails were sent through this transport",
        )
        .hint_in("keep it for history, or add another transport and make it the default"));
    }
    let n = sqlx::query("DELETE FROM transports WHERE id = $1 AND workspace_id = $2")
        .bind(id)
        .bind(auth.0.workspace_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(not_found("transport"));
    }
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "transport.delete",
            args: json!({"transport_id": id}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(StatusCode::OK, json!({"id": id, "deleted": true})))
}

/// Reachability / credential check. Always 200; `ok:false` carries the reason.
pub async fn test(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Manage)?;
    let (kind, enc): (String, Vec<u8>) = sqlx::query_as(
        "SELECT kind, config_enc FROM transports WHERE id = $1 AND workspace_id = $2",
    )
    .bind(id)
    .bind(auth.0.workspace_id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("transport"))?;
    let c: Value = st
        .secrets
        .open(&enc, id.as_bytes())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| {
            err(
                "transport_config_unreadable",
                500,
                "stored config cannot be decrypted",
            )
            .hint_in("was MAILCRAFT_SECRET_KEY changed?")
        })?;
    let r: Result<String, String> = match kind.as_str() {
        "smtp-relay" => {
            tcp(
                c["host"].as_str().unwrap_or_default(),
                c["port"].as_u64().unwrap_or(0) as u16,
            )
            .await
        }
        "ses" => {
            tcp(
                &format!(
                    "email.{}.amazonaws.com",
                    c["region"].as_str().unwrap_or_default()
                ),
                443,
            )
            .await
        }
        "gmail-oauth" => refresh(&st, &c).await,
        k => Err(format!("no test for `{k}`")),
    };
    Ok(envelope(
        StatusCode::OK,
        match r {
            Ok(d) => json!({"id": id, "kind": kind, "ok": true, "detail": d}),
            Err(e) => json!({"id": id, "kind": kind, "ok": false, "detail": e}),
        },
    ))
}

async fn tcp(host: &str, port: u16) -> Result<String, String> {
    match tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    {
        Ok(Ok(_)) => Ok(format!("connected to {host}:{port}")),
        Ok(Err(e)) => Err(format!("cannot connect to {host}:{port}: {e}")),
        Err(_) => Err(format!("connecting to {host}:{port} timed out")),
    }
}

async fn refresh(st: &AppState, c: &Value) -> Result<String, String> {
    let g = st
        .config
        .google_oauth
        .as_ref()
        .ok_or("Google OAuth client is not configured on this instance")?;
    let mut f = vec![
        ("client_id", g.client_id.as_str()),
        ("grant_type", "refresh_token"),
        (
            "refresh_token",
            c["refresh_token"].as_str().unwrap_or_default(),
        ),
    ];
    if let Some(sec) = c["client_secret"].as_str() {
        f.push(("client_secret", sec));
    }
    let r = reqwest::Client::new()
        .post(&g.token_url)
        .form(&f)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if r.status().is_success() {
        Ok("refresh token accepted".into())
    } else {
        Err(format!(
            "Google rejected the refresh token ({}); reconnect with `mailcraft connect gmail`",
            r.status()
        ))
    }
}

// ------------------------------------------------------------- gmail oauth

const STATE_AAD: &[u8] = b"gmail-oauth-state";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthStart {
    pub redirect_uri: String,
    /// Shown as the transport's `from` (the gmail.send scope cannot read the profile).
    #[serde(default)]
    pub login_hint: Option<String>,
}

fn check_redirect(u: &str) -> ApiResult<()> {
    let url = reqwest::Url::parse(u)
        .map_err(|_| invalid("redirect_uri is not a URL").field("redirect_uri"))?;
    let loopback = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if loopback || url.scheme() == "https" {
        Ok(())
    } else {
        Err(invalid("redirect_uri must be an http loopback or https URL").field("redirect_uri"))
    }
}

fn google(st: &AppState) -> ApiResult<&crate::state::GoogleOauth> {
    st.config.google_oauth.as_ref().ok_or_else(|| {
        err(
            "oauth_not_configured",
            501,
            "this instance has no Google OAuth client",
        )
        .hint_in("set MAILCRAFT_GOOGLE_CLIENT_ID (and _SECRET), or use `connect relay`")
    })
}

/// Stateless: PKCE verifier, workspace and redirect travel in `state`, sealed with the instance key.
pub async fn oauth_start(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<OauthStart>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let g = google(&st)?;
    check_redirect(&b.redirect_uri)?;
    let pkce = Pkce::generate();
    let state = json!({"v": pkce.verifier, "ws": auth.0.workspace_id, "r": b.redirect_uri, "h": b.login_hint, "exp": Utc::now().timestamp() + 600});
    let state = B64.encode(st.secrets.seal(state.to_string().as_bytes(), STATE_AAD));
    let auth_url = oauth::auth_url(
        &g.auth_url,
        &g.client_id,
        &b.redirect_uri,
        GMAIL_SEND_SCOPE,
        &pkce.challenge,
        &state,
        b.login_hint.as_deref(),
    );
    Ok(envelope(
        StatusCode::OK,
        json!({"auth_url": auth_url, "state": state}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthComplete {
    pub state: String,
    pub code: String,
    pub redirect_uri: String,
}

pub async fn oauth_complete(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<OauthComplete>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let g = google(&st)?;
    let bad = || {
        err(
            "oauth_state_invalid",
            400,
            "unknown, expired or foreign OAuth state",
        )
        .hint_in("start again with POST /v1/transports/gmail/oauth/start")
    };
    let sd: Value = B64
        .decode(&b.state)
        .ok()
        .and_then(|raw| st.secrets.open(&raw, STATE_AAD).ok())
        .and_then(|p| serde_json::from_slice(&p).ok())
        .ok_or_else(bad)?;
    if sd["ws"].as_str() != Some(&auth.0.workspace_id.to_string())
        || sd["exp"].as_i64().unwrap_or(0) < Utc::now().timestamp()
        || sd["r"].as_str() != Some(&b.redirect_uri)
    {
        return Err(bad());
    }
    let creds = oauth::exchange_code(
        &reqwest::Client::new(),
        &g.token_url,
        &g.client_id,
        g.client_secret.as_deref(),
        &b.code,
        sd["v"].as_str().unwrap_or_default(),
        &b.redirect_uri,
    )
    .await
    .map_err(|e| {
        err("oauth_exchange_failed", 502, e.to_string()).hint_in(
            "authorise again; revoke the app in your Google account if no refresh token was issued",
        )
    })?;
    let email = sd["h"].as_str().map(String::from);
    let secret = json!({"client_id": creds.client_id, "client_secret": creds.client_secret, "refresh_token": creds.refresh_token, "email": email});
    let name = email.clone().unwrap_or_else(|| "gmail".into());
    let ws = auth.0.workspace_id;
    let mut tx = st.db.begin().await?;
    // Reconnecting the same account replaces its credentials in place (emails reference the row).
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM transports WHERE workspace_id = $1 AND kind = 'gmail-oauth' AND name = $2",
    )
    .bind(ws)
    .bind(&name)
    .fetch_optional(&mut *tx)
    .await?;
    let v = match existing {
        Some(id) => {
            sqlx::query("UPDATE transports SET config_enc = $2 WHERE id = $1")
                .bind(id)
                .bind(
                    st.secrets
                        .seal(secret.to_string().as_bytes(), id.as_bytes()),
                )
                .execute(&mut *tx)
                .await?;
            sqlx::query_as(&format!("SELECT {COLS} FROM transports WHERE id = $1"))
                .bind(id)
                .fetch_one(&mut *tx)
                .await?
        }
        // Gmail's ~500/day cap and personal-account terms: label it honestly.
        None => {
            insert(
                &mut tx,
                &st,
                ws,
                "gmail-oauth",
                &name,
                "low-volume",
                Some(500),
                None,
                &secret,
            )
            .await?
        }
    };
    audit::append(
        &mut tx,
        ws,
        Actor::Key(&auth.0),
        Entry {
            action: "transport.gmail_connect",
            args: json!({"transport_id": v.id, "from": email}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    let mut out = serde_json::to_value(&v).unwrap_or_default();
    out["from"] = json!(email);
    out["status"] = json!("ready");
    Ok(envelope(StatusCode::OK, out))
}
