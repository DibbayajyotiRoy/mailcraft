//! ARF (RFC 5965) feedback-report parsing: Yahoo CFL, Microsoft JMRP and friends.
use crate::bounce::{extract_msg_id, field, field_blocks};
use crate::provider::Provider;
use crate::token::Verp;
use mail_parser::MessageParser;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedbackKind {
    Abuse,
    Fraud,
    Virus,
    Other,
    /// RFC 5965 `opt-out`: recipient asked to stop; treated like a complaint for suppression.
    OptOut,
    /// Recipient marked "not spam": no action.
    NotSpam,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Complaint {
    pub kind: FeedbackKind,
    pub recipient: Option<String>,
    pub provider: Option<Provider>,
    pub msg_id: Option<String>,
    pub verp_verified: bool,
    pub source_ip: Option<String>,
    pub user_agent: Option<String>,
}

fn kind_of(s: &str) -> FeedbackKind {
    match s.trim().to_ascii_lowercase().as_str() {
        "abuse" => FeedbackKind::Abuse,
        "fraud" => FeedbackKind::Fraud,
        "virus" => FeedbackKind::Virus,
        "opt-out" => FeedbackKind::OptOut,
        "not-spam" => FeedbackKind::NotSpam,
        _ => FeedbackKind::Other,
    }
}

/// `None` if the message is not an ARF feedback report.
pub fn parse(raw: &[u8], verp: &Verp) -> Option<Complaint> {
    let msg = MessageParser::new().parse(raw)?;
    let fp = msg
        .parts()
        .find(|p| p.is_content_type("message", "feedback-report"))?;
    let dec = fp.decoded();
    let text =
        String::from_utf8_lossy(if dec.is_empty() { fp.raw_body() } else { &dec }).into_owned();
    let blocks = field_blocks(&text);
    let b = blocks
        .iter()
        .find(|b| field(b, "feedback-type").is_some())?;
    let kind = kind_of(field(b, "feedback-type")?);

    let raw_text = String::from_utf8_lossy(raw);
    // Yahoo CFL often redacts Original-Rcpt-To; fall back to To: of the returned message.
    let recipient = field(b, "original-rcpt-to")
        .map(|v| v.trim_matches(['<', '>']).to_string())
        .or_else(|| returned_to(&raw_text));
    // Original-Mail-From is our VERP return-path when the receiver echoes it; the generic scan covers it too.
    let (msg_id, verp_verified) = field(b, "original-mail-from")
        .and_then(|v| extract_msg_id(v, verp))
        .or_else(|| extract_msg_id(&raw_text, verp))
        .map_or((None, false), |(i, v)| (Some(i), v));
    Some(Complaint {
        kind,
        provider: recipient.as_deref().map(Provider::from_address),
        recipient,
        msg_id,
        verp_verified,
        source_ip: field(b, "source-ip").map(str::to_string),
        user_agent: field(b, "user-agent").map(str::to_string),
    })
}

/// `To:` header of the returned original (the first `To:` after the feedback-report part).
fn returned_to(raw: &str) -> Option<String> {
    let after = &raw[raw.to_ascii_lowercase().find("feedback-type:")?..];
    after.lines().find_map(|l| {
        (l.len() > 3 && l[..3].eq_ignore_ascii_case("to:")).then(|| {
            let v = l[3..].trim();
            v.rsplit_once('<')
                .map_or(v, |x| x.1)
                .trim_end_matches('>')
                .trim()
                .to_string()
        })
    })
}
