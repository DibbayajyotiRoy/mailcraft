//! Inbound bounce / complaint / mailto-unsubscribe processing. Three front doors feed the same
//! [`record`]: the SMTP receiver (`smtp_in`), `POST /ingest/raw` (a raw RFC 822 DSN/ARF) and
//! `POST /ingest/ses` (SNS notifications from Amazon SES). See docs/inbound.md.
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use mailcraft_core::crypto::ct_eq;
use mailcraft_deliverability::{
    bounce::{self, BounceClass},
    complaint::{self, FeedbackKind},
    suppression::{Action, EventCtx, Policy, Reason, SoftBounceLog},
    token::Verp,
    unsubscribe,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{envelope, err, invalid, ApiResult},
    state::AppState,
};

/// Local part we advertise for mailto unsubscribe (`unsub+TOKEN@<mx host>`).
pub const UNSUB_MAILBOX: &str = "unsub";

// ------------------------------------------------------------------ VERP

/// Secret behind the bounce return-path MAC; derived from the unsubscribe secret.
pub fn verp_secret(unsub_secret: &[u8]) -> Vec<u8> {
    [b"verp:", unsub_secret].concat()
}

fn verp(unsub_secret: &[u8], domain: &str) -> Verp {
    let mut v = Verp::new(verp_secret(unsub_secret), domain);
    v.prefix = "bounce+".into();
    v
}

/// MAIL FROM for an outgoing email: `bounce+<email id>.<mac>@<return path host>`.
pub fn return_path(unsub_secret: &[u8], email_id: Uuid, host: &str) -> String {
    verp(unsub_secret, host).return_path(&email_id.simple().to_string())
}

// ------------------------------------------------------------------ recipients

pub enum Rcpt {
    /// Verified VERP address of an email that exists.
    Bounce(Uuid),
    /// Valid mailto-unsubscribe address (full address kept for `handle_mailto`).
    Unsub(String),
}

/// Local recipients only; everything else is `None` (the SMTP receiver answers 550, never relays).
pub async fn classify_rcpt(st: &AppState, addr: &str) -> Result<Option<Rcpt>, sqlx::Error> {
    let addr = addr.trim().trim_start_matches('<').trim_end_matches('>');
    let Some((local, _)) = addr.rsplit_once('@') else {
        return Ok(None);
    };
    if let Some(tok) = local.strip_prefix("bounce+") {
        let id = verp(&st.config.unsub_secret, "").decode(tok);
        let Some(id) = id.and_then(|i| Uuid::parse_str(&i).ok()) else {
            return Ok(None);
        };
        let known: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM emails WHERE id = $1)")
            .bind(id)
            .fetch_one(&st.db)
            .await?;
        return Ok(known.then_some(Rcpt::Bounce(id)));
    }
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    Ok(unsubscribe::parse_mailto_rcpt(addr, UNSUB_MAILBOX)
        .is_some_and(|t| unsubscribe::verify(&st.config.unsub_secret, t, now).is_ok())
        .then(|| Rcpt::Unsub(addr.to_string())))
}

/// RFC 2369 mailto unsubscribe: same effect as the one-click POST.
pub async fn mailto_unsubscribe(st: &AppState, rcpt: &str) -> Result<(), sqlx::Error> {
    let seen = crate::public::Collect::default();
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    if unsubscribe::handle_mailto(rcpt, UNSUB_MAILBOX, &st.config.unsub_secret, now, &seen).is_ok()
    {
        for (tenant, contact, cat) in seen.0.into_inner().unwrap() {
            crate::public::apply(st, &tenant, &contact, cat).await?;
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ recording

pub enum Kind {
    Bounce {
        class: BounceClass,
        status: Option<String>,
        diag: String,
    },
    Complaint(FeedbackKind),
}

pub struct Inbound {
    pub email_id: Uuid,
    pub kind: Kind,
    /// Dedupe key (`email_events.provider_event_id`): a redelivered DSN or SNS retry is a no-op.
    pub key: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub email_id: Uuid,
    pub event: &'static str,
    /// False when this exact report was already recorded.
    pub recorded: bool,
    pub suppressed: bool,
}

/// The soft-bounce count is read from `email_events`; the policy's log trait just returns it.
struct Counted(usize);
impl SoftBounceLog for Counted {
    fn record_and_count(&self, _: &str, _: &str, _: u64, _: u64) -> usize {
        self.0
    }
}

/// `None` = nothing to do (unknown email, auto-reply, delayed notice, "not spam").
pub async fn record(st: &AppState, ev: &Inbound) -> Result<Option<Outcome>, sqlx::Error> {
    let row: Option<(Uuid, String, String)> =
        sqlx::query_as("SELECT workspace_id, to_addr, from_addr FROM emails WHERE id = $1")
            .bind(ev.email_id)
            .fetch_optional(&st.db)
            .await?;
    let Some((ws, rcpt, from)) = row else {
        return Ok(None);
    };
    let (ty, class, status, diag) = match &ev.kind {
        Kind::Bounce {
            class,
            status,
            diag,
        } => match class {
            BounceClass::Hard => ("bounced", Some("hard"), status, diag),
            BounceClass::Soft => ("bounced", Some("soft"), status, diag),
            BounceClass::Block => ("bounced", Some("block"), status, diag),
            BounceClass::AutoReply | BounceClass::Delayed => return Ok(None),
        },
        Kind::Complaint(FeedbackKind::NotSpam) => return Ok(None),
        Kind::Complaint(_) => ("complained", None, &None, &String::new()),
    };
    let mut tx = st.db.begin().await?;
    let new = sqlx::query(
        "INSERT INTO email_events (workspace_id, email_id, type, bounce_class, enhanced_code, diagnostic, provider_event_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provider_event_id) DO NOTHING",
    )
    .bind(ws)
    .bind(ev.email_id)
    .bind(ty)
    .bind(class)
    .bind(status)
    .bind(Some(diag).filter(|d| !d.is_empty()))
    .bind(&ev.key)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    let mut out = Outcome {
        email_id: ev.email_id,
        event: ty,
        recorded: new,
        suppressed: false,
    };
    if !new {
        return Ok(Some(out));
    }
    if ty == "bounced" {
        sqlx::query("UPDATE emails SET status = 'bounced' WHERE id = $1")
            .bind(ev.email_id)
            .execute(&mut *tx)
            .await?;
    }
    let soft: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM email_events ev JOIN emails e ON e.id = ev.email_id \
         WHERE ev.workspace_id = $1 AND lower(e.to_addr) = lower($2) AND ev.type = 'bounced' \
           AND ev.bounce_class = 'soft' AND ev.occurred_at >= now() - interval '7 days'",
    )
    .bind(ws)
    .bind(&rcpt)
    .fetch_one(&mut *tx)
    .await?;
    let ctx = EventCtx {
        tenant: ws.to_string(),
        recipient: rcpt.clone(),
        sender: from
            .rsplit_once('@')
            .map_or(from.clone(), |x| x.1.trim_end_matches('>').to_string()),
        now: chrono::Utc::now().timestamp().max(0) as u64,
    };
    let policy = Policy::default();
    let actions = match &ev.kind {
        Kind::Bounce { class, diag, .. } => {
            policy.on_bounce(&Counted(soft as usize), &ctx, *class, diag)
        }
        Kind::Complaint(k) => policy.on_complaint(&ctx, *k),
    };
    for a in actions {
        match a {
            Action::Suppress(s) => {
                let reason = match s.reason {
                    Reason::HardBounce => "hard_bounce",
                    Reason::SoftBounceLimit => "soft_bounce_limit",
                    Reason::Complaint => "complaint",
                    Reason::Sunset => "manual",
                };
                // ponytail: the table has no scope column, so a complaint's marketing-only scope is
                // enforced as a full block until scope is added to every send gate.
                sqlx::query(
                    "INSERT INTO suppressions (workspace_id, email, reason, source, email_id) \
                     VALUES ($1, lower($2), $3, 'inbound', $4) ON CONFLICT DO NOTHING",
                )
                .bind(ws)
                .bind(&s.address)
                .bind(reason)
                .bind(ev.email_id)
                .execute(&mut *tx)
                .await?;
                out.suppressed = true;
            }
            // ponytail: no persisted pacer; the block is logged for the operator, not auto-paused.
            Action::PauseSending {
                sender, provider, ..
            }
            | Action::FlagSender {
                sender, provider, ..
            } => {
                tracing::warn!(%sender, ?provider, email = %ev.email_id, "provider block bounce: check reputation / blocklists");
            }
            Action::Ignore => {}
        }
    }
    tx.commit().await?;
    Ok(Some(out))
}

/// Parse a raw RFC 822 DSN or ARF report and record it. `envelope` is the email id from a verified
/// VERP RCPT TO (authoritative); without it the MAC-verified VERP address inside the report is used.
pub async fn from_raw(
    st: &AppState,
    raw: &[u8],
    envelope: Option<Uuid>,
) -> Result<Option<Outcome>, sqlx::Error> {
    let v = verp(&st.config.unsub_secret, "");
    let (id, kind) = if let Some(c) = complaint::parse(raw, &v) {
        (
            c.verp_verified.then_some(c.msg_id).flatten(),
            Kind::Complaint(c.kind),
        )
    } else if let Some(b) = bounce::parse(raw, &v) {
        let kind = Kind::Bounce {
            class: b.class,
            status: b.status,
            diag: b.diagnostic,
        };
        (b.verp_verified.then_some(b.msg_id).flatten(), kind)
    } else {
        return Ok(None);
    };
    let Some(email_id) = envelope.or_else(|| id.and_then(|i| Uuid::parse_str(&i).ok())) else {
        return Ok(None); // not mappable by a verified token: never act on a guess
    };
    let tag = if matches!(kind, Kind::Complaint(_)) {
        "complaint"
    } else {
        "bounce"
    };
    record(
        st,
        &Inbound {
            email_id,
            kind,
            key: format!("inbound:{tag}:{email_id}"),
        },
    )
    .await
}

// ------------------------------------------------------------------ SES / SNS

/// Maps one SES event (the SNS `Message`) to `(SES message id, kind)`.
fn ses_kind(m: &Value) -> Option<(String, Kind)> {
    let ses_id = m["mail"]["messageId"].as_str()?.to_string();
    let ty = m["notificationType"]
        .as_str()
        .or_else(|| m["eventType"].as_str())?;
    let kind = match ty {
        "Bounce" => {
            let b = &m["bounce"];
            let r = &b["bouncedRecipients"][0];
            let status = r["status"].as_str().map(str::to_string);
            let diag = r["diagnosticCode"].as_str().unwrap_or_default().to_string();
            let sub = b["bounceSubType"].as_str().unwrap_or_default();
            let class = match b["bounceType"].as_str()? {
                "Permanent" => BounceClass::Hard,
                _ if matches!(sub, "ContentRejected" | "AttachmentRejected") => BounceClass::Block,
                _ => BounceClass::Soft,
            };
            // A permanent bounce whose text says "blocked by reputation" is our problem, not the recipient's.
            let class = if class == BounceClass::Hard
                && bounce::classify(status.as_deref(), &diag) == BounceClass::Block
            {
                BounceClass::Block
            } else {
                class
            };
            Kind::Bounce {
                class,
                status,
                diag,
            }
        }
        "Complaint" => Kind::Complaint(match m["complaint"]["complaintFeedbackType"].as_str() {
            Some("fraud") => FeedbackKind::Fraud,
            Some("virus") => FeedbackKind::Virus,
            Some("not-spam") => FeedbackKind::NotSpam,
            Some("abuse") | None => FeedbackKind::Abuse,
            Some(_) => FeedbackKind::Other,
        }),
        _ => return None, // Delivery, Send, Open, ...: not ours to record
    };
    Some((ses_id, kind))
}

fn amazon_host(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str().is_some_and(|h| {
                h.starts_with("sns.")
                    && (h.ends_with(".amazonaws.com") || h.ends_with(".amazonaws.com.cn"))
            })
    })
}

// ------------------------------------------------------------------ HTTP

#[derive(Deserialize)]
pub struct TokenQ {
    token: Option<String>,
}

/// `Authorization: Bearer <MAILCRAFT_INGEST_TOKEN>` or `?token=` (SNS cannot send headers).
fn authorize(st: &AppState, h: &HeaderMap, q: &TokenQ) -> Result<(), crate::error::ApiError> {
    let Some(want) = st.config.ingest_token.as_deref() else {
        return Err(err(
            "ingest_disabled",
            503,
            "MAILCRAFT_INGEST_TOKEN is not set",
        ));
    };
    let got = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or(q.token.as_deref())
        .unwrap_or_default();
    if ct_eq(got.as_bytes(), want.as_bytes()) {
        Ok(())
    } else {
        Err(err("unauthenticated", 401, "missing or wrong ingest token"))
    }
}

/// `POST /ingest/raw`: body is one raw RFC 822 message (a DSN or ARF report).
pub async fn raw(
    State(st): State<AppState>,
    Query(q): Query<TokenQ>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult {
    authorize(&st, &h, &q)?;
    let o = from_raw(&st, &body, None).await?;
    Ok(envelope(StatusCode::OK, json!({ "outcome": o })))
}

/// `POST /ingest/ses`: SNS delivery. Authenticated by the ingest token in the subscribed URL plus
/// the `TopicArn` allowlist (`MAILCRAFT_SES_TOPIC_ARNS`). ponytail: SNS message signatures are not
/// verified (needs X.509 parsing); the secret URL token stands in. Add if the URL can leak.
pub async fn ses(
    State(st): State<AppState>,
    Query(q): Query<TokenQ>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult {
    authorize(&st, &h, &q)?;
    let n: Value =
        serde_json::from_slice(&body).map_err(|_| invalid("body is not an SNS JSON message"))?;
    let arn = n["TopicArn"].as_str().unwrap_or_default();
    if arn.is_empty() || !st.config.ses_topic_arns.iter().any(|a| a == arn) {
        return Err(err(
            "forbidden_topic",
            403,
            "TopicArn is not in MAILCRAFT_SES_TOPIC_ARNS",
        ));
    }
    match n["Type"].as_str() {
        Some("SubscriptionConfirmation") => {
            let url = n["SubscribeURL"].as_str().unwrap_or_default();
            if !amazon_host(url) {
                return Err(invalid("SubscribeURL is not an https SNS endpoint"));
            }
            reqwest::get(url)
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| {
                    err(
                        "confirm_failed",
                        502,
                        format!("could not confirm subscription: {e}"),
                    )
                })?;
            Ok(envelope(StatusCode::OK, json!({ "confirmed": true })))
        }
        Some("Notification") => {
            let m: Value = serde_json::from_str(n["Message"].as_str().unwrap_or_default())
                .map_err(|_| invalid("Message is not a SES event"))?;
            let Some((ses_id, kind)) = ses_kind(&m) else {
                return Ok(envelope(StatusCode::OK, json!({ "outcome": null })));
            };
            let email_id: Option<Uuid> =
                sqlx::query_scalar("SELECT id FROM emails WHERE provider_message_id = $1")
                    .bind(&ses_id)
                    .fetch_optional(&st.db)
                    .await?;
            let Some(email_id) = email_id else {
                return Ok(envelope(StatusCode::OK, json!({ "outcome": null })));
            };
            let key = format!("ses:{}", n["MessageId"].as_str().unwrap_or(&ses_id));
            let o = record(
                &st,
                &Inbound {
                    email_id,
                    kind,
                    key,
                },
            )
            .await?;
            Ok(envelope(StatusCode::OK, json!({ "outcome": o })))
        }
        _ => Ok(envelope(StatusCode::OK, json!({ "ignored": true }))), // UnsubscribeConfirmation etc.
    }
}
