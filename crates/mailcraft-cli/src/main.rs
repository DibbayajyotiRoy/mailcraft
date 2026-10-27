//! `mailcraft` CLI. Agent contract (SPEC 7.2): stdout = one JSON document with --json,
//! stderr = logs, stable exit codes below. Most commands are stubs in the scaffold.
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::{net::ToSocketAddrs, process::ExitCode, time::Duration};

/// Stable exit codes (agent-native.md section 4). 2 is clap's usage error.
mod exit {
    pub const OK: u8 = 0;
    pub const NOT_IMPLEMENTED: u8 = 1;
    pub const AUTH: u8 = 3;
    pub const POLICY: u8 = 4;
    pub const RETRYABLE: u8 = 5;
    pub const NOT_FOUND: u8 = 6;
    pub const CHECK_FAILED: u8 = 7;
}

#[derive(Parser)]
#[command(
    name = "mailcraft",
    version,
    about = "Agent-native email: transactional + lifecycle automations"
)]
struct Cli {
    /// Machine-readable output (default when stdout is not a TTY is a post-MVP item).
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create the first admin/test key, probe the environment, print next steps.
    Init,
    /// Manage sending domains.
    Domain {
        #[command(subcommand)]
        cmd: DomainCmd,
    },
    /// Send one email.
    Send {
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: String,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        text: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
    /// Check port 25, FCrDNS, blocklists, DNS, key and webhook reachability.
    Doctor,
}

#[derive(Subcommand)]
enum DomainCmd {
    /// Print (or auto-create via a Cloudflare token) SPF/DKIM/DMARC/return-path records.
    Add { domain: String },
    /// Re-check DNS for a domain.
    Verify { domain: String },
}

fn emit(json_mode: bool, v: &Value, human: &str) {
    if json_mode {
        println!("{}", serde_json::to_string(v).expect("serializable"));
    } else {
        println!("{human}");
    }
}

fn not_implemented(json_mode: bool, what: &str) -> u8 {
    let v = json!({"ok": false, "error": {
        "code": "not_implemented", "message": format!("`mailcraft {what}` is not implemented yet"),
        "hint": "mailcraft is pre-alpha; see SPEC.md section 17", "retryable": false}});
    emit(
        json_mode,
        &v,
        &format!("not implemented: {what} (pre-alpha)"),
    );
    exit::NOT_IMPLEMENTED
}

/// Real check: can we open an outbound TCP connection on port 25? (cloud providers block it)
fn check_port25() -> Value {
    let target = "gmail-smtp-in.l.google.com:25";
    let res = target
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .map(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5)));
    let (status, detail) = match res {
        Some(Ok(_)) => ("pass", "outbound port 25 is open".to_string()),
        Some(Err(e)) => ("fail", format!("cannot connect: {e}")),
        None => ("fail", "DNS resolution failed".to_string()),
    };
    json!({"id": "port25_outbound", "status": status, "detail": detail,
           "hint": if status == "fail" { "Use a relay or Gmail transport; direct send needs port 25 (SPEC 12.3)" } else { "" }})
}

fn skipped(id: &str) -> Value {
    json!({"id": id, "status": "skipped", "detail": "not implemented yet"})
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let j = cli.json;
    let code = match cli.cmd {
        Cmd::Init => not_implemented(j, "init"),
        Cmd::Domain {
            cmd: DomainCmd::Add { .. },
        } => not_implemented(j, "domain add"),
        Cmd::Domain {
            cmd: DomainCmd::Verify { .. },
        } => not_implemented(j, "domain verify"),
        Cmd::Send { .. } => not_implemented(j, "send"),
        Cmd::Doctor => {
            let checks = vec![
                check_port25(),
                skipped("fcrdns"),
                skipped("blocklists"),
                skipped("dns_records"),
            ];
            let failed = checks.iter().any(|c| c["status"] == "fail");
            let v = json!({"ok": !failed, "schema": 1, "data": {"checks": checks}});
            emit(
                j,
                &v,
                &serde_json::to_string_pretty(&v["data"]["checks"]).unwrap(),
            );
            if failed {
                exit::CHECK_FAILED
            } else {
                exit::OK
            }
        }
    };
    let _ = (exit::AUTH, exit::POLICY, exit::RETRYABLE, exit::NOT_FOUND); // reserved, see SPEC 7.2
    ExitCode::from(code)
}
