//! Record planner: pure function from (domain, instance, keys) to the exact DNS records.
use crate::keys::DkimKey;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum RType {
    Cname,
    Txt,
    Mx,
}

impl RType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cname => "CNAME",
            Self::Txt => "TXT",
            Self::Mx => "MX",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    DkimCname,
    DkimTxt,
    ReturnPathMx,
    ReturnPathSpf,
    Dmarc,
    MtaStsTxt,
    MtaStsHost,
    TlsRpt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// Fully-qualified, no trailing dot.
    pub name: String,
    pub rtype: RType,
    /// For MX this is the target host only; see `priority`.
    pub value: String,
    pub priority: Option<u16>,
    pub purpose: Purpose,
    pub note: String,
}

/// What the instance (the mailcraft server) offers.
#[derive(Debug, Clone, Default)]
pub struct Instance {
    /// e.g. `mailcraft.example.net`. Enables CNAME delegation (DKIM, MTA-STS, SPF include).
    pub domain: Option<String>,
    /// Inbound MX host for bounces, e.g. `mx.mailcraft.example.net`.
    pub mx_host: String,
    /// Sending IPs; used for the bounce-domain SPF when set (flat, no lookups).
    pub ips: Vec<IpAddr>,
}

#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Mailbox for DMARC aggregate reports. User-chosen; omitted from the record if None.
    pub dmarc_rua: Option<String>,
    pub mta_sts: bool,
    /// Mailbox for TLS-RPT reports; enables the TLS-RPT record.
    pub tls_rpt: Option<String>,
    /// MTA-STS policy id (changes whenever the policy changes), e.g. `20261027T000000Z`.
    pub mta_sts_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub domain: String,
    pub sending_domain: String,
    pub bounce_domain: String,
    pub records: Vec<Record>,
    /// Direct-TXT DKIM records, usable instead of the CNAMEs (no rotation by us then).
    pub dkim_txt_alternative: Vec<Record>,
    pub warnings: Vec<String>,
    /// Unix seconds when the plan was made; the verifier uses it for "propagating" hints.
    pub created_unix: u64,
}

/// `example.com` -> `mail.example.com`; anything with 3+ labels is kept as given.
// ponytail: label count, not the Public Suffix List; `example.co.uk` gets `mail.` prepended
// wrongly-safe (still valid, just one level deeper). Add `psl` crate if it matters.
pub fn sending_domain(domain: &str, use_subdomain: bool) -> String {
    let d = domain.trim_end_matches('.').to_ascii_lowercase();
    if use_subdomain && d.split('.').count() == 2 {
        format!("mail.{d}")
    } else {
        d
    }
}

fn rec(name: String, rtype: RType, value: String, purpose: Purpose, note: &str) -> Record {
    Record {
        name,
        rtype,
        value,
        priority: None,
        purpose,
        note: note.into(),
    }
}

pub fn spf_value(inst: &Instance) -> Result<String, String> {
    if !inst.ips.is_empty() {
        let m: Vec<String> = inst
            .ips
            .iter()
            .map(|ip| match ip {
                IpAddr::V4(a) => format!("ip4:{a}"),
                IpAddr::V6(a) => format!("ip6:{a}"),
            })
            .collect();
        Ok(format!("v=spf1 {} ~all", m.join(" ")))
    } else if let Some(d) = &inst.domain {
        Ok(format!("v=spf1 include:_spf.{d} ~all"))
    } else {
        Err("need the instance's sending IPs or an instance domain for SPF".into())
    }
}

/// CNAME target the instance must serve for one key. It includes the sending domain because selectors
/// (`mc2026a`) repeat across domains: `<selector>.<sending-domain>.dkim.<instance>`.
pub fn dkim_target(instance_domain: &str, sending: &str, selector: &str) -> String {
    format!("{selector}.{sending}.dkim.{instance_domain}")
}

/// Inverse of [`dkim_target`] for the instance's DNS responder: `qname` -> (selector, sending domain).
pub fn parse_dkim_target(qname: &str, instance_domain: &str) -> Option<(String, String)> {
    let q = qname.trim_end_matches('.').to_ascii_lowercase();
    let rest = q.strip_suffix(&format!(".dkim.{}", instance_domain.to_ascii_lowercase()))?;
    let (selector, sending) = rest.split_once('.')?;
    (!selector.is_empty() && sending.contains('.'))
        .then(|| (selector.to_string(), sending.to_string()))
}

/// The records for one DKIM key: (records to publish, direct-TXT alternative).
pub fn dkim_records(inst: &Instance, sending: &str, k: &DkimKey) -> (Vec<Record>, Vec<Record>) {
    let name = format!("{}._domainkey.{sending}", k.selector);
    let txt = rec(
        name.clone(),
        RType::Txt,
        k.txt_value(),
        Purpose::DkimTxt,
        "DKIM public key (direct)",
    );
    match &inst.domain {
        Some(d) => (
            vec![rec(
                name,
                RType::Cname,
                dkim_target(d, sending, &k.selector),
                Purpose::DkimCname,
                "DKIM delegated to the instance; it can rotate keys without you",
            )],
            vec![txt],
        ),
        None => (vec![txt], vec![]),
    }
}

pub fn plan(
    domain: &str,
    use_subdomain: bool,
    inst: &Instance,
    keys: &[DkimKey],
    opts: &Options,
    now_unix: u64,
) -> Result<Plan, String> {
    let sending = sending_domain(domain, use_subdomain);
    let bounce = format!("bounces.{sending}");
    let mut records = Vec::new();
    let mut alt = Vec::new();
    let mut warnings = Vec::new();

    for k in keys {
        let (recs, alts) = dkim_records(inst, &sending, k);
        records.extend(recs);
        alt.extend(alts);
    }
    if inst.domain.is_none() {
        alt.clear();
        warnings.push(
            "no instance domain: DKIM is published as TXT, so key rotation needs a DNS edit".into(),
        );
    }

    records.push(Record {
        priority: Some(10),
        ..rec(
            bounce.clone(),
            RType::Mx,
            inst.mx_host.clone(),
            Purpose::ReturnPathMx,
            "bounces/DSNs come back here",
        )
    });
    records.push(rec(
        bounce.clone(),
        RType::Txt,
        spf_value(inst)?,
        Purpose::ReturnPathSpf,
        "SPF for the return-path; aligns with DMARC, root SPF untouched",
    ));

    let mut dmarc = String::from("v=DMARC1; p=none");
    if let Some(r) = &opts.dmarc_rua {
        dmarc += &format!("; rua=mailto:{r}");
        let host = r.rsplit('@').next().unwrap_or_default();
        if !host.ends_with(&sending) && !sending.ends_with(host) {
            warnings.push(format!(
                "rua mailbox is on {host}: that domain must publish {sending}._report._dmarc.{host} TXT \"v=DMARC1\""
            ));
        }
    } else {
        warnings.push(
            "no DMARC rua mailbox set: you will get no aggregate reports (--rua you@example.com)"
                .into(),
        );
    }
    dmarc += "; adkim=r; aspf=r; fo=1";
    records.push(rec(
        format!("_dmarc.{sending}"),
        RType::Txt,
        dmarc,
        Purpose::Dmarc,
        "monitor-only; tighten to quarantine/reject after 2-4 weeks of clean reports",
    ));

    if opts.mta_sts {
        let d = inst
            .domain
            .as_ref()
            .ok_or("MTA-STS needs an instance domain (it serves the policy file)")?;
        records.push(rec(
            format!("_mta-sts.{bounce}"),
            RType::Txt,
            format!("v=STSv1; id={}", opts.mta_sts_id),
            Purpose::MtaStsTxt,
            "MTA-STS for inbound bounces",
        ));
        records.push(rec(
            format!("mta-sts.{bounce}"),
            RType::Cname,
            format!("mta-sts.{d}"),
            Purpose::MtaStsHost,
            "instance serves /.well-known/mta-sts.txt",
        ));
    }
    if let Some(r) = &opts.tls_rpt {
        records.push(rec(
            format!("_smtp._tls.{bounce}"),
            RType::Txt,
            format!("v=TLSRPTv1; rua=mailto:{r}"),
            Purpose::TlsRpt,
            "TLS failure reports",
        ));
    }

    Ok(Plan {
        domain: domain.into(),
        sending_domain: sending,
        bounce_domain: bounce,
        records,
        dkim_txt_alternative: alt,
        warnings,
        created_unix: now_unix,
    })
}

/// Aligned plain-text table.
pub fn render_table(p: &Plan) -> String {
    let row = |r: &Record| {
        let v = match r.priority {
            Some(pr) => format!("{pr} {}", r.value),
            None => r.value.clone(),
        };
        [r.rtype.as_str().to_string(), r.name.clone(), v]
    };
    let rows: Vec<[String; 3]> = p.records.iter().map(row).collect();
    let w0 = rows.iter().map(|r| r[0].len()).max().unwrap_or(4).max(4);
    let w1 = rows.iter().map(|r| r[1].len()).max().unwrap_or(4).max(4);
    let mut out = format!("{:<w0$}  {:<w1$}  VALUE\n", "TYPE", "NAME");
    for r in &rows {
        out += &format!("{:<w0$}  {:<w1$}  {}\n", r[0], r[1], r[2]);
    }
    for w in &p.warnings {
        out += &format!("! {w}\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Algo;

    fn key() -> DkimKey {
        DkimKey {
            selector: "mc2026a".into(),
            algo: Algo::Ed25519,
            private_pem: String::new(),
            public_b64: "AAAA".into(),
        }
    }
    fn inst() -> Instance {
        Instance {
            domain: Some("mc.example.net".into()),
            mx_host: "mx.mc.example.net".into(),
            ips: vec![],
        }
    }
    fn find(p: &Plan, pu: Purpose) -> &Record {
        p.records.iter().find(|r| r.purpose == pu).unwrap()
    }

    #[test]
    fn dkim_target_is_per_domain_and_parses_back() {
        let t = dkim_target("mc.example.net", "mail.a.com", "mc2026a");
        assert_ne!(
            t,
            dkim_target("mc.example.net", "mail.b.com", "mc2026a"),
            "no cross-domain collision"
        );
        assert_eq!(
            parse_dkim_target(&format!("{t}."), "mc.example.net"),
            Some(("mc2026a".into(), "mail.a.com".into()))
        );
        assert_eq!(
            parse_dkim_target("mc2026a.dkim.mc.example.net", "mc.example.net"),
            None
        );
        assert_eq!(parse_dkim_target(&t, "other.net"), None);
    }

    #[test]
    fn subdomain_preference() {
        assert_eq!(sending_domain("example.com", true), "mail.example.com");
        assert_eq!(sending_domain("example.com", false), "example.com");
        assert_eq!(sending_domain("news.example.com", true), "news.example.com");
    }

    #[test]
    fn full_plan_with_instance_domain() {
        let o = Options {
            dmarc_rua: Some("dmarc@example.com".into()),
            mta_sts: true,
            tls_rpt: Some("tls@example.com".into()),
            mta_sts_id: "1".into(),
        };
        let p = plan("example.com", true, &inst(), &[key()], &o, 0).unwrap();
        let d = find(&p, Purpose::DkimCname);
        assert_eq!(
            (d.name.as_str(), d.value.as_str()),
            (
                "mc2026a._domainkey.mail.example.com",
                "mc2026a.mail.example.com.dkim.mc.example.net"
            )
        );
        assert_eq!(
            p.dkim_txt_alternative[0].value,
            "v=DKIM1; k=ed25519; p=AAAA"
        );
        let mx = find(&p, Purpose::ReturnPathMx);
        assert_eq!(
            (mx.name.as_str(), mx.priority),
            ("bounces.mail.example.com", Some(10))
        );
        assert_eq!(
            find(&p, Purpose::ReturnPathSpf).value,
            "v=spf1 include:_spf.mc.example.net ~all"
        );
        assert_eq!(
            find(&p, Purpose::Dmarc).value,
            "v=DMARC1; p=none; rua=mailto:dmarc@example.com; adkim=r; aspf=r; fo=1"
        );
        assert_eq!(
            find(&p, Purpose::MtaStsHost).name,
            "mta-sts.bounces.mail.example.com"
        );
        assert_eq!(
            find(&p, Purpose::TlsRpt).name,
            "_smtp._tls.bounces.mail.example.com"
        );
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
    }

    #[test]
    fn no_instance_domain_falls_back_to_txt_and_ip_spf() {
        let i = Instance {
            domain: None,
            mx_host: "mx.me.org".into(),
            ips: vec![
                "203.0.113.5".parse().unwrap(),
                "2001:db8::1".parse().unwrap(),
            ],
        };
        let p = plan("example.com", true, &i, &[key()], &Options::default(), 0).unwrap();
        assert_eq!(find(&p, Purpose::DkimTxt).rtype, RType::Txt);
        assert!(p.dkim_txt_alternative.is_empty());
        assert_eq!(
            find(&p, Purpose::ReturnPathSpf).value,
            "v=spf1 ip4:203.0.113.5 ip6:2001:db8::1 ~all"
        );
        assert!(!find(&p, Purpose::Dmarc).value.contains("rua"));
        assert!(p.warnings.len() >= 2);
    }

    #[test]
    fn refusals() {
        let i = Instance {
            domain: None,
            mx_host: "mx".into(),
            ips: vec![],
        };
        assert!(plan("example.com", true, &i, &[], &Options::default(), 0).is_err());
        let o = Options {
            mta_sts: true,
            ..Default::default()
        };
        let i = Instance {
            ips: vec!["203.0.113.5".parse().unwrap()],
            ..i
        };
        assert!(plan("example.com", true, &i, &[], &o, 0).is_err());
    }

    #[test]
    fn external_rua_warns_about_authorization() {
        let o = Options {
            dmarc_rua: Some("r@reports.net".into()),
            ..Default::default()
        };
        let p = plan("example.com", true, &inst(), &[], &o, 0).unwrap();
        assert!(
            p.warnings
                .iter()
                .any(|w| w.contains("mail.example.com._report._dmarc.reports.net"))
        );
    }

    #[test]
    fn table_and_json_render() {
        let p = plan(
            "example.com",
            true,
            &inst(),
            &[key()],
            &Options::default(),
            0,
        )
        .unwrap();
        let t = render_table(&p);
        assert!(t.contains("MX") && t.contains("10 mx.mc.example.net"));
        assert!(
            serde_json::to_string(&p)
                .unwrap()
                .contains("\"rtype\":\"CNAME\"")
        );
    }
}
