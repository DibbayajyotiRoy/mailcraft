//! Mailbox parsing, allowlist matching and test-mode magic addresses (SPEC 4.5).
use serde::{Deserialize, Serialize};

pub const MAGIC_DOMAIN: &str = "test.mailcraft.local";

/// Outcome a test-mode recipient simulates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MagicOutcome {
    Delivered,
    Bounced,
    Complained,
    Suppressed,
    Deferred,
}

/// `bounced+anything@test.mailcraft.local` -> `Bounced`. Any other address -> `None`.
pub fn magic_outcome(addr: &str) -> Option<MagicOutcome> {
    let (local, domain) = addr.rsplit_once('@')?;
    if !domain.eq_ignore_ascii_case(MAGIC_DOMAIN) {
        return None;
    }
    let base = local.split('+').next()?.to_ascii_lowercase();
    Some(match base.as_str() {
        "delivered" => MagicOutcome::Delivered,
        "bounced" => MagicOutcome::Bounced,
        "complained" => MagicOutcome::Complained,
        "suppressed" => MagicOutcome::Suppressed,
        "deferred" => MagicOutcome::Deferred,
        _ => return None,
    })
}

/// Parses `a@b.tld` or `Name <a@b.tld>`. Returns `(display_name, normalised_address)`.
/// Rejects control characters (header injection) and obviously malformed addresses.
pub fn parse_mailbox(s: &str) -> Option<(Option<String>, String)> {
    if s.len() > 320 || s.chars().any(|c| c.is_control()) {
        return None;
    }
    let s = s.trim();
    let (name, addr) = match (s.rfind('<'), s.ends_with('>')) {
        (Some(i), true) => {
            let n = s[..i].trim().trim_matches('"').trim();
            (
                (!n.is_empty()).then(|| n.to_string()),
                &s[i + 1..s.len() - 1],
            )
        }
        _ => (None, s),
    };
    let addr = addr.trim();
    let (local, domain) = addr.rsplit_once('@')?;
    let ok_local = !local.is_empty()
        && local.len() <= 64
        && !local.starts_with('.')
        && !local.ends_with('.')
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+/=?^_`{|}~.-".contains(c));
    let ok_domain = domain.len() <= 253
        && domain.contains('.')
        && domain.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    (ok_local && ok_domain).then(|| (name, format!("{local}@{}", domain.to_ascii_lowercase())))
}

/// Allowlist entries: an exact address (`ana@example.org`) or a domain (`@example.org`).
pub fn allowlist_matches(entries: &[String], addr: &str) -> bool {
    let addr = addr.to_ascii_lowercase();
    entries.iter().any(|e| {
        let e = e.to_ascii_lowercase();
        if e.starts_with('@') {
            addr.ends_with(&e)
        } else {
            addr == e
        }
    })
}

pub fn domain_of(addr: &str) -> &str {
    addr.rsplit_once('@').map(|x| x.1).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_rejects() {
        assert_eq!(
            parse_mailbox("Acme <Hello@Notify.Example.com>").unwrap(),
            (Some("Acme".into()), "Hello@notify.example.com".into())
        );
        assert!(parse_mailbox("a@b").is_none());
        assert!(parse_mailbox("a@b.com\r\nBcc: x@y.com").is_none());
        assert!(parse_mailbox("@b.com").is_none());
        assert!(parse_mailbox("a b@c.com").is_none());
    }

    #[test]
    fn magic_and_allowlist() {
        assert_eq!(
            magic_outcome("bounced+x@test.mailcraft.local"),
            Some(MagicOutcome::Bounced)
        );
        assert_eq!(magic_outcome("bounced@example.com"), None);
        assert_eq!(magic_outcome("other@test.mailcraft.local"), None);
        let al = vec!["ana@example.org".to_string(), "@corp.io".to_string()];
        assert!(allowlist_matches(&al, "Ana@example.org"));
        assert!(allowlist_matches(&al, "bob@corp.io"));
        assert!(!allowlist_matches(&al, "bob@evilcorp.io.x"));
        assert!(!allowlist_matches(&al, "bob@notcorp.io"));
    }
}
