//! Storage traits for domains, DKIM keys and the DNS plan, plus the loader that turns them into a
//! signing-ready [`TenantConfig`]. Postgres impls in [`postgres`], in-memory impls in [`memory`].
//! Private keys are sealed with AES-256-GCM (`MAILCRAFT_SECRET_KEY`, see [`crate::crypto`]) before
//! they reach the database and never come back out of a `KeyMeta`.
pub mod memory;
pub mod postgres;

use crate::{
    dns::{plan::Plan, verify::Check},
    finalize::TenantConfig,
    keys::{Algo, DkimKey},
    token::Verp,
};
use async_trait::async_trait;
use mailcraft_core::{Error, Result, Stream};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainStatus {
    NotStarted,
    Pending,
    Verified,
    Failed,
}

impl DomainStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotStarted => "not_started",
            Self::Pending => "pending",
            Self::Verified => "verified",
            Self::Failed => "failed",
        }
    }
    pub fn from_db(s: &str) -> Self {
        match s {
            "pending" => Self::Pending,
            "verified" => Self::Verified,
            "failed" => Self::Failed,
            _ => Self::NotStarted,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    /// Sending (From) domain, e.g. `mail.example.com`.
    pub name: String,
    pub stream: Stream,
    pub status: DomainStatus,
    /// VERP envelope domain, e.g. `bounces.mail.example.com`.
    pub return_path_host: String,
    pub dns_provider: Option<String>,
    pub verified_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyState {
    Standby,
    Active,
    Retired,
}

impl KeyState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standby => "standby",
            Self::Active => "active",
            Self::Retired => "retired",
        }
    }
    pub fn from_db(s: &str) -> Self {
        match s {
            "active" => Self::Active,
            "retired" => Self::Retired,
            _ => Self::Standby,
        }
    }
}

/// A key without its private half: safe to return from the API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyMeta {
    pub selector: String,
    pub algo: Algo,
    pub public_b64: String,
    pub state: KeyState,
    pub created_at: i64,
    pub retired_at: Option<i64>,
}

pub(crate) fn err_not_found(what: &'static str, code: &'static str) -> Error {
    Error::new(code, 404, format!("{what} not found"))
}

#[async_trait]
pub trait DomainStore: Send + Sync {
    /// Insert the domain (name = `plan.sending_domain`, return path = `plan.bounce_domain`) together
    /// with its plan and the plan's records (status `not_started`). 409 `domain_exists` if taken.
    async fn create(
        &self,
        id: Uuid,
        workspace_id: Uuid,
        stream: Stream,
        plan: &Plan,
    ) -> Result<DomainRow>;
    async fn get(&self, id: Uuid) -> Result<Option<DomainRow>>;
    async fn find_by_name(&self, workspace_id: Uuid, name: &str) -> Result<Option<DomainRow>>;
    async fn list(&self, workspace_id: Uuid) -> Result<Vec<DomainRow>>;
    async fn load_plan(&self, id: Uuid) -> Result<Option<Plan>>;
    /// Replace the stored plan and its record rows (statuses reset to `not_started`).
    async fn save_plan(&self, id: Uuid, plan: &Plan) -> Result<()>;
    /// Persist verifier results onto the record rows and recompute the domain status
    /// (`verified` when DKIM + return-path MX + SPF are all ok; `failed` when any is wrong/missing
    /// after the propagation window; otherwise `pending`). Returns the new status.
    async fn save_checks(&self, id: Uuid, checks: &[Check], now_unix: i64) -> Result<DomainStatus>;
    async fn set_dns_provider(&self, id: Uuid, provider: Option<&str>) -> Result<()>;
    async fn delete(&self, id: Uuid) -> Result<bool>;
}

#[async_trait]
pub trait KeyStore: Send + Sync {
    /// Seal and store a key. The row is bound to `(domain_id, selector)` as AEAD associated data.
    async fn insert(
        &self,
        domain_id: Uuid,
        key: &DkimKey,
        state: KeyState,
        now_unix: i64,
    ) -> Result<()>;
    /// All keys for a domain, newest first, public data only.
    async fn list(&self, domain_id: Uuid) -> Result<Vec<KeyMeta>>;
    /// Decrypted keys in the given state (signing uses `Active`).
    async fn load(&self, domain_id: Uuid, state: KeyState) -> Result<Vec<DkimKey>>;
    /// Make `selector` active and retire the previously active key of the same algorithm, atomically.
    async fn activate(&self, domain_id: Uuid, selector: &str, now_unix: i64) -> Result<()>;
    /// Delete retired keys retired before `before_unix`; returns their selectors.
    async fn purge_retired(&self, domain_id: Uuid, before_unix: i64) -> Result<Vec<String>>;
    /// For the instance's DNS responder: the public key behind `<selector>._domainkey.<sending_domain>`
    /// in any non-purged state (retired keys keep resolving while receivers still verify old mail).
    async fn public_txt(&self, sending_domain: &str, selector: &str) -> Result<Option<String>>;
}

/// Instance-wide finalizer settings (from server config, not per domain).
#[derive(Debug, Clone)]
pub struct FinalizerSettings {
    pub verp_secret: Vec<u8>,
    pub unsub_secret: Vec<u8>,
    /// Public base of the unsubscribe endpoint: `MAILCRAFT_PUBLIC_URL`, e.g. `https://mail.example.com`.
    pub unsub_base_url: String,
    /// Optional mailbox for mailto unsubscribe, e.g. `unsub@mx.example.com`; see [`crate::unsubscribe::parse_mailto_rcpt`].
    pub unsub_mailto: Option<String>,
    pub unsub_ttl_secs: u64,
    /// Google Feedback-ID sender id, 5-15 chars.
    pub feedback_sender_id: String,
    pub transactional_unsubscribe: bool,
}

/// Builds the [`TenantConfig`] the [`crate::finalize::Finalizer`] needs. Refuses unverified domains
/// (`domain_not_verified`, SPEC section 12 gate 1). Cache the result per domain for a minute or so;
/// building it parses the private keys.
pub struct TenantConfigLoader<'a> {
    pub domains: &'a dyn DomainStore,
    pub keys: &'a dyn KeyStore,
    pub settings: &'a FinalizerSettings,
}

impl TenantConfigLoader<'_> {
    pub async fn load(&self, domain_id: Uuid) -> Result<(TenantConfig, DomainRow)> {
        let d = self
            .domains
            .get(domain_id)
            .await?
            .ok_or_else(|| err_not_found("domain", "domain_not_found"))?;
        if d.status != DomainStatus::Verified {
            return Err(Error::new(
                "domain_not_verified",
                422,
                format!("Cannot send from {}: DNS is not verified (status {}).", d.name, d.status.as_str()),
            )
            .hint(format!("publish the records from `mailcraft domain show {}` then `mailcraft domain verify`", d.name)));
        }
        let keys = self.keys.load(domain_id, KeyState::Active).await?;
        let (mut rsa, mut ed) = (None, None);
        for k in &keys {
            let bad =
                |e: String| Error::new("dkim_key_unusable", 500, format!("{}: {e}", k.selector));
            match k.algo {
                Algo::Rsa2048 => {
                    rsa = Some(TenantConfig::rsa_signer(
                        k.rsa_signing_key().map_err(bad)?,
                        &d.name,
                        &k.selector,
                    ))
                }
                Algo::Ed25519 => {
                    ed = Some(TenantConfig::ed25519_signer(
                        k.ed25519_signing_key().map_err(bad)?,
                        &d.name,
                        &k.selector,
                    ))
                }
            }
        }
        if rsa.is_none() && ed.is_none() {
            return Err(Error::new(
                "dkim_key_missing",
                422,
                format!("{} has no active DKIM key", d.name),
            )
            .hint("run `mailcraft domain rotate-dkim` to create and activate one"));
        }
        let s = self.settings;
        let cfg = TenantConfig {
            tenant_id: d.workspace_id.simple().to_string(),
            sending_domain: d.name.clone(),
            verp: Verp::new(s.verp_secret.clone(), d.return_path_host.clone()),
            unsub_base_url: s.unsub_base_url.clone(),
            unsub_mailto: s.unsub_mailto.clone(),
            unsub_secret: s.unsub_secret.clone(),
            unsub_ttl_secs: s.unsub_ttl_secs,
            feedback_sender_id: s.feedback_sender_id.clone(),
            transactional_unsubscribe: s.transactional_unsubscribe,
            dkim_rsa: rsa,
            dkim_ed25519: ed,
        };
        Ok((cfg, d))
    }
}

/// Which record purposes a domain needs before it may send (DMARC and MTA-STS are advisory).
pub(crate) fn required(p: crate::dns::plan::Purpose) -> bool {
    use crate::dns::plan::Purpose::*;
    matches!(p, DkimCname | DkimTxt | ReturnPathMx | ReturnPathSpf)
}

/// Status rule shared by the Postgres and memory stores.
pub(crate) fn domain_status(checks: &[Check]) -> DomainStatus {
    use crate::dns::verify::Status;
    let req: Vec<&Check> = checks.iter().filter(|c| required(c.purpose)).collect();
    if !req.is_empty() && req.iter().all(|c| c.status == Status::Ok) {
        DomainStatus::Verified
    } else if req
        .iter()
        .any(|c| matches!(c.status, Status::Missing | Status::Wrong))
    {
        DomainStatus::Failed
    } else {
        DomainStatus::Pending
    }
}
