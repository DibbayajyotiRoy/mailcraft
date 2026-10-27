//! Outbound finalizer: take the engine's rendered, unsigned RFC 5322 message plus tenant config,
//! add the deliverability headers and the VERP return-path, and DKIM-sign (relaxed/relaxed;
//! Ed25519 and/or RSA, From oversigned).
//!
//! The engine (WP2) calls [`Finalizer::finalize`] right before SMTP submit and uses
//! [`Finalizer::return_path`] as MAIL FROM. Both derive from `Job::email_id`, so the VERP token,
//! the Message-ID and `emails.message_id` agree and bounces map straight back to the email row.
use crate::token::Verp;
use crate::unsubscribe::{self, Category, UnsubToken};
use mail_auth::{
    crypto::{Ed25519Key, RsaKey, Sha256},
    dkim::DkimSigner,
    headers::HeaderWriter,
    signer::Ready,
};
pub use mailcraft_core::Stream;

/// Headers covered by `h=`. Listed-but-absent headers are signed as empty, so nobody can add a
/// List-Unsubscribe to a transactional message in transit without breaking the signature.
/// `From` is listed twice: oversigning, so a second From header added in transit fails verification.
pub const SIGNED_HEADERS: [&str; 10] = [
    "From",
    "From",
    "To",
    "Subject",
    "Date",
    "Message-ID",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "List-Id",
    "Feedback-ID",
];

/// Headers the finalizer owns: any copy already on the message is dropped, so a template or an API
/// caller cannot smuggle in their own Message-ID, unsubscribe link or a stale signature.
const MANAGED: [&str; 10] = [
    "message-id",
    "date",
    "feedback-id",
    "x-mail-stream",
    "list-unsubscribe",
    "list-unsubscribe-post",
    "list-id",
    "dkim-signature",
    "return-path",
    "x-mailcraft-stream",
];

pub type RsaSigner = DkimSigner<RsaKey<Sha256>, Ready>;
pub type Ed25519Signer = DkimSigner<Ed25519Key, Ready>;

pub struct TenantConfig {
    pub tenant_id: String,
    /// From-address domain; also the DKIM `d=` (aligned) and the Message-ID domain.
    pub sending_domain: String,
    /// VERP codec for `bounces.<sending_domain>`.
    pub verp: Verp,
    /// Public base for the unsubscribe endpoint, e.g. `https://mail.example.com` -> `/u/{token}`.
    pub unsub_base_url: String,
    /// Optional mailto target, e.g. `unsub@mail.example.com` -> `unsub+{token}@mail.example.com`.
    pub unsub_mailto: Option<String>,
    pub unsub_secret: Vec<u8>,
    pub unsub_ttl_secs: u64,
    /// Google Feedback-ID sender id: 5 to 15 chars, last slot.
    pub feedback_sender_id: String,
    /// Transactional messages get List-Unsubscribe only when this is on AND the job's category is unsubscribable.
    pub transactional_unsubscribe: bool,
    pub dkim_rsa: Option<RsaSigner>,
    pub dkim_ed25519: Option<Ed25519Signer>,
}

impl TenantConfig {
    pub fn rsa_signer(key: RsaKey<Sha256>, domain: &str, selector: &str) -> RsaSigner {
        DkimSigner::from_key(key)
            .domain(domain)
            .selector(selector)
            .headers(SIGNED_HEADERS)
    }
    pub fn ed25519_signer(key: Ed25519Key, domain: &str, selector: &str) -> Ed25519Signer {
        DkimSigner::from_key(key)
            .domain(domain)
            .selector(selector)
            .headers(SIGNED_HEADERS)
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    /// `emails.id`; its simple-hex form is the message id used in Message-ID and the VERP token.
    pub email_id: uuid::Uuid,
    pub stream: Stream,
    pub category: Category,
    /// Opaque contact id carried in the unsubscribe token (no `|`; keep short for the mailto).
    pub contact_id: String,
    pub campaign_id: String,
    /// Unix seconds.
    pub now: u64,
}

impl Job {
    pub fn msg_id(&self) -> String {
        self.email_id.simple().to_string()
    }
}

#[derive(Debug)]
pub struct Finalized {
    /// Complete RFC 5322 message including DKIM-Signature headers, CRLF line endings.
    pub raw: Vec<u8>,
    pub msg_id: String,
    pub message_id: String,
    /// SMTP envelope sender (MAIL FROM).
    pub return_path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum FinalizeError {
    #[error("message has no parseable From address")]
    NoFrom,
    #[error("From domain must equal the tenant sending domain (DMARC alignment)")]
    Unaligned,
    #[error("marketing stream requires an unsubscribable category")]
    MarketingNeedsCategory,
    #[error("no DKIM key configured")]
    NoDkimKey,
    #[error("feedback sender id must be 5-15 chars")]
    BadSenderId,
    #[error("message has no header/body separator")]
    Malformed,
    #[error("token: {0}")]
    Token(#[from] unsubscribe::TokenError),
    #[error("dkim: {0}")]
    Dkim(#[from] mail_auth::Error),
}

impl From<FinalizeError> for mailcraft_core::Error {
    fn from(e: FinalizeError) -> Self {
        use mailcraft_core::Error;
        match &e {
            FinalizeError::NoDkimKey => Error::new("domain_not_verified", 422, e.to_string())
                .hint("run `mailcraft domain verify` so a DKIM key is active for this domain"),
            FinalizeError::Unaligned | FinalizeError::NoFrom => {
                Error::new("invalid_from", 422, e.to_string()).field("from")
            }
            FinalizeError::MarketingNeedsCategory => {
                Error::new("missing_category", 422, e.to_string()).field("category")
            }
            _ => Error::new("finalize_failed", 500, e.to_string()),
        }
    }
}

/// What the send engine calls just before submitting to a transport.
/// `msg` is the unsigned RFC 5322 message from the engine's MIME builder; the result is the signed
/// message to submit. `tenant` comes from [`crate::store::TenantConfigLoader`] (cache it per domain).
pub trait Finalizer: Send + Sync {
    fn finalize(
        &self,
        msg: &[u8],
        tenant: &TenantConfig,
        job: &Job,
    ) -> mailcraft_core::Result<Vec<u8>>;

    /// SMTP MAIL FROM for this job (VERP). Deterministic in `job.email_id`.
    fn return_path(&self, tenant: &TenantConfig, job: &Job) -> String {
        tenant.verp.return_path(&job.msg_id())
    }
}

#[derive(Default, Clone, Copy)]
pub struct DefaultFinalizer;

impl Finalizer for DefaultFinalizer {
    fn finalize(
        &self,
        msg: &[u8],
        tenant: &TenantConfig,
        job: &Job,
    ) -> mailcraft_core::Result<Vec<u8>> {
        Ok(finalize(msg, tenant, job)?.raw)
    }
}

fn slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Header-injection guard for values that originate outside the finalizer.
fn clean(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '\r' | '\n')).collect()
}

/// Split into (header lines unfolded-as-blocks, body). Normalises bare LF to CRLF.
fn split(msg: &[u8]) -> Result<(Vec<String>, Vec<u8>), FinalizeError> {
    let text = String::from_utf8_lossy(msg);
    let text = if text.contains("\r\n") {
        text.into_owned()
    } else {
        text.replace('\n', "\r\n")
    };
    let (head, body) = match text.split_once("\r\n\r\n") {
        Some(x) => x,
        None => (text.trim_end_matches("\r\n"), ""),
    };
    if head.is_empty() {
        return Err(FinalizeError::Malformed);
    }
    let mut blocks: Vec<String> = Vec::new();
    for line in head.split("\r\n") {
        if line.starts_with([' ', '\t']) {
            match blocks.last_mut() {
                Some(b) => {
                    b.push_str("\r\n");
                    b.push_str(line);
                }
                None => return Err(FinalizeError::Malformed),
            }
        } else {
            blocks.push(line.to_string());
        }
    }
    Ok((blocks, body.as_bytes().to_vec()))
}

fn from_domain(blocks: &[String]) -> Result<String, FinalizeError> {
    let from = blocks
        .iter()
        .find(|b| b.len() > 5 && b[..5].eq_ignore_ascii_case("from:"))
        .ok_or(FinalizeError::NoFrom)?;
    let v = from[5..].replace("\r\n", " ");
    // `Name <a@b>` or bare `a@b`
    let addr = match (v.rfind('<'), v.rfind('>')) {
        (Some(l), Some(r)) if l < r => &v[l + 1..r],
        _ => v.trim(),
    };
    addr.rsplit_once('@')
        .map(|x| x.1.trim().to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .ok_or(FinalizeError::NoFrom)
}

pub fn finalize(msg: &[u8], cfg: &TenantConfig, job: &Job) -> Result<Finalized, FinalizeError> {
    if cfg.dkim_rsa.is_none() && cfg.dkim_ed25519.is_none() {
        return Err(FinalizeError::NoDkimKey);
    }
    if !(5..=15).contains(&cfg.feedback_sender_id.len()) {
        return Err(FinalizeError::BadSenderId);
    }
    let (blocks, body) = split(msg)?;
    if !from_domain(&blocks)?.eq_ignore_ascii_case(&cfg.sending_domain) {
        return Err(FinalizeError::Unaligned);
    }
    if job.stream == Stream::Marketing && !job.category.unsubscribable() {
        return Err(FinalizeError::MarketingNeedsCategory);
    }

    let msg_id = job.msg_id();
    let message_id = format!("{msg_id}@{}", cfg.sending_domain);
    let return_path = cfg.verp.return_path(&msg_id);
    let stream = match job.stream {
        Stream::Transactional => "transactional",
        Stream::Marketing => "marketing",
    };

    let date = chrono::DateTime::from_timestamp(job.now as i64, 0)
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S +0000");
    let mut added = vec![
        format!("Message-ID: <{message_id}>"),
        format!("Date: {date}"),
        // Google: a:b:c:SenderId; rightmost fields aggregate. Here campaign:tenant:stream:sender.
        format!(
            "Feedback-ID: {}:{}:{stream}:{}",
            slug(&job.campaign_id),
            slug(&cfg.tenant_id),
            slug(&cfg.feedback_sender_id)
        ),
        format!("X-Mail-Stream: {stream}"),
    ];

    let wants_unsub = job.stream == Stream::Marketing
        || (cfg.transactional_unsubscribe && job.category.unsubscribable());
    if wants_unsub {
        let token = unsubscribe::issue(
            &cfg.unsub_secret,
            &UnsubToken {
                tenant: cfg.tenant_id.clone(),
                contact: job.contact_id.clone(),
                category: job.category,
                exp: job.now + cfg.unsub_ttl_secs,
            },
        )?;
        let mut urls = vec![format!(
            "<{}/u/{token}>",
            clean(cfg.unsub_base_url.trim_end_matches('/'))
        )];
        if let Some((local, dom)) = cfg.unsub_mailto.as_deref().and_then(|m| m.split_once('@')) {
            // local-part max is 64 octets (RFC 5321); drop the mailto rather than emit an undeliverable one.
            if local.len() + 1 + token.len() <= 64 {
                urls.push(format!("<mailto:{}+{token}@{}>", clean(local), clean(dom)));
            }
        }
        added.push(format!("List-Unsubscribe: {}", urls.join(", ")));
        added.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click".into());
        added.push(format!(
            "List-Id: <{}.{}>",
            job.category.as_str(),
            cfg.sending_domain
        ));
    }

    let mut out = Vec::with_capacity(msg.len() + 1024);
    for l in &added {
        out.extend_from_slice(l.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    for b in &blocks {
        let name = b
            .split(':')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if MANAGED.contains(&name.as_str()) {
            continue;
        }
        out.extend_from_slice(b.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(&body);

    // Sign last, over the final bytes; prepend signatures (Ed25519 first, RSA second).
    let mut raw = Vec::with_capacity(out.len() + 1024);
    if let Some(s) = &cfg.dkim_ed25519 {
        raw.extend_from_slice(s.sign(&out)?.to_header().as_bytes());
    }
    if let Some(s) = &cfg.dkim_rsa {
        raw.extend_from_slice(s.sign(&out)?.to_header().as_bytes());
    }
    raw.extend_from_slice(&out);
    Ok(Finalized {
        raw,
        msg_id,
        message_id,
        return_path,
    })
}
