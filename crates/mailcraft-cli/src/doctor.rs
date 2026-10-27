//! `mailcraft doctor`: local probes (port 25, FCrDNS, blocklists) + server checks.
use crate::{client::*, Out};
use serde_json::{json, Value};
use std::{net::ToSocketAddrs, process::Command, time::Duration};

fn check(id: &str, status: &str, detail: impl Into<String>, hint: &str) -> Value {
    json!({"id": id, "status": status, "detail": detail.into(), "hint": hint})
}

fn port_check(id: &str, target: &str, hint: &str) -> Value {
    let res = target
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .map(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5)));
    match res {
        Some(Ok(_)) => check(id, "pass", format!("outbound {target} is reachable"), ""),
        Some(Err(e)) => check(id, "fail", format!("cannot connect: {e}"), hint),
        None => check(id, "fail", "DNS resolution failed", hint),
    }
}

fn getent(arg: &str) -> Option<String> {
    let o = Command::new("getent").args(["hosts", arg]).output().ok()?;
    String::from_utf8_lossy(&o.stdout)
        .split_whitespace()
        .nth(1)
        .map(String::from)
        .filter(|_| o.status.success())
}

/// ponytail: IPv4 only and via `getent` (Linux/glibc); upgrade to a resolver crate for IPv6/macOS.
fn fcrdns(ip: &str) -> Value {
    let hint = "Set a PTR for the egress IP with your provider and make the name resolve back to the same IP";
    let Some(name) = getent(ip) else {
        return check("fcrdns", "fail", format!("no PTR for {ip}"), hint);
    };
    let back = Command::new("getent")
        .args(["ahostsv4", &name])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(ip))
        .unwrap_or(false);
    if back {
        check("fcrdns", "pass", format!("{ip} -> {name} -> {ip}"), "")
    } else {
        check(
            "fcrdns",
            "fail",
            format!("{ip} -> {name} does not resolve back"),
            hint,
        )
    }
}

fn blocklists(ip: &str) -> Value {
    let o: Vec<&str> = ip.split('.').collect();
    if o.len() != 4 {
        return check("blocklists", "skipped", "IPv4 only", "");
    }
    let rev = format!("{}.{}.{}.{}", o[3], o[2], o[1], o[0]);
    // Spamhaus free mirrors are for low-volume non-commercial use (SPEC 12.3). SORBS is dead; not queried.
    let mut listed = vec![];
    for zone in ["zen.spamhaus.org", "b.barracudacentral.org"] {
        if let Some(a) = format!("{rev}.{zone}:80")
            .to_socket_addrs()
            .ok()
            .and_then(|mut a| a.next())
        {
            if a.ip().to_string().starts_with("127.255.255.") {
                return check(
                    "blocklists",
                    "warn",
                    "resolver blocked by Spamhaus (use your own resolver)",
                    "Query from a non-public resolver",
                );
            }
            listed.push(zone);
        }
    }
    if listed.is_empty() {
        check("blocklists", "pass", format!("{ip} not listed"), "")
    } else {
        check(
            "blocklists",
            "fail",
            format!("{ip} listed on {}", listed.join(", ")),
            "Delist or use a relay",
        )
    }
}

pub fn run(cfg: &Config, ip: Option<String>) -> Result<Out, CliErr> {
    let mut checks = vec![
        port_check(
            "port25_outbound",
            "gmail-smtp-in.l.google.com:25",
            "Use a relay or the Gmail path; direct send needs port 25 (SPEC 12.3)",
        ),
        port_check(
            "port587_outbound",
            "smtp.gmail.com:587",
            "Relays use 587/465; ask your provider to open it",
        ),
    ];
    match &ip {
        Some(ip) => {
            checks.push(fcrdns(ip));
            checks.push(blocklists(ip));
        }
        None => {
            for id in ["fcrdns", "blocklists"] {
                checks.push(check(
                    id,
                    "skipped",
                    "egress IP unknown",
                    "Pass --ip <public egress IP> or set MAILCRAFT_EGRESS_IP",
                ));
            }
        }
    }
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| "http://localhost:8080".into());
    let api = Api::new(&base, cfg.api_key.clone());
    match api.get("/healthz") {
        Err(e) => checks.push(check(
            "api_reachable",
            "fail",
            e.message,
            "Start the server: docker compose up -d",
        )),
        Ok(_) => {
            checks.push(check("api_reachable", "pass", base.clone(), ""));
            if cfg.api_key.is_none() {
                checks.push(check(
                    "api_key",
                    "fail",
                    "no key configured",
                    "Run `mailcraft init`",
                ));
            } else {
                match api.get("/v1/account/status") {
                    Ok(r) => {
                        let d = r.data();
                        checks.push(check(
                            "api_key",
                            "pass",
                            format!("env {}", d["env"].as_str().unwrap_or("?")),
                            "",
                        ));
                        let kind = d["delivery_path"]["kind"].as_str().unwrap_or("unknown");
                        let (st, hint) = if kind == "sandbox" || kind == "unknown" {
                            ("warn", "Nothing leaves the box: `mailcraft connect gmail`, `connect relay <preset>` or `domain add`")
                        } else {
                            ("pass", "")
                        };
                        checks.push(check("delivery_path", st, kind, hint));
                    }
                    Err(e) => checks.push(check(
                        "api_key",
                        "fail",
                        e.message,
                        e.hint.as_deref().unwrap_or("Check the key"),
                    )),
                }
                // Server-side checks (dns_records, dmarc_policy, redis, postgres, ...).
                match api.get("/v1/doctor") {
                    Ok(r) => {
                        checks.extend(r.data()["checks"].as_array().cloned().unwrap_or_default())
                    }
                    Err(e) => checks.push(check("server_checks", "skipped", e.message, "")),
                }
            }
        }
    }
    let failed = checks.iter().any(|c| c["status"] == "fail");
    Ok(Out {
        data: json!({"checks": checks}),
        request_id: None,
        exit: if failed { exit::CHECK_FAILED } else { exit::OK },
    })
}
