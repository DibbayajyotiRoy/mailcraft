//! Destination mailbox-provider classification (warm-up and block pauses are tracked per provider).

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Gmail,
    Microsoft,
    Yahoo,
    Apple,
    /// Any other recipient domain (lowercased); tracked per domain.
    Other(String),
}

impl Provider {
    pub fn from_domain(domain: &str) -> Self {
        let d = domain.trim().trim_end_matches('.').to_ascii_lowercase();
        match d.as_str() {
            "gmail.com" | "googlemail.com" => Self::Gmail,
            "outlook.com" | "hotmail.com" | "live.com" | "msn.com" => Self::Microsoft,
            "ymail.com" | "rocketmail.com" | "aol.com" => Self::Yahoo,
            "icloud.com" | "me.com" | "mac.com" => Self::Apple,
            _ if d.starts_with("yahoo.") => Self::Yahoo,
            _ if d.starts_with("hotmail.")
                || d.starts_with("outlook.")
                || d.starts_with("live.") =>
            {
                Self::Microsoft
            }
            _ => Self::Other(d),
        }
    }

    pub fn from_address(addr: &str) -> Self {
        Self::from_domain(addr.rsplit_once('@').map_or(addr, |x| x.1))
    }

    /// For custom domains hosted at a big provider: classify by MX host.
    // ponytail: suffix list only; extend when a hosted-domain miss shows up in metrics.
    pub fn from_mx_host(mx: &str, fallback_domain: &str) -> Self {
        let m = mx.trim_end_matches('.').to_ascii_lowercase();
        if m.ends_with(".google.com") || m.ends_with(".googlemail.com") {
            Self::Gmail
        } else if m.ends_with(".protection.outlook.com") || m.ends_with(".outlook.com") {
            Self::Microsoft
        } else if m.ends_with(".yahoodns.net") {
            Self::Yahoo
        } else {
            Self::from_domain(fallback_domain)
        }
    }

    pub fn key(&self) -> String {
        match self {
            Self::Gmail => "gmail".into(),
            Self::Microsoft => "microsoft".into(),
            Self::Yahoo => "yahoo".into(),
            Self::Apple => "apple".into(),
            Self::Other(d) => format!("other:{d}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classify() {
        assert_eq!(Provider::from_address("a@Gmail.com"), Provider::Gmail);
        assert_eq!(Provider::from_domain("yahoo.co.uk"), Provider::Yahoo);
        assert_eq!(
            Provider::from_mx_host("aspmx.l.google.com.", "corp.test"),
            Provider::Gmail
        );
        assert_eq!(
            Provider::from_domain("corp.test"),
            Provider::Other("corp.test".into())
        );
    }
}
