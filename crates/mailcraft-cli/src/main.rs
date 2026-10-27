//! `mailcraft` CLI: an HTTP client of the REST API. Agent contract (SPEC 7.2): stdout is one
//! JSON document (`--json`, automatic when stdout is not a TTY), stderr is logs, exit codes are
//! stable (see `client::exit`).
mod client;
mod doctor;
mod gmail;

use clap::{Parser, Subcommand};
use client::{exit, Api, CliErr, Config};
use serde_json::{json, Value};
use std::{
    io::{IsTerminal, Write},
    process::ExitCode,
};

#[derive(Parser)]
#[command(
    name = "mailcraft",
    version,
    about = "Agent-native email: transactional + lifecycle automations"
)]
struct Cli {
    /// Machine-readable output (automatic when stdout is not a TTY).
    #[arg(long, global = true)]
    json: bool,
    /// API base URL (default: MAILCRAFT_API_URL, config file, http://localhost:8080).
    #[arg(long, global = true)]
    url: Option<String>,
    /// Never prompt.
    #[arg(long, global = true)]
    non_interactive: bool,
    /// Skip confirmation prompts.
    #[arg(long, short = 'y', global = true)]
    yes: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create the first key, pick a delivery path, send a test, print next steps.
    Init {
        /// Use an existing key instead of creating one (never echoed).
        #[arg(long)]
        key: Option<String>,
        /// sandbox | gmail | relay:<preset> | domain:<name>
        #[arg(long)]
        delivery: Option<String>,
    },
    /// Connect a delivery path.
    Connect {
        #[command(subcommand)]
        cmd: ConnectCmd,
    },
    /// Manage sending domains.
    Domain {
        #[command(subcommand)]
        cmd: DomainCmd,
    },
    /// Send one email.
    Send {
        #[arg(long)]
        from: Option<String>,
        /// Recipient (repeat or comma-separate).
        #[arg(long, required = true, value_delimiter = ',')]
        to: Vec<String>,
        #[arg(long)]
        subject: Option<String>,
        #[arg(long)]
        text: Option<String>,
        #[arg(long)]
        html: Option<String>,
        /// Template id.
        #[arg(long)]
        template: Option<String>,
        /// Template variables as JSON (or @file).
        #[arg(long)]
        data: Option<String>,
        #[arg(long)]
        stream: Option<String>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// Inspect sent emails.
    Emails {
        #[command(subcommand)]
        cmd: EmailsCmd,
    },
    Templates {
        #[command(subcommand)]
        cmd: TemplatesCmd,
    },
    Contacts {
        #[command(subcommand)]
        cmd: ContactsCmd,
    },
    Events {
        #[command(subcommand)]
        cmd: EventsCmd,
    },
    Automations {
        #[command(subcommand)]
        cmd: AutomationsCmd,
    },
    Keys {
        #[command(subcommand)]
        cmd: KeysCmd,
    },
    /// Approval queue (the API refuses agent keys for approve/reject).
    Approvals {
        #[command(subcommand)]
        cmd: ApprovalsCmd,
    },
    /// Engage (on) or release (off) the org kill switch.
    KillSwitch { state: OnOff },
    /// Check port 25, FCrDNS, blocklists, DNS records, delivery path.
    Doctor {
        /// Public egress IP to check FCrDNS and blocklists for (or MAILCRAFT_EGRESS_IP).
        #[arg(long)]
        ip: Option<String>,
    },
}

#[derive(clap::ValueEnum, Clone)]
enum OnOff {
    On,
    Off,
}

#[derive(Subcommand)]
enum ConnectCmd {
    /// Gmail OAuth (test / low volume). Needs your own Google OAuth client, see docs/QUICKSTART.md.
    Gmail {
        /// Seconds to wait for the browser redirect.
        #[arg(long, default_value_t = 300)]
        timeout: u64,
    },
    /// SMTP relay preset: ses, postmark, mailgun, brevo, smtp2go, custom.
    Relay {
        preset: String,
        #[arg(long)]
        host: Option<String>,
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        username: Option<String>,
        /// Prefer env MAILCRAFT_SMTP_PASSWORD so it stays out of shell history.
        #[arg(long)]
        password: Option<String>,
    },
}

#[derive(Subcommand)]
enum DomainCmd {
    /// Create a domain; prints (or auto-creates) SPF/DKIM/DMARC/return-path records.
    Add {
        domain: String,
        #[arg(long)]
        stream: Option<String>,
    },
    /// Re-check DNS. Exit 7 until verified.
    Verify {
        domain: String,
    },
    List,
}

#[derive(Subcommand)]
enum EmailsCmd {
    Get {
        id: String,
    },
    List {
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        cursor: Option<String>,
    },
}

#[derive(Subcommand)]
enum TemplatesCmd {
    List,
    /// Import a .json / .html / .mjml file.
    Import {
        file: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        format: Option<String>,
    },
    Export {
        id: String,
        #[arg(long, default_value = "json")]
        format: String,
        /// Write to a file instead of stdout.
        #[arg(long)]
        out: Option<String>,
    },
    Preview {
        id: String,
        #[arg(long)]
        data: Option<String>,
    },
}

#[derive(Subcommand)]
enum ContactsCmd {
    List {
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        cursor: Option<String>,
    },
    Get {
        email: String,
    },
    Upsert {
        email: String,
        /// Properties as JSON (or @file).
        #[arg(long)]
        data: Option<String>,
    },
    Delete {
        email: String,
    },
}

#[derive(Subcommand)]
enum EventsCmd {
    Track {
        name: String,
        #[arg(long)]
        contact: String,
        #[arg(long)]
        data: Option<String>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        idempotency_key: Option<String>,
    },
}

#[derive(Subcommand)]
enum AutomationsCmd {
    List,
    Enable {
        id: String,
    },
    Disable {
        id: String,
    },
    /// Create an automation from a JSON pack file.
    Import {
        file: String,
    },
}

#[derive(Subcommand)]
enum KeysCmd {
    List,
    Create {
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "read,send", value_delimiter = ',')]
        scopes: Vec<String>,
        #[arg(long, default_value = "test")]
        env: String,
    },
    Revoke {
        id: String,
    },
}

#[derive(Subcommand)]
enum ApprovalsCmd {
    List,
    Approve { id: String },
    Reject { id: String },
}

/// What a command produced. `exit` is non-zero for ok-but-not-done results (policy, unverified).
pub struct Out {
    pub data: Value,
    pub request_id: Option<String>,
    pub exit: u8,
}

impl Out {
    pub fn new(data: Value) -> Self {
        Out {
            data,
            request_id: None,
            exit: exit::OK,
        }
    }
}

type R = Result<Out, CliErr>;

fn ok(resp: client::Response) -> R {
    // 202 with a policy status is an exit-4 result (SPEC 7.2), not a failure of the call.
    let st = resp.data()["status"].as_str().unwrap_or("");
    let code = if matches!(st, "pending_approval" | "blocked_by_policy") {
        exit::POLICY
    } else {
        exit::OK
    };
    Ok(Out {
        request_id: resp.body["request_id"].as_str().map(String::from),
        data: resp.body["data"].clone(),
        exit: code,
    })
}

/// JSON argument: literal or `@file`.
fn json_arg(raw: &Option<String>, what: &str) -> Result<Value, CliErr> {
    let Some(s) = raw else { return Ok(json!({})) };
    let text = match s.strip_prefix('@') {
        Some(p) => std::fs::read_to_string(p)
            .map_err(|e| CliErr::usage(format!("cannot read {p}: {e}")))?,
        None => s.clone(),
    };
    serde_json::from_str(&text).map_err(|e| CliErr::usage(format!("{what} is not valid JSON: {e}")))
}

fn read_file(p: &str) -> Result<String, CliErr> {
    std::fs::read_to_string(p).map_err(|e| CliErr::usage(format!("cannot read {p}: {e}")))
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~@".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn page(
    base: &str,
    status: Option<&String>,
    limit: Option<u32>,
    cursor: Option<&String>,
) -> String {
    let mut q = vec![];
    if let Some(s) = status {
        q.push(format!("status={}", enc(s)));
    }
    if let Some(l) = limit {
        q.push(format!("limit={l}"));
    }
    if let Some(c) = cursor {
        q.push(format!("cursor={}", enc(c)));
    }
    if q.is_empty() {
        base.into()
    } else {
        format!("{base}?{}", q.join("&"))
    }
}

fn require_key(cfg: &Config) -> Result<Api, CliErr> {
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| "http://localhost:8080".into());
    if cfg.api_key.is_none() {
        return Err(
            CliErr::new("unauthenticated", "no API key configured", exit::AUTH)
                .hint("Run `mailcraft init`, or set MAILCRAFT_API_KEY"),
        );
    }
    Ok(Api::new(&base, cfg.api_key.clone()))
}

/// Find a domain id by name via the list route.
fn domain_id(api: &Api, name: &str) -> Result<String, CliErr> {
    let r = api.get("/v1/domains")?;
    r.data()
        .as_array()
        .and_then(|a| a.iter().find(|d| d["name"] == name || d["id"] == name))
        .and_then(|d| d["id"].as_str().map(String::from))
        .ok_or_else(|| {
            CliErr::new(
                "not_found",
                format!("domain {name} not found"),
                exit::NOT_FOUND,
            )
            .hint("Run `mailcraft domain add <domain>` first")
        })
}

pub fn prompt(q: &str, default: &str, interactive: bool) -> String {
    if !interactive {
        return default.into();
    }
    eprint!("{q} [{default}]: ");
    let _ = std::io::stderr().flush();
    let mut s = String::new();
    let _ = std::io::stdin().read_line(&mut s);
    let s = s.trim();
    if s.is_empty() {
        default.into()
    } else {
        s.into()
    }
}

fn run(cli: &Cli) -> R {
    let mut cfg = Config::load();
    if let Some(u) = &cli.url {
        cfg.base_url = Some(u.clone());
    }
    let interactive = !cli.non_interactive
        && !cli.yes
        && std::io::stdin().is_terminal()
        && std::io::stderr().is_terminal();
    match &cli.cmd {
        Cmd::Init { key, delivery } => init(cfg, key.clone(), delivery.clone(), interactive),
        Cmd::Doctor { ip } => doctor::run(
            &cfg,
            ip.clone()
                .or_else(|| std::env::var("MAILCRAFT_EGRESS_IP").ok()),
        ),
        Cmd::Connect { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                ConnectCmd::Gmail { timeout } => gmail::connect(&api, *timeout),
                ConnectCmd::Relay {
                    preset,
                    host,
                    port,
                    username,
                    password,
                } => {
                    let pw = password
                        .clone()
                        .or_else(|| std::env::var("MAILCRAFT_SMTP_PASSWORD").ok());
                    let body = json!({"kind": "smtp-relay", "preset": preset,
                        "config": {"host": host, "port": port, "username": username, "password": pw}});
                    ok(api.post("/v1/transports", &body, None)?)
                }
            }
        }
        Cmd::Domain { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                DomainCmd::Add { domain, stream } => {
                    let mut b = json!({"domain": domain});
                    if let Some(s) = stream {
                        b["stream"] = json!(s);
                    }
                    ok(api.post("/v1/domains", &b, None)?)
                }
                DomainCmd::Verify { domain } => {
                    let id = domain_id(&api, domain)?;
                    let r = api.post(&format!("/v1/domains/{id}/verify"), &json!({}), None)?;
                    let verified = r.data()["status"] == "verified";
                    let mut o = ok(r)?;
                    if !verified {
                        o.exit = exit::CHECK_FAILED;
                    }
                    Ok(o)
                }
                DomainCmd::List => ok(api.get("/v1/domains")?),
            }
        }
        Cmd::Send {
            from,
            to,
            subject,
            text,
            html,
            template,
            data,
            stream,
            dry_run,
            idempotency_key,
        } => {
            let api = require_key(&cfg)?;
            if template.is_none() && (subject.is_none() || (text.is_none() && html.is_none())) {
                return Err(CliErr::usage(
                    "give --template, or --subject with --text/--html",
                ));
            }
            let mut b = json!({"to": to, "dry_run": dry_run});
            for (k, v) in [
                ("from", from),
                ("subject", subject),
                ("text", text),
                ("html", html),
                ("stream", stream),
            ] {
                if let Some(v) = v {
                    b[k] = json!(v);
                }
            }
            if let Some(t) = template {
                b["template"] = json!({"id": t, "variables": json_arg(data, "--data")?});
            }
            ok(api.post("/v1/emails", &b, idempotency_key.as_deref())?)
        }
        Cmd::Emails { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                EmailsCmd::Get { id } => ok(api.get(&format!("/v1/emails/{}", enc(id)))?),
                EmailsCmd::List {
                    status,
                    limit,
                    cursor,
                } => ok(api.get(&page(
                    "/v1/emails",
                    status.as_ref(),
                    *limit,
                    cursor.as_ref(),
                ))?),
            }
        }
        Cmd::Templates { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                TemplatesCmd::List => ok(api.get("/v1/templates")?),
                TemplatesCmd::Import { file, name, format } => {
                    let ext = std::path::Path::new(file)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("json");
                    let fmt = format.clone().unwrap_or_else(|| ext.to_string());
                    let stem = std::path::Path::new(file)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("template");
                    let body = json!({"format": fmt, "name": name.clone().unwrap_or(stem.into()), "content": read_file(file)?});
                    ok(api.post("/v1/templates/import", &body, None)?)
                }
                TemplatesCmd::Export { id, format, out } => {
                    let r = api.get(&format!(
                        "/v1/templates/{}/export?format={}",
                        enc(id),
                        enc(format)
                    ))?;
                    if let Some(p) = out {
                        let c = r.data()["content"]
                            .as_str()
                            .map(String::from)
                            .unwrap_or_else(|| r.data().to_string());
                        std::fs::write(p, c).map_err(|e| {
                            CliErr::new("write_failed", e.to_string(), exit::FAILURE)
                        })?;
                        return Ok(Out::new(json!({"written": p, "format": format})));
                    }
                    ok(r)
                }
                TemplatesCmd::Preview { id, data } => ok(api.post(
                    &format!("/v1/templates/{}/preview", enc(id)),
                    &json!({"variables": json_arg(data, "--data")?}),
                    None,
                )?),
            }
        }
        Cmd::Contacts { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                ContactsCmd::List { limit, cursor } => {
                    ok(api.get(&page("/v1/contacts", None, *limit, cursor.as_ref()))?)
                }
                ContactsCmd::Get { email } => ok(api.get(&format!("/v1/contacts/{}", enc(email)))?),
                ContactsCmd::Upsert { email, data } => ok(api.call(
                    "PUT",
                    "/v1/contacts",
                    Some(&json!({"email": email, "properties": json_arg(data, "--data")?})),
                    None,
                )?),
                ContactsCmd::Delete { email } => {
                    if !cli.yes
                        && !cli.non_interactive
                        && std::io::stdin().is_terminal()
                        && prompt(&format!("Delete {email}? (yes/no)"), "no", true) != "yes"
                    {
                        return Err(CliErr::usage("aborted"));
                    }
                    ok(api.call(
                        "DELETE",
                        &format!("/v1/contacts/{}", enc(email)),
                        None,
                        None,
                    )?)
                }
            }
        }
        Cmd::Events {
            cmd:
                EventsCmd::Track {
                    name,
                    contact,
                    data,
                    dry_run,
                    idempotency_key,
                },
        } => {
            let api = require_key(&cfg)?;
            let b = json!({"name": name, "contact": {"email": contact}, "properties": json_arg(data, "--data")?, "dry_run": dry_run});
            ok(api.post("/v1/events", &b, idempotency_key.as_deref())?)
        }
        Cmd::Automations { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                AutomationsCmd::List => ok(api.get("/v1/automations")?),
                AutomationsCmd::Enable { id } => ok(api.post(
                    &format!("/v1/automations/{}/resume", enc(id)),
                    &json!({}),
                    None,
                )?),
                AutomationsCmd::Disable { id } => ok(api.post(
                    &format!("/v1/automations/{}/pause", enc(id)),
                    &json!({}),
                    None,
                )?),
                AutomationsCmd::Import { file } => {
                    let v: Value = serde_json::from_str(&read_file(file)?)
                        .map_err(|e| CliErr::usage(format!("{file} is not valid JSON: {e}")))?;
                    ok(api.post("/v1/automations", &v, None)?)
                }
            }
        }
        Cmd::Keys { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                KeysCmd::List => ok(api.get("/v1/keys")?),
                KeysCmd::Create { name, scopes, env } => ok(api.post(
                    "/v1/keys",
                    &json!({"name": name, "scopes": scopes, "env": env}),
                    None,
                )?),
                KeysCmd::Revoke { id } => {
                    ok(api.call("DELETE", &format!("/v1/keys/{}", enc(id)), None, None)?)
                }
            }
        }
        Cmd::Approvals { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                ApprovalsCmd::List => ok(api.get("/v1/approvals")?),
                ApprovalsCmd::Approve { id } | ApprovalsCmd::Reject { id } => {
                    let d = if matches!(cmd, ApprovalsCmd::Approve { .. }) {
                        "approve"
                    } else {
                        "reject"
                    };
                    ok(api.post(
                        &format!("/v1/approvals/{}/decide", enc(id)),
                        &json!({"decision": d}),
                        None,
                    )?)
                }
            }
        }
        Cmd::KillSwitch { state } => {
            let api = require_key(&cfg)?;
            ok(api.post(
                "/v1/kill-switch",
                &json!({"on": matches!(state, OnOff::On)}),
                None,
            )?)
        }
    }
}

fn init(
    mut cfg: Config,
    key_flag: Option<String>,
    delivery: Option<String>,
    interactive: bool,
) -> R {
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| prompt("API base URL", "http://localhost:8080", interactive));
    let anon = Api::new(&base, None);
    anon.get("/healthz")?;
    let mut steps = vec![json!({"step": "api_reachable", "status": "pass", "url": base})];
    cfg.base_url = Some(base.clone());

    let mut created = false;
    let key = key_flag.or(cfg.api_key.clone());
    let key = match key {
        Some(k) => k,
        None => {
            // First run: /setup returns the admin + test keys once; we keep the test key.
            let r = anon.post("/v1/setup", &json!({}), None).map_err(|e| {
                if e.exit == exit::AUTH || e.exit == exit::NOT_FOUND || e.code == "not_implemented" || e.exit == exit::FAILURE {
                    e.hint("Setup is already done or unavailable: pass --key / set MAILCRAFT_API_KEY with a key from the dashboard")
                } else {
                    e
                }
            })?;
            created = true;
            r.data()["test_key"]
                .as_str()
                .ok_or_else(|| {
                    CliErr::new("bad_response", "setup returned no test_key", exit::FAILURE)
                })?
                .to_string()
        }
    };
    cfg.api_key = Some(key.clone());
    let path = cfg.save()?;
    steps.push(json!({"step": "key", "status": "pass", "created": created, "env": if key.starts_with("mc_live_") { "live" } else { "test" },
                      "prefix": key.chars().take(12).collect::<String>(), "config": path}));
    let api = Api::new(&base, Some(key));
    let status = api.get("/v1/account/status")?;
    let sd = status.data().clone();

    let choice = delivery.unwrap_or_else(|| {
        prompt(
            "Delivery path (sandbox | gmail | relay:<preset> | domain:<name>)",
            "sandbox",
            interactive,
        )
    });
    let delivery_result = match choice.split_once(':') {
        None if choice == "sandbox" => json!({"path": "sandbox"}),
        None if choice == "gmail" => gmail::connect(&api, 300)?.data,
        Some(("relay", p)) => {
            let pw = std::env::var("MAILCRAFT_SMTP_PASSWORD").ok();
            api.post(
                "/v1/transports",
                &json!({"kind": "smtp-relay", "preset": p, "config": {"password": pw}}),
                None,
            )?
            .data()
            .clone()
        }
        Some(("domain", d)) => api
            .post("/v1/domains", &json!({"domain": d}), None)?
            .data()
            .clone(),
        _ => {
            return Err(CliErr::usage(format!("unknown --delivery {choice}"))
                .hint("sandbox | gmail | relay:<preset> | domain:<name>"))
        }
    };
    steps.push(
        json!({"step": "delivery", "status": "pass", "choice": choice, "result": delivery_result}),
    );

    let test = api.post(
        "/v1/emails",
        &json!({"to": ["delivered@test.mailcraft.local"], "subject": "mailcraft test", "text": "It works."}),
        Some("mailcraft-init-test"),
    );
    steps.push(match test {
        Ok(r) => json!({"step": "test_send", "status": "pass", "email": r.data()}),
        Err(e) => json!({"step": "test_send", "status": "fail", "error": e.to_json()}),
    });
    let next = match choice.split_once(':') {
        Some(("domain", d)) => vec![format!("Add the DNS records printed above, then `mailcraft domain verify {d}`")],
        _ => vec!["`mailcraft domain add example.com` to send from your own domain, or `mailcraft connect gmail` for a no-domain test path".into()],
    };
    let mut next_steps = next;
    next_steps.extend([
        "`mailcraft doctor --json` to check the environment".into(),
        "Use the test key until a human approves go-live".into(),
    ]);
    let failed = steps.iter().any(|s| s["status"] == "fail");
    Ok(Out {
        data: json!({"steps": steps, "account": sd, "next_steps": next_steps}),
        request_id: None,
        exit: if failed { exit::CHECK_FAILED } else { exit::OK },
    })
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let j = cli.json || !std::io::stdout().is_terminal();
    let code = match run(&cli) {
        Ok(o) => {
            if j {
                // `ok` means the call succeeded cleanly; the exit code carries policy / check state.
                let mut v = json!({"ok": o.exit == exit::OK, "schema": 1, "data": o.data});
                v["exit"] = json!(o.exit);
                if let Some(r) = o.request_id {
                    v["request_id"] = json!(r);
                }
                println!("{}", serde_json::to_string(&v).unwrap());
            } else {
                println!("{}", serde_json::to_string_pretty(&o.data).unwrap());
            }
            o.exit
        }
        Err(e) => {
            if j {
                println!(
                    "{}",
                    json!({"ok": false, "schema": 1, "error": e.to_json()})
                );
            } else {
                eprintln!("error: {}: {}", e.code, e.message);
                if let Some(h) = &e.hint {
                    eprintln!("hint: {h}");
                }
            }
            e.exit
        }
    };
    let _ = std::io::stdout().flush();
    ExitCode::from(code)
}
