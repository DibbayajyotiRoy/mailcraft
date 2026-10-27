//! Inbound bounce processing: RFC 3464 DSNs plus common non-standard bounces
//! (Gmail, Exchange/Outlook, Yahoo, Postfix), mapped back to a message via the VERP token.
use crate::provider::Provider;
use crate::token::Verp;
use mail_parser::{Headers, MessageParser};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BounceClass {
    /// Address is dead (5.1.x user unknown, 5.2.1 disabled): suppress.
    Hard,
    /// Transient (4.x, mailbox full, routing): count toward the soft threshold.
    Soft,
    /// Policy / reputation / blocklist (5.7.x ...): OUR problem. Never suppress the recipient.
    Block,
    /// Out-of-office / vacation: ignore.
    AutoReply,
    /// DSN "delayed" notice: nothing final happened yet.
    Delayed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bounce {
    pub class: BounceClass,
    /// Enhanced status code (RFC 3463), e.g. `5.1.1`.
    pub status: Option<String>,
    pub diagnostic: String,
    pub recipient: Option<String>,
    pub provider: Option<Provider>,
    /// Our message id, from the VERP token (or the returned Message-ID).
    pub msg_id: Option<String>,
    /// True when `msg_id` came from a MAC-verified VERP token (trust it for suppression).
    pub verp_verified: bool,
    pub reporting_mta: Option<String>,
}

// ---------- classification ----------

const BLOCK_TEXT: &[&str] = &[
    "spamhaus",
    "blocked using",
    "blocklist",
    "block list",
    "blacklist",
    "poor reputation",
    "dnsbl",
    "sender reputation",
    "ip reputation",
    "spam content",
    "message content rejected",
    "unsolicited mail",
    "banned sender",
    "access denied",
    "rejected due to policy",
    "listed at",
    "suspected spam",
    "has been blocked",
    "likely unsolicited",
    "unauthenticated",
];
const HARD_TEXT: &[&str] = &[
    "user unknown",
    "unknown user",
    "no such user",
    "user doesn't have",
    "does not exist",
    "doesn't exist",
    "recipient not found",
    "address not found",
    "address wasn't found",
    "couldn't be found",
    "wasn't found",
    "account disabled",
    "account has been disabled",
    "mailbox not found",
    "invalid recipient",
    "no such recipient",
];
const FULL_TEXT: &[&str] = &[
    "mailbox full",
    "mailbox is full",
    "over quota",
    "quota exceeded",
    "insufficient storage",
];

fn parse_status(s: &str) -> Option<(u8, u16, u16)> {
    let mut it = s.trim().split('.');
    let c = it.next()?.parse().ok()?;
    let sub = it.next()?.parse().ok()?;
    let det = it.next()?.parse().ok()?;
    Some((c, sub, det))
}

/// Classify from an enhanced status (if any) and free text (diagnostic / body).
pub fn classify(status: Option<&str>, text: &str) -> BounceClass {
    let t = text.to_ascii_lowercase();
    let has = |l: &[&str]| l.iter().any(|w| t.contains(w));
    let st = status.and_then(parse_status);
    let (c, sub) = st.map_or((0, 0), |s| (s.0, s.1));
    let definitive_rcpt = c == 5 && (sub == 1 || (sub == 2 && st.is_some_and(|s| s.2 == 1)));
    if has(BLOCK_TEXT) && !definitive_rcpt && !(c == 5 && sub == 2) {
        return BounceClass::Block;
    }
    if definitive_rcpt {
        return BounceClass::Hard;
    }
    if (c == 5 && sub == 2) || has(FULL_TEXT) {
        return BounceClass::Soft;
    }
    if c != 4 && has(HARD_TEXT) {
        return BounceClass::Hard;
    }
    if c == 5 && sub == 7 {
        return BounceClass::Block;
    }
    BounceClass::Soft
}

// ---------- text scanning helpers ----------

/// First `[245].x.y` enhanced status in `text` that is a failure (4.x/5.x).
pub(crate) fn find_enhanced_status(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if matches!(b[i], b'4' | b'5')
            && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'.'))
            && b.get(i + 1) == Some(&b'.')
        {
            let mut j = i + 2;
            let s1 = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > s1 && j - s1 <= 3 && b.get(j) == Some(&b'.') {
                let mut k = j + 1;
                let s2 = k;
                while k < b.len() && b[k].is_ascii_digit() {
                    k += 1;
                }
                let tail_ok =
                    !(b.get(k) == Some(&b'.') && b.get(k + 1).is_some_and(u8::is_ascii_digit));
                if k > s2 && k - s2 <= 3 && tail_ok {
                    return Some(text[i..k].to_string());
                }
            }
        }
        i += 1;
    }
    None
}

fn clean_addr(tok: &str) -> Option<String> {
    let t = tok.trim_matches(|c: char| {
        matches!(
            c,
            '<' | '>' | ':' | ';' | ',' | '(' | ')' | '"' | '\'' | '[' | ']'
        )
    });
    let t = t.strip_prefix("mailto:").unwrap_or(t);
    (t.contains('@') && !t.starts_with('@') && !t.ends_with('@')).then(|| t.to_string())
}

fn is_system_addr(a: &str) -> bool {
    let l = a.to_ascii_lowercase();
    l.starts_with("mailer-daemon@") || l.starts_with("postmaster@") || l.starts_with("bounces+")
}

fn heuristic_recipient(text: &str) -> Option<String> {
    const CUES: &[&str] = &[
        "to these recipients or groups",
        "following recipient",
        "following address",
        "wasn't delivered to",
        "couldn't be delivered to",
        "was not delivered to",
        "delivery to the following",
        "failed recipient",
    ];
    let lower = text.to_ascii_lowercase();
    let start = CUES.iter().filter_map(|c| lower.find(c)).min().unwrap_or(0);
    let first = |s: &str| {
        s.split_whitespace()
            .filter_map(clean_addr)
            .find(|a| !is_system_addr(a))
    };
    first(&text[start..]).or_else(|| first(text))
}

/// Map back to our message: MAC-verified VERP token anywhere in `raw`, else a returned Message-ID.
/// Returns `(msg_id, verified)`.
pub(crate) fn extract_msg_id(raw: &str, verp: &Verp) -> Option<(String, bool)> {
    let mut rest = raw;
    while let Some(p) = rest.find(&verp.prefix) {
        let after = &rest[p + verp.prefix.len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
            .unwrap_or(after.len());
        if after[end..].starts_with('@')
            && let Some(id) = verp.decode(&after[..end])
        {
            return Some((id, true));
        }
        rest = after;
    }
    // Fallback: returned `Message-ID: <24hex@domain>`. Unauthenticated, so callers should not suppress on it.
    for line in raw.lines() {
        if line.len() > 11 && line[..11].eq_ignore_ascii_case("message-id:") {
            let id = line[11..]
                .trim()
                .trim_start_matches('<')
                .split('@')
                .next()
                .unwrap_or("");
            if id.len() == 24 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Some((id.to_string(), false));
            }
        }
    }
    None
}

pub(crate) fn header_value(h: &Headers<'_>, name: &str) -> Option<String> {
    h.iter()
        .find(|x| x.raw_name().eq_ignore_ascii_case(name))
        .map(|x| String::from_utf8_lossy(x.raw_value()).trim().to_string())
}

/// Parse `Name: value` field blocks (RFC 3464 style, with folding), split on blank lines.
pub(crate) fn field_blocks(text: &str) -> Vec<Vec<(String, String)>> {
    let norm = text.replace("\r\n", "\n");
    norm.split("\n\n")
        .map(|blk| {
            let mut f: Vec<(String, String)> = Vec::new();
            for line in blk.lines() {
                if line.starts_with([' ', '\t']) {
                    if let Some(l) = f.last_mut() {
                        l.1.push(' ');
                        l.1.push_str(line.trim());
                    }
                } else if let Some((k, v)) = line.split_once(':') {
                    f.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
                }
            }
            f
        })
        .filter(|f| !f.is_empty())
        .collect()
}

pub(crate) fn field<'a>(block: &'a [(String, String)], name: &str) -> Option<&'a str> {
    block
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// Value after the `type;` prefix of RFC 3464 fields like `rfc822; a@b`, `smtp; 550 ...`, `dns; mx.host`.
fn after_semicolon(v: &str) -> &str {
    v.split_once(';').map_or(v, |x| x.1).trim()
}

fn is_autoreply(h: &Headers<'_>) -> bool {
    let auto = header_value(h, "Auto-Submitted").is_some_and(|v| !v.eq_ignore_ascii_case("no"));
    let precedence =
        header_value(h, "Precedence").is_some_and(|v| v.eq_ignore_ascii_case("auto_reply"));
    let subj = header_value(h, "Subject")
        .unwrap_or_default()
        .to_ascii_lowercase();
    auto || precedence
        || header_value(h, "X-Autoreply").is_some()
        || header_value(h, "X-Autorespond").is_some()
        || header_value(h, "X-Auto-Response-Suppress").is_some_and(|v| v.contains("OOF"))
        || [
            "automatic reply",
            "auto-reply",
            "autoreply",
            "out of office",
            "auto:",
            "vacation",
        ]
        .iter()
        .any(|s| subj.contains(s))
}

/// Parse an inbound message received at the bounce domain. `None` = not a bounce at all
/// (or a DSN for a successful delivery).
pub fn parse(raw: &[u8], verp: &Verp) -> Option<Bounce> {
    let msg = MessageParser::new().parse(raw)?;
    let root = msg.root();
    let rh = root.headers();
    let raw_text = String::from_utf8_lossy(raw);
    let (msg_id, verp_verified) =
        extract_msg_id(&raw_text, verp).map_or((None, false), |(i, v)| (Some(i), v));

    // 1) RFC 3464: multipart/report; report-type=delivery-status
    if let Some(ds) = msg
        .parts()
        .find(|p| p.is_content_type("message", "delivery-status"))
    {
        let dec = ds.decoded();
        let text =
            String::from_utf8_lossy(if dec.is_empty() { ds.raw_body() } else { &dec }).into_owned();
        let blocks = field_blocks(&text);
        let reporting_mta = blocks
            .first()
            .and_then(|b| field(b, "reporting-mta"))
            .map(|v| after_semicolon(v).to_string());
        let rcpts: Vec<_> = blocks
            .iter()
            .skip(1)
            .filter(|b| field(b, "action").is_some())
            .collect();
        // prefer a failed recipient block, then delayed
        let b = rcpts
            .iter()
            .find(|b| field(b, "action").is_some_and(|a| a.eq_ignore_ascii_case("failed")))
            .or_else(|| rcpts.first())?;
        let action = field(b, "action")?.to_ascii_lowercase();
        let recipient = field(b, "final-recipient")
            .or_else(|| field(b, "original-recipient"))
            .map(|v| after_semicolon(v).to_string());
        let diag = field(b, "diagnostic-code")
            .map(|v| after_semicolon(v).to_string())
            .unwrap_or_default();
        let status = field(b, "status")
            .map(str::to_string)
            .or_else(|| find_enhanced_status(&diag));
        let class = match action.as_str() {
            "failed" => classify(status.as_deref(), &diag),
            "delayed" => BounceClass::Delayed,
            _ => return None, // delivered / relayed / expanded
        };
        return Some(Bounce {
            class,
            provider: recipient.as_deref().map(Provider::from_address),
            status,
            diagnostic: diag,
            recipient,
            msg_id,
            verp_verified,
            reporting_mta,
        });
    }

    // 2) Non-standard bounces (legacy Exchange NDR, Yahoo, Gmail legacy, plain Postfix text).
    let subj = header_value(&rh, "Subject")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let from = header_value(&rh, "From")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bounce_subject = [
        "undeliverable",
        "delivery status notification",
        "returned mail",
        "failure notice",
        "mail delivery failed",
        "delivery failure",
        "mail delivery system",
        "could not be delivered",
        "delivery has failed",
    ]
    .iter()
    .any(|s| subj.contains(s));
    let looks_like_bounce = bounce_subject
        || header_value(&rh, "X-MS-Exchange-Message-Is-Ndr").is_some()
        || from.contains("mailer-daemon")
        || from.contains("postmaster@");

    if !looks_like_bounce {
        return is_autoreply(&rh).then_some(Bounce {
            class: BounceClass::AutoReply,
            status: None,
            diagnostic: subj,
            recipient: None,
            provider: None,
            msg_id,
            verp_verified,
            reporting_mta: None,
        });
    }
    let body: String = msg.text_bodies().collect::<Vec<_>>().join("\n");
    let body = if body.trim().is_empty() {
        raw_text.to_string()
    } else {
        body
    };
    if subj.contains("(delay")
        || subj.contains("delayed")
        || subj.contains("warning: could not send")
    {
        return Some(Bounce {
            class: BounceClass::Delayed,
            status: find_enhanced_status(&body),
            diagnostic: body
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string(),
            recipient: heuristic_recipient(&body),
            provider: None,
            msg_id,
            verp_verified,
            reporting_mta: None,
        });
    }
    let status = find_enhanced_status(&body);
    let recipient = heuristic_recipient(&body);
    let diag = body
        .lines()
        .find(|l| {
            status.as_deref().is_some_and(|s| l.contains(s))
                || HARD_TEXT
                    .iter()
                    .chain(FULL_TEXT)
                    .any(|w| l.to_ascii_lowercase().contains(w))
        })
        .unwrap_or("")
        .trim()
        .to_string();
    Some(Bounce {
        class: classify(status.as_deref(), &body),
        status,
        diagnostic: diag,
        provider: recipient.as_deref().map(Provider::from_address),
        recipient,
        msg_id,
        verp_verified,
        reporting_mta: None,
    })
}

/// Resolves a verified msg id to the message we sent (tenant, recipient, sending identity).
pub trait MessageLookup {
    fn find(&self, msg_id: &str) -> Option<SentMessage>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SentMessage {
    pub tenant: String,
    pub recipient: String,
    /// Sending domain or IP the pacer is keyed on.
    pub sender: String,
}

impl MessageLookup for std::collections::HashMap<String, SentMessage> {
    fn find(&self, msg_id: &str) -> Option<SentMessage> {
        self.get(msg_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_table() {
        use BounceClass::*;
        let cases = [
            (Some("5.1.1"), "user unknown", Hard),
            (Some("5.1.10"), "RESOLVER.ADR.RecipientNotFound", Hard),
            (Some("5.2.1"), "mailbox disabled", Hard),
            (Some("5.2.2"), "mailbox full", Soft),
            (Some("4.2.2"), "over quota", Soft),
            (Some("4.4.1"), "connection timed out", Soft),
            (Some("5.4.1"), "routing", Soft),
            (Some("5.7.1"), "blocked using Spamhaus", Block),
            (Some("5.7.26"), "unauthenticated mail", Block),
            (Some("5.7.515"), "access denied", Block),
            (Some("5.7.1"), "rejected", Block),
            (Some("4.7.0"), "listed at dnsbl", Block),
            (
                None,
                "554 delivery error: dd This user doesn't have a yahoo.com account",
                Hard,
            ),
            (None, "the mailbox is full", Soft),
            (
                Some("5.7.1"),
                "Recipient address rejected: User unknown",
                Hard,
            ),
        ];
        for (s, t, want) in cases {
            assert_eq!(classify(s, t), want, "{s:?} {t}");
        }
    }

    #[test]
    fn status_scanner() {
        assert_eq!(
            find_enhanced_status("550 5.1.1 nope").as_deref(),
            Some("5.1.1")
        );
        assert_eq!(
            find_enhanced_status("host 10.5.1.1 said 4.2.2 full").as_deref(),
            Some("4.2.2")
        );
        assert_eq!(find_enhanced_status("2.0.0 ok"), None);
    }
}
