use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Do not retry this message (bad address, rejected content, unverified sender).
    Permanent,
    /// Retry later with backoff (4xx SMTP, 5xx HTTP, network).
    Temporary,
    /// Credentials are bad/expired/revoked; retrying is pointless until the operator fixes the transport.
    Auth,
    /// Provider or local cap hit; retry after `retry_after` if known.
    RateLimited,
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("permanent failure: {0}")]
    Permanent(String),
    #[error("temporary failure: {0}")]
    Temporary(String),
    #[error("authentication failure: {0}")]
    Auth(String),
    #[error("rate limited: {msg}")]
    RateLimited {
        msg: String,
        retry_after: Option<Duration>,
    },
}

impl TransportError {
    pub fn class(&self) -> ErrorClass {
        match self {
            Self::Permanent(_) => ErrorClass::Permanent,
            Self::Temporary(_) => ErrorClass::Temporary,
            Self::Auth(_) => ErrorClass::Auth,
            Self::RateLimited { .. } => ErrorClass::RateLimited,
        }
    }
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::RateLimited { retry_after, .. } => *retry_after,
            _ => None,
        }
    }
}

impl TransportError {
    fn msg(&self) -> &str {
        match self {
            Self::Permanent(m) | Self::Temporary(m) | Self::Auth(m) => m,
            Self::RateLimited { msg, .. } => msg,
        }
    }
    /// Leading 3-digit SMTP reply code of the message, when the error came from an SMTP reply
    /// (SMTP errors are formatted `"<code> <text>"`).
    pub fn smtp_code(&self) -> Option<u16> {
        let m = self.msg();
        let d = m.get(..3)?;
        if d.bytes().all(|b| b.is_ascii_digit()) && m.get(3..4).is_none_or(|c| c == " ") {
            d.parse().ok()
        } else {
            None
        }
    }
    /// RFC 3463 enhanced status (`5.1.1`) found in the message text.
    pub fn enhanced_code(&self) -> Option<String> {
        self.msg().split_whitespace().find_map(|w| {
            let w = w.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
            let p: Vec<&str> = w.split('.').collect();
            (p.len() == 3
                && matches!(p[0], "2" | "4" | "5")
                && p.iter()
                    .all(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit())))
            .then(|| w.to_string())
        })
    }
}

impl From<reqwest::Error> for TransportError {
    fn from(e: reqwest::Error) -> Self {
        // Connect/timeout/body errors are all retryable.
        Self::Temporary(format!("http: {e}"))
    }
}

/// Parse a `Retry-After` header given in seconds (HTTP-date form is ignored).
pub(crate) fn retry_after(h: &reqwest::header::HeaderMap) -> Option<Duration> {
    h.get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
        .map(Duration::from_secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smtp_code_and_enhanced_parse() {
        let e = TransportError::Permanent("550 5.1.1 no such user".into());
        assert_eq!(
            (e.smtp_code(), e.enhanced_code().as_deref()),
            (Some(550), Some("5.1.1"))
        );
        let e = TransportError::Permanent("gmail 400: bad".into());
        assert_eq!((e.smtp_code(), e.enhanced_code()), (None, None));
    }
}
