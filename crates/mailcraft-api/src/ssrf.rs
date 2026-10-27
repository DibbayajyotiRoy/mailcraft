//! SSRF guard for outbound webhook fetches (SPEC 14): block loopback, private, link-local,
//! CGNAT and metadata ranges; resolve once and pin the connection to the checked address.
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use mailcraft_core::Error;

pub fn ip_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v4_blocked(v),
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return v4_blocked(m);
            }
            v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (v.segments()[0] & 0xfe00) == 0xfc00 // unique local
                || (v.segments()[0] & 0xffc0) == 0xfe80 // link local
        }
    }
}

fn v4_blocked(v: Ipv4Addr) -> bool {
    let o = v.octets();
    v.is_private()
        || v.is_loopback()
        || v.is_link_local()
        || v.is_unspecified()
        || v.is_broadcast()
        || v.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (64..128).contains(&o[1])) // CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
}

/// Static checks on a URL a user registers. Returns host and port.
pub fn check_url(url: &str, allow_private: bool) -> Result<(String, u16), Error> {
    let bad = |m: &str| Error::new("invalid_request", 400, m.to_string()).field("url");
    let u = reqwest::Url::parse(url).map_err(|_| bad("url is not a valid absolute URL"))?;
    if !matches!(u.scheme(), "https" | "http") {
        return Err(bad("url must be http(s)"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(bad("url must not contain credentials"));
    }
    let host = u
        .host_str()
        .ok_or_else(|| bad("url has no host"))?
        .to_string();
    if !allow_private {
        if u.scheme() != "https" {
            return Err(bad("url must use https")
                .hint("plain http is only allowed in dev (MAILCRAFT_ALLOW_PRIVATE_WEBHOOKS=1)"));
        }
        let h = host.to_ascii_lowercase();
        if h == "localhost"
            || h.ends_with(".localhost")
            || h.ends_with(".local")
            || h.ends_with(".internal")
        {
            return Err(bad("url host is not allowed"));
        }
        if let Ok(ip) = h.trim_matches(['[', ']']).parse::<IpAddr>() {
            if ip_blocked(ip) {
                return Err(bad("url points at a private or reserved address"));
            }
        }
    }
    Ok((host, u.port_or_known_default().unwrap_or(443)))
}

/// Resolves the host and rejects if any address is private. Returns the address to pin.
pub async fn resolve_checked(
    host: &str,
    port: u16,
    allow_private: bool,
) -> Result<SocketAddr, Error> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| {
            Error::new(
                "webhook_dns_failed",
                502,
                format!("cannot resolve {host}: {e}"),
            )
            .retryable()
        })?
        .collect();
    if addrs.is_empty() || (!allow_private && addrs.iter().any(|a| ip_blocked(a.ip()))) {
        return Err(Error::new(
            "webhook_blocked_target",
            400,
            "target resolves to a private or reserved address",
        ));
    }
    Ok(addrs[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_targets() {
        for ip in [
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fd00::1",
            "::ffff:10.0.0.1",
            "0.0.0.0",
        ] {
            assert!(ip_blocked(ip.parse().unwrap()), "{ip}");
        }
        assert!(!ip_blocked("93.184.216.34".parse().unwrap()));
        assert!(check_url("https://localhost/x", false).is_err());
        assert!(check_url("https://127.0.0.1/x", false).is_err());
        assert!(check_url("http://example.com/x", false).is_err());
        assert!(check_url("https://u:p@example.com/", false).is_err());
        assert!(check_url("https://example.com/hook", false).is_ok());
        assert!(check_url("http://127.0.0.1:9/x", true).is_ok());
    }
}
