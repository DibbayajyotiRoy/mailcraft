//! MIME assembly (mail-builder). DKIM and extra headers are the `Finalizer`'s job.
use mail_builder::{
    headers::{address::Address, text::Text},
    MessageBuilder,
};

/// Split `"Name <a@b>"` or `"a@b"` into (name, address).
pub fn parse_mailbox(s: &str) -> (String, String) {
    let s = s.trim();
    match (s.rfind('<'), s.ends_with('>')) {
        (Some(i), true) => (
            s[..i].trim().trim_matches('"').to_string(),
            s[i + 1..s.len() - 1].trim().to_string(),
        ),
        _ => (String::new(), s.to_string()),
    }
}

pub fn addr_domain(addr: &str) -> &str {
    addr.rsplit('@').next().unwrap_or("localhost")
}

/// Headers the API may not override: the engine owns structure and identity.
const RESERVED: &[&str] = &[
    "from",
    "to",
    "cc",
    "bcc",
    "subject",
    "message-id",
    "date",
    "mime-version",
    "reply-to",
    "return-path",
];

fn header_ok(k: &str, v: &str) -> bool {
    !k.is_empty()
        && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !k.to_ascii_lowercase().starts_with("content-")
        && !RESERVED.contains(&k.to_ascii_lowercase().as_str())
        && !v.contains(['\r', '\n'])
}

pub struct MimeParts<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub cc: &'a [String],
    pub reply_to: Option<&'a str>,
    pub subject: &'a str,
    pub text: Option<&'a str>,
    pub html: Option<&'a str>,
    pub headers: &'a serde_json::Value,
    /// RFC 5322 Message-ID without angle brackets.
    pub message_id: &'a str,
}

/// Build RFC 5322 bytes. Errors (no body, bad header encoding) are permanent: retrying cannot fix them.
pub fn build(p: &MimeParts) -> Result<Vec<u8>, String> {
    if p.text.is_none() && p.html.is_none() {
        return Err("email has no text or html body".into());
    }
    // No display name -> a bare address (mail-builder would print `"" <a@b>`).
    let mb = |s: &str| {
        let (n, a) = parse_mailbox(s);
        Address::new_address((!n.is_empty()).then_some(n), a)
    };
    let mut b = MessageBuilder::new()
        .from(mb(p.from))
        .to(mb(p.to))
        .message_id(p.message_id.to_string())
        .subject(p.subject.to_string());
    if !p.cc.is_empty() {
        b = b.cc(p.cc.iter().map(|c| mb(c)).collect::<Vec<_>>());
    }
    if let Some(r) = p.reply_to {
        b = b.reply_to(mb(r));
    }
    if let Some(t) = p.text {
        b = b.text_body(t.to_string());
    }
    if let Some(h) = p.html {
        b = b.html_body(h.to_string());
    }
    if let Some(obj) = p.headers.as_object() {
        for (k, v) in obj {
            match v.as_str() {
                Some(v) if header_ok(k, v) => b = b.header(k.clone(), Text::new(v.to_string())),
                _ => tracing::warn!(header = %k, "dropping unsafe or reserved custom header"),
            }
        }
    }
    b.write_to_vec().map_err(|e| format!("mime: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_alternative_with_custom_headers_and_drops_injection() {
        let h = serde_json::json!({
            "List-Unsubscribe": "<https://x.test/u/1>",
            "X-Evil": "a\r\nBcc: x@y.z",
            "Subject": "override",
            "Content-Type": "text/evil",
        });
        let raw = build(&MimeParts {
            from: "Ann <ann@example.com>",
            to: "bob@example.org",
            cc: &["c@example.org".into()],
            reply_to: None,
            subject: "Hello",
            text: Some("plain"),
            html: Some("<p>html</p>"),
            headers: &h,
            message_id: "id1@example.com",
        })
        .unwrap();
        let s = String::from_utf8(raw).unwrap();
        assert!(s.contains("multipart/alternative") && s.contains("Message-ID: <id1@example.com>"));
        assert!(s.contains("List-Unsubscribe: <https://x.test/u/1>"));
        assert!(!s.contains("X-Evil") && !s.contains("override") && !s.contains("text/evil"));
        assert!(s.contains("Subject: Hello") && s.contains("Cc:"));
    }

    #[test]
    fn mailbox_parse() {
        assert_eq!(
            parse_mailbox("\"A B\" <a@b.c>"),
            ("A B".into(), "a@b.c".into())
        );
        assert_eq!(parse_mailbox(" a@b.c "), (String::new(), "a@b.c".into()));
    }
}
