//! `mailcraft` CLI: an HTTP client of the REST API. Agent contract (SPEC 7.2): stdout is one
//! JSON document (`--json`, automatic when stdout is not a TTY), stderr is logs, exit codes are
//! stable (see `client::exit`).
mod client;
mod csv;
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
    /// Config profile: `default` (test key) or `admin` (approvals, go-live). Env: MAILCRAFT_PROFILE.
    #[arg(long, global = true)]
    profile: Option<String>,
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
    /// Send one template to many recipients (CSV or JSON), paced under the daily cap.
    Broadcasts {
        #[command(subcommand)]
        cmd: BroadcastsCmd,
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
    /// Workspace settings.
    Settings {
        #[command(subcommand)]
        cmd: SettingsCmd,
    },
    /// Approval queue (the API refuses agent keys for approve/reject).
    Approvals {
        #[command(subcommand)]
        cmd: ApprovalsCmd,
    },
    /// Engage (on|pause) or release (off|resume) the kill switch. Engaging needs `manage`; releasing needs `admin`.
    KillSwitch { state: OnOff },
    /// SPEC name for `kill-switch on`.
    Pause,
    /// SPEC name for `kill-switch off`.
    Resume,
    /// Check port 25, FCrDNS, blocklists, DNS records, delivery path.
    Doctor {
        /// Public egress IP to check FCrDNS and blocklists for (or MAILCRAFT_EGRESS_IP).
        #[arg(long)]
        ip: Option<String>,
    },
}

#[derive(clap::ValueEnum, Clone)]
enum OnOff {
    #[value(alias = "pause")]
    On,
    #[value(alias = "resume")]
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
        /// Mailbox relay (Zoho, Gmail/Workspace, Outlook): send as the --username address.
        /// Bounces then go to that mailbox instead of mailcraft.
        #[arg(long)]
        mailbox_sender: bool,
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
    /// Event timeline (delivered, bounced, ...).
    Events {
        id: String,
    },
    /// Cancel a queued, deferred or pending_approval email.
    Cancel {
        id: String,
    },
    List {
        #[arg(long)]
        status: Option<String>,
        /// transactional | marketing
        #[arg(long)]
        stream: Option<String>,
        /// test | live
        #[arg(long)]
        env: Option<String>,
        /// Substring of to / from / subject (or an exact email id).
        #[arg(long)]
        q: Option<String>,
        /// Created at or after (YYYY-MM-DD or RFC 3339).
        #[arg(long)]
        from: Option<String>,
        /// Created at or before (RFC 3339, or the end of that YYYY-MM-DD day).
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        cursor: Option<String>,
    },
}

#[derive(Subcommand)]
enum BroadcastsCmd {
    /// Mail every recipient (up to 5000). Try --dry-run first: it lists skipped rows and the schedule.
    Create {
        /// Template id or alias.
        #[arg(long)]
        template: String,
        /// Sender, on a verified domain (a test key needs none).
        #[arg(long)]
        from: String,
        /// CSV with a header row: email, first_name, last_name; other columns are {{ data.<column> }}.
        #[arg(long)]
        csv: Option<String>,
        /// Recipients as a JSON array (or @file): [{"email", "first_name"?, "last_name"?, "data"?}].
        #[arg(long, conflicts_with = "csv")]
        recipients: Option<String>,
        /// Replaces the template subject; may use the same variables.
        #[arg(long)]
        subject: Option<String>,
        /// transactional | marketing (default marketing).
        #[arg(long)]
        stream: Option<String>,
        /// Upper bound on sends per day (the lowest of this and the transport/key caps applies).
        #[arg(long)]
        max_per_day: Option<u32>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    List {
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// One broadcast: counts, skipped rows and each recipient's email status.
    #[command(alias = "show")]
    Get {
        id: String,
        /// Only recipients whose email has this status.
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Render the template for one recipient as it would be sent. Sends nothing.
    Preview {
        #[arg(long)]
        template: String,
        #[arg(long)]
        email: String,
        #[arg(long)]
        first_name: Option<String>,
        #[arg(long)]
        last_name: Option<String>,
        /// Extra columns ({{ data.<column> }}) as JSON (or @file).
        #[arg(long)]
        data: Option<String>,
        #[arg(long)]
        subject: Option<String>,
        #[arg(long)]
        stream: Option<String>,
    },
}

#[derive(Subcommand)]
enum TemplatesCmd {
    List,
    /// Version history, newest first (`published` marks the live one).
    Versions {
        /// Template id or alias.
        id: String,
    },
    /// Copy an older version into a new draft (history is kept; `publish` it to go live).
    Restore {
        id: String,
        version: i32,
    },
    /// Delete the unpublished versions newer than the published one. Cannot be undone.
    DiscardDraft {
        id: String,
    },
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
    /// Render with sample data merged with --data. Sends nothing.
    Preview {
        id: String,
        /// Template variables as JSON (or @file).
        #[arg(long)]
        data: Option<String>,
        /// Render this saved version (default newest).
        #[arg(long, conflicts_with = "file")]
        version: Option<i32>,
        /// Render unsaved content from a .html / .mjml / .json file; nothing is stored.
        #[arg(long)]
        file: Option<String>,
        /// html | mjml | json (default: the file extension).
        #[arg(long, requires = "file")]
        format: Option<String>,
        #[arg(long, requires = "file")]
        subject: Option<String>,
        #[arg(long, requires = "file")]
        preheader: Option<String>,
    },
    /// Make a template version live (what sends use). Defaults to the newest version.
    Publish {
        /// Template id or alias.
        id: String,
        #[arg(long)]
        version: Option<i32>,
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
    /// Upsert contacts from a CSV (header row: email, first_name, last_name, timezone; other columns become properties).
    Import {
        /// CSV file.
        file: String,
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    Get {
        email: String,
    },
    Upsert {
        email: String,
        /// Properties as JSON (or @file).
        #[arg(long)]
        data: Option<String>,
        #[arg(long)]
        first_name: Option<String>,
        /// IANA timezone (e.g. Europe/Berlin); drives quiet hours.
        #[arg(long)]
        timezone: Option<String>,
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
    /// Archived automations are hidden unless --status archived.
    List {
        /// draft | active | paused | archived
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Archive a draft or paused automation.
    Archive {
        id: String,
    },
    /// Bring an archived automation back as a draft.
    Unarchive {
        id: String,
    },
    /// Start a run for one contact now, skipping the entry rule. A test key keeps mail in the sandbox; a live key sends.
    Test {
        /// Automation id or name.
        id: String,
        #[arg(long)]
        email: String,
        #[arg(long)]
        first_name: Option<String>,
        /// Properties of the simulated trigger event as JSON (or @file).
        #[arg(long)]
        data: Option<String>,
        /// Contact properties as JSON (or @file).
        #[arg(long)]
        contact_data: Option<String>,
    },
    /// Runs of an automation, newest first.
    Runs {
        id: String,
        /// active | waiting | completed | exited | failed
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// One run with its step log (poll after `test`).
    Run {
        id: String,
        run: String,
    },
    /// Resume a paused automation. A draft needs `publish` first.
    Enable {
        id: String,
    },
    /// Activate a draft (or newly imported version): `POST /v1/automations/{id}/publish`.
    Publish {
        /// Automation id or name.
        id: String,
        /// Do not mail contacts that already match the trigger.
        #[arg(long)]
        backfill_suppress: bool,
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
enum SettingsCmd {
    /// Writing instructions for LLM-written emails (admin key to change).
    Instructions {
        #[command(subcommand)]
        cmd: InstructionsCmd,
    },
}

#[derive(Subcommand)]
enum InstructionsCmd {
    /// Set the workspace instructions (max 2,000 characters), from the argument or --file.
    Set {
        text: Option<String>,
        #[arg(long, conflicts_with = "text")]
        file: Option<String>,
    },
    Get,
    Clear,
}

#[derive(Subcommand)]
enum ApprovalsCmd {
    List,
    Approve {
        id: String,
        /// Note kept with the decision (max 500 characters).
        #[arg(long)]
        reason: Option<String>,
    },
    Reject {
        id: String,
        /// Note kept with the decision (max 500 characters).
        #[arg(long)]
        reason: Option<String>,
    },
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

fn query(base: &str, kv: &[(&str, Option<&String>)]) -> String {
    let q: Vec<String> = kv
        .iter()
        .filter_map(|(k, v)| v.map(|v| format!("{k}={}", enc(v))))
        .collect();
    if q.is_empty() {
        base.into()
    } else {
        format!("{base}?{}", q.join("&"))
    }
}

fn page(
    base: &str,
    status: Option<&String>,
    limit: Option<u32>,
    cursor: Option<&String>,
) -> String {
    query(
        base,
        &[
            ("status", status),
            ("limit", limit.map(|l| l.to_string()).as_ref()),
            ("cursor", cursor),
        ],
    )
}

/// Ask before something that mails people or deletes data. `--yes`, `--non-interactive` and a
/// non-TTY stdin skip the prompt.
fn confirm(cli: &Cli, q: &str) -> Result<(), CliErr> {
    if !cli.yes
        && !cli.non_interactive
        && std::io::stdin().is_terminal()
        && prompt(&format!("{q} (yes/no)"), "no", true) != "yes"
    {
        return Err(CliErr::usage("aborted"));
    }
    Ok(())
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
    let mut cfg = Config::load(cli.profile.as_deref());
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
                    mailbox_sender,
                } => {
                    let pw = password
                        .clone()
                        .or_else(|| std::env::var("MAILCRAFT_SMTP_PASSWORD").ok());
                    // `custom` means no preset: host/port come from the flags.
                    let preset = (preset != "custom").then_some(preset);
                    let body = json!({"kind": "smtp-relay", "preset": preset,
                        "config": {"host": host, "port": port, "username": username, "password": pw,
                            "mailbox_sender": mailbox_sender}});
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
                EmailsCmd::Events { id } => ok(api.get(&format!("/v1/emails/{}/events", enc(id)))?),
                EmailsCmd::Cancel { id } => {
                    ok(api.post(&format!("/v1/emails/{}/cancel", enc(id)), &json!({}), None)?)
                }
                EmailsCmd::List {
                    status,
                    stream,
                    env,
                    q,
                    from,
                    to,
                    limit,
                    cursor,
                } => ok(api.get(&query(
                    "/v1/emails",
                    &[
                        ("status", status.as_ref()),
                        ("stream", stream.as_ref()),
                        ("env", env.as_ref()),
                        ("q", q.as_ref()),
                        ("from", from.as_ref()),
                        ("to", to.as_ref()),
                        ("limit", limit.map(|l| l.to_string()).as_ref()),
                        ("cursor", cursor.as_ref()),
                    ],
                ))?),
            }
        }
        Cmd::Broadcasts { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                BroadcastsCmd::Create {
                    template,
                    from,
                    csv,
                    recipients,
                    subject,
                    stream,
                    max_per_day,
                    dry_run,
                    idempotency_key,
                } => {
                    let rows = match (csv, recipients) {
                        (Some(f), None) => csv::recipients(&read_file(f)?)?,
                        (None, Some(_)) => match json_arg(recipients, "--recipients")? {
                            Value::Array(a) => a,
                            _ => return Err(CliErr::usage("--recipients must be a JSON array")),
                        },
                        _ => return Err(CliErr::usage("give --csv <file> or --recipients <json>")),
                    };
                    let mut b = json!({"template_id": template, "from": from, "recipients": rows, "dry_run": dry_run});
                    for (k, v) in [("subject", subject), ("stream", stream)] {
                        if let Some(v) = v {
                            b[k] = json!(v);
                        }
                    }
                    if let Some(n) = max_per_day {
                        b["max_per_day"] = json!(n);
                    }
                    if !dry_run {
                        let n = b["recipients"].as_array().map_or(0, Vec::len);
                        confirm(cli, &format!("Send `{template}` to {n} recipients?"))?;
                    }
                    ok(api.post("/v1/broadcasts", &b, idempotency_key.as_deref())?)
                }
                BroadcastsCmd::List { limit, cursor } => {
                    ok(api.get(&page("/v1/broadcasts", None, *limit, cursor.as_ref()))?)
                }
                BroadcastsCmd::Get {
                    id,
                    status,
                    limit,
                    cursor,
                } => ok(api.get(&page(
                    &format!("/v1/broadcasts/{}", enc(id)),
                    status.as_ref(),
                    *limit,
                    cursor.as_ref(),
                ))?),
                BroadcastsCmd::Preview {
                    template,
                    email,
                    first_name,
                    last_name,
                    data,
                    subject,
                    stream,
                } => {
                    let mut r = json!({"email": email});
                    for (k, v) in [("first_name", first_name), ("last_name", last_name)] {
                        if let Some(v) = v {
                            r[k] = json!(v);
                        }
                    }
                    if data.is_some() {
                        r["data"] = json_arg(data, "--data")?;
                    }
                    let mut b = json!({"template_id": template, "recipient": r});
                    for (k, v) in [("subject", subject), ("stream", stream)] {
                        if let Some(v) = v {
                            b[k] = json!(v);
                        }
                    }
                    ok(api.post("/v1/broadcasts/preview", &b, None)?)
                }
            }
        }
        Cmd::Templates { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                TemplatesCmd::List => ok(api.get("/v1/templates")?),
                TemplatesCmd::Versions { id } => {
                    ok(api.get(&format!("/v1/templates/{}/versions", enc(id)))?)
                }
                TemplatesCmd::Restore { id, version } => ok(api.post(
                    &format!("/v1/templates/{}/versions/{version}/restore", enc(id)),
                    &json!({}),
                    None,
                )?),
                TemplatesCmd::DiscardDraft { id } => {
                    confirm(
                        cli,
                        &format!("Discard the unpublished draft of {id}? This cannot be undone."),
                    )?;
                    ok(api.call(
                        "DELETE",
                        &format!("/v1/templates/{}/draft", enc(id)),
                        None,
                        None,
                    )?)
                }
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
                TemplatesCmd::Publish { id, version } => {
                    let b = match version {
                        Some(v) => json!({"version": v}),
                        None => json!({}),
                    };
                    ok(api.post(&format!("/v1/templates/{}/publish", enc(id)), &b, None)?)
                }
                TemplatesCmd::Preview {
                    id,
                    data,
                    version,
                    file,
                    format,
                    subject,
                    preheader,
                } => {
                    let mut b = json!({"variables": json_arg(data, "--data")?});
                    if let Some(v) = version {
                        b["version"] = json!(v);
                    }
                    if let Some(f) = file {
                        let ext = std::path::Path::new(f)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("json");
                        let text = read_file(f)?;
                        match format.as_deref().unwrap_or(ext) {
                            "html" => b["html"] = json!(text),
                            "mjml" => b["mjml"] = json!(text),
                            "json" => {
                                b["format"] = json!("json");
                                b["content"] = serde_json::from_str(&text).map_err(|e| {
                                    CliErr::usage(format!("{f} is not valid JSON: {e}"))
                                })?;
                            }
                            o => {
                                return Err(CliErr::usage(format!("unknown --format {o}"))
                                    .hint("html | mjml | json"))
                            }
                        }
                        for (k, v) in [("subject", subject), ("preheader", preheader)] {
                            if let Some(v) = v {
                                b[k] = json!(v);
                            }
                        }
                    }
                    ok(api.post(&format!("/v1/templates/{}/preview", enc(id)), &b, None)?)
                }
            }
        }
        Cmd::Contacts { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                ContactsCmd::List { limit, cursor } => {
                    ok(api.get(&page("/v1/contacts", None, *limit, cursor.as_ref()))?)
                }
                ContactsCmd::Import {
                    file,
                    idempotency_key,
                } => {
                    let rows = csv::contacts(&read_file(file)?)?;
                    let (mut imported, mut failed) = (0, vec![]);
                    let chunks = rows.chunks(csv::MAX_ROWS);
                    let multi = chunks.len() > 1;
                    for (n, chunk) in chunks.enumerate() {
                        // one key per chunk, so a retry replays the finished chunks
                        let key = idempotency_key.as_ref().map(|k| {
                            if multi {
                                format!("{k}-{n}")
                            } else {
                                k.clone()
                            }
                        });
                        let r = api.post(
                            "/v1/contacts/import",
                            &json!({"contacts": chunk}),
                            key.as_deref(),
                        )?;
                        imported += r.data()["imported"].as_u64().unwrap_or(0);
                        for mut f in r.data()["failed"].as_array().cloned().unwrap_or_default() {
                            // index counts data rows of the whole file, not of the chunk
                            f["index"] = json!(
                                f["index"].as_u64().unwrap_or(0) + (n * csv::MAX_ROWS) as u64
                            );
                            failed.push(f);
                        }
                    }
                    Ok(Out::new(json!({"imported": imported, "failed": failed})))
                }
                ContactsCmd::Get { email } => ok(api.get(&format!("/v1/contacts/{}", enc(email)))?),
                ContactsCmd::Upsert {
                    email,
                    data,
                    first_name,
                    timezone,
                } => {
                    let mut b = json!({"email": email, "properties": json_arg(data, "--data")?});
                    if let Some(f) = first_name {
                        b["first_name"] = json!(f);
                    }
                    if let Some(tz) = timezone {
                        b["timezone"] = json!(tz);
                    }
                    ok(api.call("PUT", "/v1/contacts", Some(&b), None)?)
                }
                ContactsCmd::Delete { email } => {
                    confirm(cli, &format!("Delete {email}?"))?;
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
                AutomationsCmd::List {
                    status,
                    limit,
                    cursor,
                } => ok(api.get(&page(
                    "/v1/automations",
                    status.as_ref(),
                    *limit,
                    cursor.as_ref(),
                ))?),
                AutomationsCmd::Archive { id } => ok(api.post(
                    &format!("/v1/automations/{}/archive", enc(id)),
                    &json!({}),
                    None,
                )?),
                AutomationsCmd::Unarchive { id } => ok(api.post(
                    &format!("/v1/automations/{}/unarchive", enc(id)),
                    &json!({}),
                    None,
                )?),
                AutomationsCmd::Test {
                    id,
                    email,
                    first_name,
                    data,
                    contact_data,
                } => {
                    if cfg.api_key.as_deref().is_some_and(|k| k.starts_with("mc_live_")) {
                        confirm(cli, &format!("Run `{id}` for {email} with a LIVE key? Its emails are really sent."))?;
                    }
                    let mut b = json!({"email": email});
                    if let Some(f) = first_name {
                        b["first_name"] = json!(f);
                    }
                    if data.is_some() {
                        b["properties"] = json_arg(data, "--data")?;
                    }
                    if contact_data.is_some() {
                        b["contact_properties"] = json_arg(contact_data, "--contact-data")?;
                    }
                    ok(api.post(&format!("/v1/automations/{}/test", enc(id)), &b, None)?)
                }
                AutomationsCmd::Runs {
                    id,
                    status,
                    limit,
                    cursor,
                } => ok(api.get(&page(
                    &format!("/v1/automations/{}/runs", enc(id)),
                    status.as_ref(),
                    *limit,
                    cursor.as_ref(),
                ))?),
                AutomationsCmd::Run { id, run } => ok(api.get(&format!(
                    "/v1/automations/{}/runs/{}",
                    enc(id),
                    enc(run)
                ))?),
                AutomationsCmd::Enable { id } => ok(api
                    .post(
                        &format!("/v1/automations/{}/resume", enc(id)),
                        &json!({}),
                        None,
                    )
                    .map_err(|e| {
                        if e.code == "invalid_state" && e.message.contains("`draft`") {
                            e.hint(&format!(
                                "a draft is not live yet: run `mailcraft automations publish {id}` (publishes and activates)"
                            ))
                        } else {
                            e
                        }
                    })?),
                AutomationsCmd::Publish {
                    id,
                    backfill_suppress,
                } => ok(api.post(
                    &format!("/v1/automations/{}/publish", enc(id)),
                    &json!({"backfill_suppress": backfill_suppress}),
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
        Cmd::Settings {
            cmd: SettingsCmd::Instructions { cmd },
        } => {
            let api = require_key(&cfg)?;
            let text = match cmd {
                InstructionsCmd::Get => None,
                InstructionsCmd::Clear => Some(String::new()),
                InstructionsCmd::Set { text, file } => Some(match (text, file) {
                    (Some(t), None) => t.clone(),
                    (None, Some(f)) => read_file(f)?,
                    _ => return Err(CliErr::usage("give the instructions text or --file")),
                }),
            };
            let resp = match text {
                Some(t) => api.call(
                    "PUT",
                    "/v1/settings",
                    Some(&json!({"custom_instructions": t})),
                    None,
                )?,
                None => api.get("/v1/settings")?,
            };
            Ok(Out {
                request_id: resp.body["request_id"].as_str().map(String::from),
                data: json!({"custom_instructions": resp.data()["custom_instructions"]}),
                exit: exit::OK,
            })
        }
        Cmd::Approvals { cmd } => {
            let api = require_key(&cfg)?;
            match cmd {
                ApprovalsCmd::List => ok(api.get("/v1/approvals")?),
                ApprovalsCmd::Approve { id, reason } | ApprovalsCmd::Reject { id, reason } => {
                    let d = if matches!(cmd, ApprovalsCmd::Approve { .. }) {
                        "approve"
                    } else {
                        "reject"
                    };
                    let mut b = json!({"decision": d});
                    if let Some(r) = reason {
                        b["reason"] = json!(r);
                    }
                    ok(api.post(&format!("/v1/approvals/{}/decide", enc(id)), &b, None)?)
                }
            }
        }
        Cmd::KillSwitch { .. } | Cmd::Pause | Cmd::Resume => {
            let on = match &cli.cmd {
                Cmd::KillSwitch { state } => matches!(state, OnOff::On),
                c => matches!(c, Cmd::Pause),
            };
            let api = require_key(&cfg)?;
            ok(api.post("/v1/kill-switch", &json!({"on": on}), None)?)
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

    let mut admin_key: Option<String> = None;
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
            admin_key = r.data()["admin_key"].as_str().map(String::from);
            r.data()["test_key"]
                .as_str()
                .ok_or_else(|| {
                    CliErr::new("bad_response", "setup returned no test_key", exit::FAILURE)
                })?
                .to_string()
        }
    };
    cfg.api_key = Some(key.clone());
    // `default` = test key, `admin` = admin key; `--profile admin` / MAILCRAFT_PROFILE=admin selects it.
    cfg.profile = "default".into();
    let extra: Vec<(&str, &str)> = admin_key.iter().map(|k| ("admin", k.as_str())).collect();
    let path = cfg.save(&extra)?;
    if let Some(k) = &admin_key {
        eprintln!(
            "\nADMIN KEY (shown once, store it now, it won't be shown again):\n  {k}\nSaved as profile `admin` in {}; use `--profile admin` for approvals / go-live.\n",
            path.display()
        );
    }
    steps.push(json!({"step": "key", "status": "pass", "created": admin_key.is_some(), "env": if key.starts_with("mc_live_") { "live" } else { "test" },
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
    if admin_key.is_some() {
        next_steps.push(
            "Approvals and go-live need the admin key: `mailcraft --profile admin approvals list`"
                .into(),
        );
    }
    next_steps.extend([
        "`mailcraft doctor --json` to check the environment".into(),
        "Use the test key until a human approves go-live".into(),
    ]);
    let failed = steps.iter().any(|s| s["status"] == "fail");
    Ok(Out {
        data: json!({"steps": steps, "account": sd, "next_steps": next_steps,
            "admin_key": admin_key, "admin_key_notice": admin_key.as_ref().map(|_| "store this now, it won't be shown again; also saved as profile `admin`")}),
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
