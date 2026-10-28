//! Verifier: checks each planned record against live DNS, via a mockable `Dns` trait.
use crate::dns::plan::{Plan, Purpose, RType, Record};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsError {
    /// NXDOMAIN / NODATA.
    NotFound,
    Failed(String),
}

/// Minimal resolver surface. All names are FQDNs without trailing dot; results are lowercase-free raw
/// strings (CNAME/MX targets without trailing dot; MX as "pref host"; TXT strings already joined).
#[allow(async_fn_in_trait)] // generic use only (no dyn, no spawn); keep it simple
pub trait Dns {
    async fn txt(&self, name: &str) -> Result<Vec<String>, DnsError>;
    async fn cname(&self, name: &str) -> Result<Vec<String>, DnsError>;
    async fn mx(&self, name: &str) -> Result<Vec<String>, DnsError>;
    /// A/AAAA addresses of `name` (used by `doctor` for FCrDNS and DNSBL lookups).
    async fn ip(&self, _name: &str) -> Result<Vec<std::net::IpAddr>, DnsError> {
        Err(DnsError::Failed(
            "ip lookups not supported by this resolver".into(),
        ))
    }
    /// PTR names of `ip`, without trailing dots.
    async fn ptr(&self, _ip: std::net::IpAddr) -> Result<Vec<String>, DnsError> {
        Err(DnsError::Failed(
            "ptr lookups not supported by this resolver".into(),
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Missing,
    Wrong,
    /// Missing/wrong but the plan is younger than `PROPAGATION_MIN`.
    Propagating,
    /// Resolver error (timeout, SERVFAIL).
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: String,
    pub rtype: RType,
    pub purpose: Purpose,
    pub status: Status,
    pub hint: String,
    /// What DNS actually returns at the name, when the record is wrong (or still propagating).
    pub found: Option<String>,
}

pub const PROPAGATION_MIN: u64 = 30;

fn ok(hint: &str) -> (Status, String) {
    (Status::Ok, hint.into())
}
fn wrong(hint: String) -> (Status, String) {
    (Status::Wrong, hint)
}

fn tags(v: &str) -> Vec<(String, String)> {
    v.split(';')
        .filter_map(|t| t.split_once('='))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect()
}
fn tag<'a>(t: &'a [(String, String)], k: &str) -> Option<&'a str> {
    t.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
}
fn norm_host(h: &str) -> String {
    h.trim_end_matches('.').to_ascii_lowercase()
}
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

async fn check_one<D: Dns>(dns: &D, r: &Record, alt: &[Record]) -> (Status, String) {
    use DnsError::*;
    match r.purpose {
        Purpose::DkimCname => {
            let (st, hint) = check_cname(dns, r).await;
            if st != Status::Ok {
                return (st, hint);
            }
            check_dkim_target(dns, r, alt).await
        }
        Purpose::MtaStsHost => check_cname(dns, r).await,
        Purpose::ReturnPathMx => match dns.mx(&r.name).await {
            Err(NotFound) => (Status::Missing, format!("no MX at {}", r.name)),
            Err(Failed(e)) => (Status::Error, e),
            Ok(v) => {
                let hosts: Vec<String> = v
                    .iter()
                    .filter_map(|m| m.split_whitespace().last())
                    .map(norm_host)
                    .collect();
                if hosts.contains(&norm_host(&r.value)) {
                    ok("MX correct")
                } else if hosts.is_empty() {
                    (Status::Missing, format!("no MX at {}", r.name))
                } else {
                    wrong(format!(
                        "MX points to {}, expected {}",
                        hosts.join(", "),
                        r.value
                    ))
                }
            }
        },
        _ => match dns.txt(&r.name).await {
            Err(NotFound) => (Status::Missing, format!("no TXT at {}", r.name)),
            Err(Failed(e)) => (Status::Error, e),
            Ok(v) => check_txt(r, &v),
        },
    }
}

async fn check_cname<D: Dns>(dns: &D, r: &Record) -> (Status, String) {
    use DnsError::*;
    match dns.cname(&r.name).await {
        Err(NotFound) => (Status::Missing, format!("no CNAME at {}", r.name)),
        Err(Failed(e)) => (Status::Error, e),
        Ok(v) => match v.first() {
            Some(t) if norm_host(t) == norm_host(&r.value) => ok("CNAME correct"),
            Some(t) => wrong(format!(
                "CNAME points to {}, expected {}",
                norm_host(t),
                r.value
            )),
            None => (Status::Missing, format!("no CNAME at {}", r.name)),
        },
    }
}

/// The CNAME is only half of DKIM delegation: the target must serve a `v=DKIM1` TXT, and when we
/// know the key we generated (the plan's direct-TXT alternative) its `p=` must match.
async fn check_dkim_target<D: Dns>(dns: &D, r: &Record, alt: &[Record]) -> (Status, String) {
    use DnsError::*;
    let target = norm_host(&r.value);
    let txts = match dns.txt(&target).await {
        Err(NotFound) => {
            return wrong(format!(
                "CNAME ok, but {target} has no DKIM TXT (the instance is not serving this selector)"
            ));
        }
        Err(Failed(e)) => return (Status::Error, e),
        Ok(v) => v,
    };
    let Some(rec) = txts
        .iter()
        .find(|t| t.contains("DKIM1") && tag(&tags(t), "p").is_some())
    else {
        return wrong(format!(
            "CNAME ok, but TXT at {target} is not a DKIM key record"
        ));
    };
    let got = tags(rec);
    if tag(&got, "p").is_none_or(str::is_empty) {
        return wrong(format!(
            "DKIM key at {target} is revoked or empty (p= is empty)"
        ));
    }
    if let Some(want) = alt.iter().find(|a| a.name == r.name)
        && tag(&got, "p") != tag(&tags(&want.value), "p")
    {
        return wrong(format!(
            "DKIM key served at {target} differs from this domain's generated key"
        ));
    }
    ok("CNAME correct, target serves the DKIM key")
}

fn check_txt(r: &Record, found: &[String]) -> (Status, String) {
    let prefix = r.value.split([';', ' ']).next().unwrap_or("");
    let cand: Vec<&String> = found
        .iter()
        .filter(|t| t.trim_start().starts_with(prefix))
        .collect();
    if cand.is_empty() {
        return (
            Status::Missing,
            format!("TXT at {} has no {prefix} record", r.name),
        );
    }
    if cand.len() > 1 && r.purpose == Purpose::ReturnPathSpf {
        return wrong("multiple SPF records at the name (permerror); keep exactly one".into());
    }
    let got = cand[0];
    match r.purpose {
        Purpose::ReturnPathSpf => {
            let have: Vec<&str> = got.split_whitespace().collect();
            for m in r.value.split(' ').filter(|m| m.contains(':')) {
                if !have.contains(&m) {
                    let what = if m.starts_with("include:") {
                        "include"
                    } else {
                        "ip"
                    };
                    return wrong(format!("SPF {what} missing: {m}"));
                }
            }
            ok("SPF correct")
        }
        Purpose::DkimTxt => {
            let (g, w) = (tags(got), tags(&r.value));
            if tag(&g, "p") == tag(&w, "p") {
                ok("DKIM key matches")
            } else {
                wrong("DKIM p= differs from the generated key (stale or truncated paste)".into())
            }
        }
        Purpose::Dmarc => {
            let g = tags(got);
            match (tag(&g, "p"), tag(&tags(&r.value), "rua")) {
                (None, _) => wrong("DMARC has no p= tag".into()),
                (_, Some(rua)) if !tag(&g, "rua").is_some_and(|x| x.contains(rua)) => {
                    wrong(format!("DMARC rua missing, expected {rua}"))
                }
                _ => ok("DMARC present"),
            }
        }
        _ => {
            if squash(got) == squash(&r.value) {
                ok("TXT correct")
            } else {
                wrong(format!("TXT is `{got}`, expected `{}`", r.value))
            }
        }
    }
}

/// The live value at a record's name, for diagnostics. `None` when nothing resolves.
async fn found_value<D: Dns>(dns: &D, r: &Record) -> Option<String> {
    let v = match r.purpose {
        Purpose::DkimCname | Purpose::MtaStsHost => dns.cname(&r.name).await,
        Purpose::ReturnPathMx => dns.mx(&r.name).await,
        _ => dns.txt(&r.name).await,
    }
    .ok()?;
    (!v.is_empty()).then(|| v.join(" | "))
}

/// Check every record of the plan. `now_unix` drives the "propagating" hint.
pub async fn verify<D: Dns>(dns: &D, plan: &Plan, now_unix: u64) -> Vec<Check> {
    let age_min = now_unix.saturating_sub(plan.created_unix) / 60;
    let mut out = Vec::new();
    for r in &plan.records {
        let (mut status, mut hint) = check_one(dns, r, &plan.dkim_txt_alternative).await;
        if matches!(status, Status::Missing | Status::Wrong) && age_min < PROPAGATION_MIN {
            hint = format!(
                "propagating, retry in {} min ({hint})",
                PROPAGATION_MIN - age_min
            );
            status = Status::Propagating;
        }
        let found = if matches!(status, Status::Wrong | Status::Propagating) {
            found_value(dns, r).await
        } else {
            None
        };
        out.push(Check {
            found,
            name: r.name.clone(),
            rtype: r.rtype,
            purpose: r.purpose,
            status,
            hint,
        });
    }
    out
}

pub fn all_ok(c: &[Check]) -> bool {
    c.iter().all(|c| c.status == Status::Ok)
}

pub fn render_checks(c: &[Check]) -> String {
    let mut s = String::new();
    for k in c {
        let tag = match k.status {
            Status::Ok => "OK  ",
            Status::Missing => "MISS",
            Status::Wrong => "WRONG",
            Status::Propagating => "WAIT",
            Status::Error => "ERR ",
        };
        s += &format!("{tag:<5} {:<5} {}  {}\n", k.rtype.as_str(), k.name, k.hint);
    }
    s
}

/// `1.2.3.4` -> `4.3.2.1.in-addr.arpa`; IPv6 -> nibble-reversed `ip6.arpa`.
pub fn reverse_name(ip: std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(a) => {
            let o = a.octets();
            format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
        }
        std::net::IpAddr::V6(a) => {
            let nibbles: Vec<String> = a
                .octets()
                .iter()
                .rev()
                .flat_map(|b| [format!("{:x}", b & 0xf), format!("{:x}", b >> 4)])
                .collect();
            format!("{}.ip6.arpa", nibbles.join("."))
        }
    }
}

// ---- real resolver -------------------------------------------------------------------------

pub struct HickoryDns(hickory_resolver::TokioResolver);

impl HickoryDns {
    pub fn system() -> Result<Self, String> {
        let b = hickory_resolver::TokioResolver::builder_tokio().map_err(|e| e.to_string())?;
        Ok(Self(b.build().map_err(|e| e.to_string())?))
    }

    async fn q(
        &self,
        name: &str,
        t: hickory_resolver::proto::rr::RecordType,
    ) -> Result<Vec<hickory_resolver::proto::rr::RData>, DnsError> {
        match self.0.lookup(format!("{name}."), t).await {
            Ok(l) => Ok(l.answers().iter().map(|r| r.data.clone()).collect()),
            Err(e) if e.is_no_records_found() => Err(DnsError::NotFound),
            Err(e) => Err(DnsError::Failed(e.to_string())),
        }
    }
}

impl Dns for HickoryDns {
    async fn txt(&self, name: &str) -> Result<Vec<String>, DnsError> {
        use hickory_resolver::proto::rr::{RData, RecordType};
        Ok(self
            .q(name, RecordType::TXT)
            .await?
            .into_iter()
            .filter_map(|d| match d {
                RData::TXT(t) => Some(
                    t.txt_data
                        .iter()
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .collect::<String>(),
                ),
                _ => None,
            })
            .collect())
    }
    async fn cname(&self, name: &str) -> Result<Vec<String>, DnsError> {
        use hickory_resolver::proto::rr::{RData, RecordType};
        Ok(self
            .q(name, RecordType::CNAME)
            .await?
            .into_iter()
            .filter_map(|d| match d {
                RData::CNAME(c) => Some(c.0.to_string()),
                _ => None,
            })
            .collect())
    }
    async fn ip(&self, name: &str) -> Result<Vec<std::net::IpAddr>, DnsError> {
        use hickory_resolver::proto::rr::{RData, RecordType};
        let mut out = Vec::new();
        for t in [RecordType::A, RecordType::AAAA] {
            match self.q(name, t).await {
                Ok(v) => out.extend(v.into_iter().filter_map(|d| match d {
                    RData::A(a) => Some(std::net::IpAddr::V4(a.0)),
                    RData::AAAA(a) => Some(std::net::IpAddr::V6(a.0)),
                    _ => None,
                })),
                Err(DnsError::NotFound) => {}
                Err(e) => return Err(e),
            }
        }
        if out.is_empty() {
            Err(DnsError::NotFound)
        } else {
            Ok(out)
        }
    }
    async fn ptr(&self, ip: std::net::IpAddr) -> Result<Vec<String>, DnsError> {
        use hickory_resolver::proto::rr::{RData, RecordType};
        Ok(self
            .q(&reverse_name(ip), RecordType::PTR)
            .await?
            .into_iter()
            .filter_map(|d| match d {
                RData::PTR(p) => Some(p.0.to_string().trim_end_matches('.').to_string()),
                _ => None,
            })
            .collect())
    }
    async fn mx(&self, name: &str) -> Result<Vec<String>, DnsError> {
        use hickory_resolver::proto::rr::{RData, RecordType};
        Ok(self
            .q(name, RecordType::MX)
            .await?
            .into_iter()
            .filter_map(|d| match d {
                RData::MX(m) => Some(format!("{} {}", m.preference, m.exchange)),
                _ => None,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dns::plan::{Instance, Options, plan};
    use crate::keys::{Algo, DkimKey};
    use std::collections::HashMap;

    #[test]
    fn reverse_names() {
        assert_eq!(
            reverse_name("203.0.113.5".parse().unwrap()),
            "5.113.0.203.in-addr.arpa"
        );
        assert_eq!(
            reverse_name("2001:db8::1".parse().unwrap()),
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa"
        );
    }

    #[derive(Default)]
    struct Mock(HashMap<(&'static str, String), Result<Vec<String>, DnsError>>);
    impl Mock {
        fn with(mut self, k: &'static str, n: &str, v: &[&str]) -> Self {
            self.0
                .insert((k, n.into()), Ok(v.iter().map(|s| s.to_string()).collect()));
            self
        }
        fn get(&self, k: &'static str, n: &str) -> Result<Vec<String>, DnsError> {
            self.0
                .get(&(k, n.to_string()))
                .cloned()
                .unwrap_or(Err(DnsError::NotFound))
        }
    }
    impl Dns for Mock {
        async fn txt(&self, n: &str) -> Result<Vec<String>, DnsError> {
            self.get("txt", n)
        }
        async fn cname(&self, n: &str) -> Result<Vec<String>, DnsError> {
            self.get("cname", n)
        }
        async fn mx(&self, n: &str) -> Result<Vec<String>, DnsError> {
            self.get("mx", n)
        }
    }

    fn the_plan() -> Plan {
        let k = DkimKey {
            selector: "mc2026a".into(),
            algo: Algo::Ed25519,
            private_pem: String::new(),
            public_b64: "AAAA".into(),
        };
        let i = Instance {
            domain: Some("mc.example.net".into()),
            mx_host: "mx.mc.example.net".into(),
            ips: vec![],
        };
        let o = Options {
            dmarc_rua: Some("d@example.com".into()),
            ..Default::default()
        };
        plan("example.com", true, &i, &[k], &o, 1_000_000).unwrap()
    }
    fn good() -> Mock {
        Mock::default()
            .with(
                "cname",
                "mc2026a._domainkey.mail.example.com",
                &["mc2026a.mail.example.com.dkim.mc.example.net."],
            )
            .with(
                "txt",
                "mc2026a.mail.example.com.dkim.mc.example.net",
                &["v=DKIM1; k=ed25519; p=AAAA"],
            )
            .with("mx", "bounces.mail.example.com", &["10 mx.mc.example.net."])
            .with(
                "txt",
                "bounces.mail.example.com",
                &["v=spf1 include:_spf.mc.example.net ~all"],
            )
            .with(
                "txt",
                "_dmarc.mail.example.com",
                &["v=DMARC1; p=quarantine; rua=mailto:d@example.com"],
            )
    }
    const LATE: u64 = 1_000_000 + 3600;
    async fn st(m: Mock) -> Vec<Check> {
        verify(&m, &the_plan(), LATE).await
    }

    #[tokio::test]
    async fn all_good() {
        let c = st(good()).await;
        assert!(all_ok(&c), "{}", render_checks(&c));
    }

    #[tokio::test]
    async fn precise_hints() {
        let m = good()
            .with(
                "cname",
                "mc2026a._domainkey.mail.example.com",
                &["other.dkim.evil.net."],
            )
            .with(
                "txt",
                "bounces.mail.example.com",
                &["v=spf1 include:sendgrid.net ~all"],
            )
            .with("mx", "bounces.mail.example.com", &["10 mail.old.com."]);
        let c = st(m).await;
        assert_eq!(
            c[0].hint,
            "CNAME points to other.dkim.evil.net, expected mc2026a.mail.example.com.dkim.mc.example.net"
        );
        assert_eq!(
            c[1].hint,
            "MX points to mail.old.com, expected mx.mc.example.net"
        );
        assert_eq!(
            c[2].hint,
            "SPF include missing: include:_spf.mc.example.net"
        );
        assert!(c[..3].iter().all(|c| c.status == Status::Wrong));
        // `found` carries what DNS actually returned; healthy records carry none.
        assert_eq!(c[0].found.as_deref(), Some("other.dkim.evil.net."));
        assert_eq!(c[1].found.as_deref(), Some("10 mail.old.com."));
        assert_eq!(
            c[2].found.as_deref(),
            Some("v=spf1 include:sendgrid.net ~all")
        );
        assert!(c[3..].iter().all(|c| c.found.is_none()));
    }

    #[tokio::test]
    async fn dmarc_rua_and_missing() {
        let m = good().with("txt", "_dmarc.mail.example.com", &["v=DMARC1; p=none"]);
        assert_eq!(
            st(m).await[3].hint,
            "DMARC rua missing, expected mailto:d@example.com"
        );
        let mut m = good();
        m.0.remove(&("txt", "_dmarc.mail.example.com".into()));
        let c = st(m).await;
        assert_eq!(c[3].status, Status::Missing);
    }

    #[tokio::test]
    async fn young_plan_reports_propagating() {
        let c = verify(&Mock::default(), &the_plan(), 1_000_000 + 10 * 60).await;
        assert!(c.iter().all(|c| c.status == Status::Propagating));
        assert!(
            c[0].hint.starts_with("propagating, retry in 20 min"),
            "{}",
            c[0].hint
        );
    }

    #[tokio::test]
    async fn duplicate_spf_and_resolver_error() {
        let m = good().with(
            "txt",
            "bounces.mail.example.com",
            &["v=spf1 a ~all", "v=spf1 include:_spf.mc.example.net ~all"],
        );
        assert!(st(m).await[2].hint.contains("multiple SPF"));
        let mut m = good();
        m.0.insert(
            ("mx", "bounces.mail.example.com".into()),
            Err(DnsError::Failed("timeout".into())),
        );
        assert_eq!(st(m).await[1].status, Status::Error);
    }

    #[tokio::test]
    async fn dkim_cname_is_followed_to_the_target_txt() {
        // target missing -> wrong, not ok
        let mut m = good();
        m.0.remove(&("txt", "mc2026a.mail.example.com.dkim.mc.example.net".into()));
        let c = st(m).await;
        assert_eq!(c[0].status, Status::Wrong);
        assert!(c[0].hint.contains("has no DKIM TXT"), "{}", c[0].hint);
        // target serves a different key
        let m = good().with(
            "txt",
            "mc2026a.mail.example.com.dkim.mc.example.net",
            &["v=DKIM1; k=ed25519; p=BBBB"],
        );
        assert!(
            st(m).await[0]
                .hint
                .contains("differs from this domain's generated key")
        );
        // revoked key
        let m = good().with(
            "txt",
            "mc2026a.mail.example.com.dkim.mc.example.net",
            &["v=DKIM1; k=ed25519; p="],
        );
        assert!(st(m).await[0].hint.contains("revoked"));
        // not a DKIM record
        let m = good().with(
            "txt",
            "mc2026a.mail.example.com.dkim.mc.example.net",
            &["hello"],
        );
        assert!(st(m).await[0].hint.contains("not a DKIM key record"));
    }

    #[tokio::test]
    async fn dkim_txt_key_mismatch() {
        let k = DkimKey {
            selector: "mc2026a".into(),
            algo: Algo::Ed25519,
            private_pem: String::new(),
            public_b64: "AAAA".into(),
        };
        let i = Instance {
            domain: None,
            mx_host: "mx.x.org".into(),
            ips: vec!["203.0.113.5".parse().unwrap()],
        };
        let p = plan("example.com", true, &i, &[k], &Options::default(), 0).unwrap();
        let m = Mock::default().with(
            "txt",
            "mc2026a._domainkey.mail.example.com",
            &["v=DKIM1; k=ed25519; p=BBBB"],
        );
        assert!(verify(&m, &p, 99999).await[0].hint.contains("p= differs"));
    }
}
