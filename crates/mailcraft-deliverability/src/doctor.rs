//! `mailcraft doctor`: is this host fit to send directly? Port 25 egress, forward-confirmed reverse
//! DNS, DNSBL listings, and the status of the domain's published records.
//! Everything takes a [`Dns`] or an address so tests need no network.
use crate::dns::{
    plan::Plan,
    verify::{self, Dns, DnsError, Status},
};
use serde::Serialize;
use std::{net::IpAddr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Pass,
    /// Worth fixing, does not block.
    Warn,
    /// Blocks activating the `direct` transport.
    Fail,
    /// Could not be determined (resolver blocked, timeout).
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: String,
    pub level: Level,
    pub detail: String,
}

fn chk(name: impl Into<String>, level: Level, detail: impl Into<String>) -> Check {
    Check {
        name: name.into(),
        level,
        detail: detail.into(),
    }
}

/// `direct` transport gate: no Fail anywhere.
pub fn ready_for_direct(checks: &[Check]) -> bool {
    checks.iter().all(|c| c.level != Level::Fail)
}

// ---- port 25 ----------------------------------------------------------------------------------

/// Well-known MX used for the egress probe. Any public MX works; this one answers quickly and
/// does not mind a connect-and-QUIT.
pub const PORT25_PROBE: &str = "gmail-smtp-in.l.google.com:25";

/// Opens a TCP connection to `addr`, expects a `220` greeting, says QUIT. Many clouds (AWS, GCP,
/// Azure, DigitalOcean by default) block outbound 25: that is a Fail for `direct`, fine for relays.
pub async fn port25(addr: &str, wait: Duration) -> Check {
    let name = "port25_egress";
    let r = timeout(wait, async {
        let mut s = TcpStream::connect(addr).await?;
        let mut buf = [0u8; 256];
        let n = s.read(&mut buf).await?;
        let _ = s.write_all(b"QUIT\r\n").await;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&buf[..n]).into_owned())
    })
    .await;
    match r {
        Ok(Ok(banner)) if banner.starts_with("220") => {
            chk(name, Level::Pass, format!("connected to {addr}"))
        }
        Ok(Ok(banner)) => chk(
            name,
            Level::Fail,
            format!(
                "{addr} answered but not with an SMTP greeting ({:?}): a middlebox is intercepting port 25",
                banner.trim()
            ),
        ),
        Ok(Err(e)) => chk(
            name,
            Level::Fail,
            format!(
                "cannot connect to {addr}: {e}. Outbound port 25 is blocked; use a relay transport (587/465)"
            ),
        ),
        Err(_) => chk(
            name,
            Level::Fail,
            format!(
                "connecting to {addr} timed out: outbound port 25 is probably filtered; use a relay transport"
            ),
        ),
    }
}

// ---- FCrDNS -----------------------------------------------------------------------------------

/// Forward-confirmed reverse DNS: PTR(ip) must resolve back to `ip`. `expected_helo`, if given, must
/// be one of the PTR names (HELO == PTR host, SPEC transport `direct`).
pub async fn fcrdns<D: Dns>(dns: &D, ip: IpAddr, expected_helo: Option<&str>) -> Check {
    let name = "fcrdns";
    let names = match dns.ptr(ip).await {
        Ok(v) if !v.is_empty() => v,
        Ok(_) | Err(DnsError::NotFound) => {
            return chk(
                name,
                Level::Fail,
                format!(
                    "no PTR record for {ip}: ask your provider to set reverse DNS to your mail host"
                ),
            );
        }
        Err(DnsError::Failed(e)) => return chk(name, Level::Unknown, e),
    };
    let mut confirmed = Vec::new();
    for n in &names {
        if dns.ip(n).await.is_ok_and(|ips| ips.contains(&ip)) {
            confirmed.push(n.clone());
        }
    }
    if confirmed.is_empty() {
        return chk(
            name,
            Level::Fail,
            format!(
                "PTR of {ip} is {} but none of those names resolve back to {ip}",
                names.join(", ")
            ),
        );
    }
    match expected_helo {
        Some(h) if !confirmed.iter().any(|c| c.eq_ignore_ascii_case(h)) => chk(
            name,
            Level::Warn,
            format!(
                "FCrDNS passes ({}) but your HELO name {h} differs; set HELO to the PTR host",
                confirmed.join(", ")
            ),
        ),
        _ => chk(
            name,
            Level::Pass,
            format!("{ip} <-> {}", confirmed.join(", ")),
        ),
    }
}

// ---- DNSBL ------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct Dnsbl {
    pub name: &'static str,
    pub zone: &'static str,
    pub kind: Kind,
    /// Shown whenever this list is reported, so nobody trusts a "clean" they should not.
    pub caveat: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Ip,
    Domain,
}

pub const SPAMHAUS_ZEN: Dnsbl = Dnsbl {
    name: "Spamhaus ZEN",
    zone: "zen.spamhaus.org",
    kind: Kind::Ip,
    caveat: "Spamhaus free DNSBL use needs your OWN recursive resolver and low volume (their terms: under ~300k queries/day, non-commercial). Public resolvers (8.8.8.8, 1.1.1.1, most ISP/cloud resolvers) are refused with 127.255.255.254, which we report as unknown, not clean.",
};
pub const SPAMHAUS_DBL: Dnsbl = Dnsbl {
    name: "Spamhaus DBL",
    zone: "dbl.spamhaus.org",
    kind: Kind::Domain,
    caveat: "same resolver and volume terms as ZEN",
};
pub const BARRACUDA: Dnsbl = Dnsbl {
    name: "Barracuda BRBL",
    zone: "b.barracudacentral.org",
    kind: Kind::Ip,
    caveat: "Barracuda requires a free registration of your resolver's IP before it answers; unregistered queries return nothing, which looks clean. Treat clean as weak evidence.",
};

pub const DEFAULT_LISTS: [Dnsbl; 3] = [SPAMHAUS_ZEN, SPAMHAUS_DBL, BARRACUDA];

fn dnsbl_query_name(ip: IpAddr, zone: &str) -> Option<String> {
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            Some(format!("{}.{}.{}.{}.{zone}", o[3], o[2], o[1], o[0]))
        }
        // Spamhaus ZEN and Barracuda IPv6 support differs; skip rather than guess.
        IpAddr::V6(_) => None,
    }
}

/// Meaning of a Spamhaus return code.
fn spamhaus_meaning(code: &str) -> (&'static str, Level) {
    match code {
        "127.0.0.2" | "127.0.0.3" | "127.0.0.9" => ("SBL (spam source / DROP)", Level::Fail),
        "127.0.0.4" | "127.0.0.5" | "127.0.0.6" | "127.0.0.7" => {
            ("XBL (exploited or botnet host)", Level::Fail)
        }
        "127.0.0.10" | "127.0.0.11" => (
            "PBL (policy block: dynamic/residential range, not meant to send mail directly)",
            Level::Fail,
        ),
        "127.0.1.2" => ("DBL: spam domain", Level::Fail),
        "127.0.1.4" => ("DBL: phishing domain", Level::Fail),
        "127.0.1.5" => ("DBL: malware domain", Level::Fail),
        "127.0.1.6" => ("DBL: botnet C&C domain", Level::Fail),
        c if c.starts_with("127.0.1.10") => ("DBL: abused legit domain", Level::Warn),
        _ => ("listed (see the list's lookup page)", Level::Fail),
    }
}

/// Look `subject` (an IP or a domain, per `list.kind`) up in `list`.
pub async fn dnsbl<D: Dns>(dns: &D, list: &Dnsbl, subject: &str) -> Check {
    let name = format!("dnsbl:{}", list.name);
    let q = match (list.kind, subject.parse::<IpAddr>()) {
        (Kind::Ip, Ok(ip)) => match dnsbl_query_name(ip, list.zone) {
            Some(q) => q,
            None => return chk(name, Level::Unknown, "IPv6 not checked for this list"),
        },
        (Kind::Ip, Err(_)) => {
            return chk(
                name,
                Level::Unknown,
                format!("{subject} is not an IP address"),
            );
        }
        (Kind::Domain, _) => format!("{}.{}", subject.trim_end_matches('.'), list.zone),
    };
    match dns.ip(&q).await {
        Err(DnsError::NotFound) => chk(
            name,
            Level::Pass,
            format!("{subject} not listed. Note: {}", list.caveat),
        ),
        Err(DnsError::Failed(e)) => chk(name, Level::Unknown, format!("lookup failed: {e}")),
        Ok(ips) => {
            let codes: Vec<String> = ips.iter().map(|i| i.to_string()).collect();
            if codes.iter().any(|c| c.starts_with("127.255.255.")) {
                return chk(
                    name,
                    Level::Unknown,
                    format!(
                        "{} refused the query ({}): {}",
                        list.name,
                        codes.join(","),
                        list.caveat
                    ),
                );
            }
            if list.zone.contains("spamhaus") {
                let worst = codes
                    .iter()
                    .map(|c| spamhaus_meaning(c))
                    .max_by_key(|m| (m.1 == Level::Fail) as u8)
                    .unwrap_or(("listed", Level::Fail));
                chk(
                    name,
                    worst.1,
                    format!("{subject} is listed: {} [{}]", worst.0, codes.join(",")),
                )
            } else {
                chk(
                    name,
                    Level::Fail,
                    format!("{subject} is listed [{}]", codes.join(",")),
                )
            }
        }
    }
}

// ---- records ----------------------------------------------------------------------------------

/// Status of the domain's published records, one doctor check per record, plus an overall summary.
pub async fn records<D: Dns>(dns: &D, plan: &Plan, now_unix: u64) -> Vec<Check> {
    verify::verify(dns, plan, now_unix)
        .await
        .into_iter()
        .map(|c| {
            let level = match c.status {
                Status::Ok => Level::Pass,
                // DMARC is a warning, everything else blocks sending [D section 9].
                _ if c.purpose == crate::dns::plan::Purpose::Dmarc => Level::Warn,
                Status::Propagating => Level::Warn,
                Status::Error => Level::Unknown,
                Status::Missing | Status::Wrong => Level::Fail,
            };
            chk(
                format!("record:{}:{}", c.rtype.as_str(), c.name),
                level,
                c.hint,
            )
        })
        .collect()
}

/// Full direct-sending doctor run. `plan` is optional (host checks only without it).
pub async fn run<D: Dns>(
    dns: &D,
    ip: IpAddr,
    helo: Option<&str>,
    plan: Option<&Plan>,
    now_unix: u64,
    probe_addr: &str,
) -> Vec<Check> {
    let mut out = vec![
        port25(probe_addr, Duration::from_secs(8)).await,
        fcrdns(dns, ip, helo).await,
    ];
    out.push(dnsbl(dns, &SPAMHAUS_ZEN, &ip.to_string()).await);
    out.push(dnsbl(dns, &BARRACUDA, &ip.to_string()).await);
    if let Some(p) = plan {
        out.push(dnsbl(dns, &SPAMHAUS_DBL, &p.sending_domain).await);
        out.extend(records(dns, p, now_unix).await);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Mock {
        ptr: HashMap<IpAddr, Result<Vec<String>, DnsError>>,
        ip: HashMap<String, Result<Vec<IpAddr>, DnsError>>,
    }
    impl Dns for Mock {
        async fn txt(&self, _: &str) -> Result<Vec<String>, DnsError> {
            Err(DnsError::NotFound)
        }
        async fn cname(&self, _: &str) -> Result<Vec<String>, DnsError> {
            Err(DnsError::NotFound)
        }
        async fn mx(&self, _: &str) -> Result<Vec<String>, DnsError> {
            Err(DnsError::NotFound)
        }
        async fn ip(&self, n: &str) -> Result<Vec<IpAddr>, DnsError> {
            self.ip.get(n).cloned().unwrap_or(Err(DnsError::NotFound))
        }
        async fn ptr(&self, ip: IpAddr) -> Result<Vec<String>, DnsError> {
            self.ptr
                .get(&ip)
                .cloned()
                .unwrap_or(Err(DnsError::NotFound))
        }
    }
    const IP: &str = "203.0.113.5";

    #[tokio::test]
    async fn fcrdns_cases() {
        let ip: IpAddr = IP.parse().unwrap();
        let mut m = Mock::default();
        assert_eq!(fcrdns(&m, ip, None).await.level, Level::Fail, "no PTR");
        m.ptr.insert(ip, Ok(vec!["mx.example.com".into()]));
        assert_eq!(
            fcrdns(&m, ip, None).await.level,
            Level::Fail,
            "PTR does not resolve back"
        );
        m.ip.insert(
            "mx.example.com".into(),
            Ok(vec!["198.51.100.1".parse().unwrap()]),
        );
        assert_eq!(
            fcrdns(&m, ip, None).await.level,
            Level::Fail,
            "resolves to another IP"
        );
        m.ip.insert("mx.example.com".into(), Ok(vec![ip]));
        assert_eq!(
            fcrdns(&m, ip, Some("mx.example.com")).await.level,
            Level::Pass
        );
        let w = fcrdns(&m, ip, Some("other.example.com")).await;
        assert_eq!(w.level, Level::Warn);
        assert!(w.detail.contains("HELO"));
    }

    #[tokio::test]
    async fn dnsbl_cases() {
        let mut m = Mock::default();
        let q = "5.113.0.203.zen.spamhaus.org";
        let c = dnsbl(&m, &SPAMHAUS_ZEN, IP).await;
        assert_eq!(c.level, Level::Pass);
        assert!(
            c.detail.contains("OWN recursive resolver"),
            "low-volume caveat shown: {}",
            c.detail
        );
        m.ip.insert(q.into(), Ok(vec!["127.0.0.2".parse().unwrap()]));
        let c = dnsbl(&m, &SPAMHAUS_ZEN, IP).await;
        assert_eq!(c.level, Level::Fail);
        assert!(c.detail.contains("SBL"));
        m.ip.insert(q.into(), Ok(vec!["127.0.0.11".parse().unwrap()]));
        assert!(dnsbl(&m, &SPAMHAUS_ZEN, IP).await.detail.contains("PBL"));
        // public-resolver refusal is unknown, never a clean pass nor a listing
        m.ip.insert(q.into(), Ok(vec!["127.255.255.254".parse().unwrap()]));
        let c = dnsbl(&m, &SPAMHAUS_ZEN, IP).await;
        assert_eq!(c.level, Level::Unknown);
        m.ip.insert(q.into(), Err(DnsError::Failed("timeout".into())));
        assert_eq!(dnsbl(&m, &SPAMHAUS_ZEN, IP).await.level, Level::Unknown);
        // barracuda + DBL naming
        m.ip.insert(
            "5.113.0.203.b.barracudacentral.org".into(),
            Ok(vec!["127.0.0.2".parse().unwrap()]),
        );
        assert_eq!(dnsbl(&m, &BARRACUDA, IP).await.level, Level::Fail);
        m.ip.insert(
            "mail.example.com.dbl.spamhaus.org".into(),
            Ok(vec!["127.0.1.2".parse().unwrap()]),
        );
        assert_eq!(
            dnsbl(&m, &SPAMHAUS_DBL, "mail.example.com").await.level,
            Level::Fail
        );
    }

    #[tokio::test]
    async fn port25_probe_against_local_listener() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            s.write_all(b"220 test ESMTP\r\n").await.unwrap();
        });
        assert_eq!(
            port25(&addr, Duration::from_secs(2)).await.level,
            Level::Pass
        );
        // nothing listening -> fail with the relay hint
        let c = port25("127.0.0.1:1", Duration::from_secs(2)).await;
        assert_eq!(c.level, Level::Fail);
        assert!(c.detail.contains("relay"));
        // not an SMTP greeting
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            s.write_all(b"HTTP/1.1 200\r\n").await.unwrap();
        });
        assert_eq!(
            port25(&addr, Duration::from_secs(2)).await.level,
            Level::Fail
        );
    }

    #[test]
    fn gate() {
        assert!(ready_for_direct(&[
            chk("a", Level::Warn, ""),
            chk("b", Level::Unknown, "")
        ]));
        assert!(!ready_for_direct(&[chk("a", Level::Fail, "")]));
    }
}
