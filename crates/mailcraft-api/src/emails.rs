//! `/v1/emails`: send (single + batch), dry run, list/get/cancel/events.
//!
//! Gate order for a send (SPEC 3.1): auth + scope -> validate -> kill switch -> go-live ->
//! verified domain -> recipient rules -> suppression -> compliance -> policy -> caps -> enqueue.
//! Test keys never reach a transport: rows are stored with `env = 'test'` and the worker routes
//! them to the sandbox, simulating the magic address outcome (`mailcraft_core::address`).
use std::collections::BTreeMap;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use mailcraft_core::{
    address::{self, magic_outcome},
    auth::{KeyEnv, Scope},
    policy, Error, Policy, Stream,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::{ApiKey, Auth},
    caps::{self, Reservation},
    error::{envelope, envelope_list, err, invalid, not_found, ApiError, ApiJson, ApiResult},
    idem::{Begin, Guard},
    senders,
    state::AppState,
    webhooks,
};

const MAX_RECIPIENTS: usize = 50;
const MAX_BATCH: usize = 100;
const MAX_BODY: usize = 2_000_000;
/// Characters of html / text returned by GET /v1/emails/{id} (and approval previews).
pub(crate) const BODY_CAP: i32 = 200_000;

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct TemplateRef {
    pub id: String,
    #[serde(default)]
    pub variables: Option<Value>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct SendEmail {
    #[serde(default)]
    pub from: Option<String>,
    pub to: Vec<String>,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub template: Option<TemplateRef>,
    #[serde(default)]
    pub stream: Option<Stream>,
    #[serde(default)]
    pub tags: Option<Vec<Value>>,
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub scheduled_at: Option<DateTime<Utc>>,
    /// Send through this transport instead of the one the `from` address routes to.
    #[serde(default)]
    pub transport_id: Option<Uuid>,
    #[serde(default)]
    pub dry_run: bool,
}

pub(crate) struct Prepared {
    pub(crate) from: String,
    pub(crate) from_domain: String,
    pub(crate) to: Vec<String>,
    pub(crate) subject: String,
    pub(crate) html: Option<String>,
    pub(crate) text: Option<String>,
    pub(crate) reply_to: Option<String>,
    pub(crate) template_id: Option<Uuid>,
    pub(crate) vars: Option<Value>,
    pub(crate) stream: Stream,
    pub(crate) tags: Value,
    pub(crate) headers: Value,
    pub(crate) scheduled_at: Option<DateTime<Utc>>,
    pub(crate) transport_id: Option<Uuid>,
}

pub(crate) fn stream_str(s: Stream) -> &'static str {
    match s {
        Stream::Transactional => "transactional",
        Stream::Marketing => "marketing",
    }
}

pub(crate) fn no_ctl(v: &str, field: &'static str) -> ApiResult<()> {
    if v.chars().any(|c| c.is_control() && c != '\t') {
        return Err(invalid("control characters are not allowed in header values").field(field));
    }
    Ok(())
}

pub(crate) async fn prepare(st: &AppState, key: &ApiKey, r: &SendEmail) -> ApiResult<Prepared> {
    if r.to.is_empty() || r.to.len() > MAX_RECIPIENTS {
        return Err(invalid(format!("`to` needs 1-{MAX_RECIPIENTS} recipients")).field("to"));
    }
    let mut to = Vec::new();
    for t in &r.to {
        let (_, a) = address::parse_mailbox(t)
            .ok_or_else(|| invalid(format!("`{t}` is not a valid email address")).field("to"))?;
        if !to.contains(&a) {
            to.push(a);
        }
    }
    let from_raw = match (&r.from, key.env) {
        (Some(f), _) => f.clone(),
        (None, KeyEnv::Test) => format!("mailcraft test <noreply@{}>", address::MAGIC_DOMAIN),
        (None, KeyEnv::Live) => {
            return Err(invalid("`from` is required")
                .field("from")
                .hint_in("use an address on a verified domain"))
        }
    };
    let (from_name, from_addr) = address::parse_mailbox(&from_raw)
        .ok_or_else(|| invalid("`from` is not a valid mailbox").field("from"))?;
    // A bare address that is a connected mailbox goes out under its display name.
    let from_raw = if from_name.is_none() {
        senders::labelled(&senders::relays(st, key.workspace_id).await?, &from_addr)
    } else {
        from_raw
    };
    let reply_to = match &r.reply_to {
        Some(rt) => Some(
            address::parse_mailbox(rt)
                .ok_or_else(|| invalid("`reply_to` is not a valid mailbox").field("reply_to"))?
                .1,
        ),
        None => None,
    };
    let subject = r.subject.clone().unwrap_or_default();
    no_ctl(&subject, "subject")?;
    if subject.len() > 998 {
        return Err(invalid("subject is too long").field("subject"));
    }
    if r.html.as_deref().map_or(0, str::len) + r.text.as_deref().map_or(0, str::len) > MAX_BODY {
        return Err(invalid("body exceeds 2 MB").field("html"));
    }
    let mut template_id = None;
    if let Some(t) = &r.template {
        template_id = Some(
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM templates WHERE workspace_id = $1 AND (alias = $2 OR id::text = $2)",
            )
            .bind(key.workspace_id)
            .bind(&t.id)
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| err("not_found", 404, format!("template `{}` not found", t.id)).field("template.id"))?,
        );
    } else if r.html.is_none() && r.text.is_none() {
        return Err(invalid("provide `html`, `text` or `template`").field("html"));
    }
    if r.template.is_none() && subject.is_empty() {
        return Err(invalid("`subject` is required without a template").field("subject"));
    }
    let mut headers = serde_json::Map::new();
    for (k, v) in r.headers.iter().flatten() {
        let lk = k.to_ascii_lowercase();
        if !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || k.is_empty() {
            return Err(invalid(format!("invalid header name `{k}`")).field("headers"));
        }
        // Headers the platform owns: never client-controlled (deliverability + injection safety).
        if [
            "from",
            "to",
            "cc",
            "bcc",
            "subject",
            "date",
            "message-id",
            "dkim-signature",
            "return-path",
            "list-unsubscribe",
            "list-unsubscribe-post",
            "content-type",
            "mime-version",
        ]
        .contains(&lk.as_str())
        {
            return Err(invalid(format!("header `{k}` is managed by mailcraft")).field("headers"));
        }
        no_ctl(v, "headers")?;
        headers.insert(k.clone(), Value::String(v.clone()));
    }
    Ok(Prepared {
        from: from_raw.trim().to_string(),
        from_domain: address::domain_of(&from_addr).to_string(),
        to,
        subject,
        html: r.html.clone(),
        text: r.text.clone(),
        reply_to,
        template_id,
        vars: r.template.as_ref().and_then(|t| t.variables.clone()),
        stream: r.stream.unwrap_or(Stream::Transactional),
        tags: Value::Array(r.tags.clone().unwrap_or_default()),
        headers: Value::Object(headers),
        scheduled_at: r.scheduled_at,
        transport_id: r.transport_id,
    })
}

pub(crate) struct Plan {
    pub(crate) policy: Policy,
    pub(crate) decisions: Vec<Value>,
    pub(crate) domain_id: Option<Uuid>,
    /// Pinned on `emails.transport_id`; `None` for sandbox sends (they never reach a transport).
    pub(crate) transport: Option<(Uuid, String)>,
}

async fn blocked(st: &AppState, key: &ApiKey, rule: &str, e: Error, record: bool) -> ApiError {
    st.metrics
        .policy_decisions
        .with_label_values(&["blocked", "send"])
        .inc();
    if record {
        let _ = audit::append_standalone(
            &st.db,
            key.workspace_id,
            Actor::Key(key),
            Entry {
                action: "email.send",
                args: json!({"rule": rule, "code": e.code}),
                decision: "blocked",
                approval_id: None,
            },
        )
        .await;
    }
    ApiError(e)
}

pub(crate) async fn plan(
    st: &AppState,
    key: &ApiKey,
    p: &Prepared,
    record: bool,
) -> ApiResult<Plan> {
    let (kill, live, legal, postal): (bool, bool, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT kill_switch, live_enabled, legal_name, postal_address FROM workspaces WHERE id = $1",
    )
    .bind(key.workspace_id)
    .fetch_one(&st.db)
    .await?;
    if kill || key.paused {
        let scope = if kill { "workspace" } else { "this API key" };
        return Err(blocked(
            st,
            key,
            "kill_switch",
            Error::new(
                "kill_switch_active",
                403,
                format!("the kill switch is engaged for {scope}"),
            )
            .hint(
                "a human must disengage it (POST /v1/kill-switch {\"on\":false} with an admin key)",
            ),
            record,
        )
        .await);
    }
    let mut decisions = vec![json!({"rule": "kill_switch", "decision": "pass"})];
    let mut domain_id = None;
    let mut transport = None;
    match key.env {
        KeyEnv::Live => {
            if !live {
                return Err(blocked(st, key, "go_live", Error::new("blocked_by_policy", 403, "this workspace is not approved for live sending")
                    .hint("request go-live (POST /v1/go-live-requests); a human approves it. Use a mc_test_ key meanwhile"), record).await);
            }
            // A mailbox relay (Zoho, Workspace, Outlook) only sends as the addresses it is signed in
            // with (login + "send as" aliases) and signs with the provider's own SPF/DKIM, so that is
            // the proof of ownership: mailcraft's own domain records add nothing there.
            let rt = senders::Routing::load(st, key.workspace_id).await?;
            if p.transport_id.is_some_and(|t| !rt.has_transport(t)) {
                return Err(err("not_found", 404, "transport not found")
                    .field("transport_id")
                    .hint_in("list them with GET /v1/transports"));
            }
            let from_addr = address::parse_mailbox(&p.from).map_or_else(String::new, |m| m.1);
            let route = rt.route(&from_addr, p.transport_id);
            if !route.allowed() {
                return Err(err("domain_not_verified", 422, format!("cannot send from {}: domain is not verified", p.from_domain))
                    .field("from")
                    .hint_in("add it with POST /v1/domains and publish the returned DNS records, then verify"));
            }
            let dom = route.domain_id.unwrap_or_else(Uuid::nil);
            if key.domain_id.is_some_and(|d| d != dom) {
                return Err(blocked(
                    st,
                    key,
                    "key_domain",
                    Error::new(
                        "blocked_by_policy",
                        403,
                        "this key may only send from its own domain",
                    )
                    .field("from"),
                    record,
                )
                .await);
            }
            domain_id = (!dom.is_nil()).then_some(dom);
            if p.stream == Stream::Marketing && (legal.is_none() || postal.is_none()) {
                return Err(invalid(
                    "marketing sends need the workspace legal name and postal address",
                )
                .field("stream")
                .hint_in("set them on the workspace (CAN-SPAM footer requirement)"));
            }
            if let Some(al) = &key.allowlist {
                if let Some(bad) = p.to.iter().find(|t| !address::allowlist_matches(al, t)) {
                    return Err(blocked(
                        st,
                        key,
                        "allowlist",
                        Error::new(
                            "recipient_not_allowed",
                            403,
                            format!("{bad} is not on this key's recipient allowlist"),
                        )
                        .field("to")
                        .hint("ask an admin to extend the allowlist (agents cannot raise limits)"),
                        record,
                    )
                    .await);
                }
            }
            decisions.push(json!({
                "rule": "routing", "decision": "transport", "why": route.why,
                "transport": route.transport.as_ref().map(|t| &t.1),
                "transport_id": route.transport.as_ref().map(|t| t.0),
            }));
            transport = route.transport;
        }
        KeyEnv::Test => {
            // Sandbox sends pin no transport, but a named one must still be this workspace's.
            if let Some(t) = p.transport_id {
                let ok: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM transports WHERE id = $1 AND workspace_id = $2)",
                )
                .bind(t)
                .bind(key.workspace_id)
                .fetch_one(&st.db)
                .await?;
                if !ok {
                    return Err(err("not_found", 404, "transport not found")
                        .field("transport_id")
                        .hint_in("list them with GET /v1/transports"));
                }
            }
            let al = key.allowlist.as_deref().unwrap_or(&[]);
            if let Some(bad) =
                p.to.iter()
                    .find(|t| magic_outcome(t).is_none() && !address::allowlist_matches(al, t))
            {
                return Err(err("test_key_live_recipient", 403, format!("{bad} is not a test address; test keys never send to real recipients"))
                    .field("to")
                    .hint_in("use delivered@, bounced@, complained@, suppressed@ or deferred@ test.mailcraft.local, or a live key"));
            }
            let outcomes: Vec<_> =
                p.to.iter()
                    .map(|t| json!({"to": t, "simulate": magic_outcome(t)}))
                    .collect();
            decisions
                .push(json!({"rule": "routing", "decision": "sandbox", "recipients": outcomes}));
        }
    }
    let supp: Vec<String> = sqlx::query_scalar(
        "SELECT email FROM suppressions WHERE workspace_id = $1 AND email = ANY($2)",
    )
    .bind(key.workspace_id)
    .bind(&p.to)
    .fetch_all(&st.db)
    .await?;
    if !supp.is_empty() {
        return Err(err(
            "recipient_suppressed",
            422,
            format!("suppressed recipient(s): {}", supp.join(", ")),
        )
        .field("to")
        .hint_in(
            "remove them from `to`; suppression is removed only by DELETE /v1/suppressions/{email}",
        ));
    }
    // Key policy wins; an unset key action falls back to the workspace default (`settings.policy_default`).
    let pol = if key.policy.get("send").is_some_and(|v| !v.is_null()) {
        policy::for_action(&key.policy, "send")
    } else {
        let d: Option<Value> =
            sqlx::query_scalar("SELECT settings -> 'policy_default' FROM workspaces WHERE id = $1")
                .bind(key.workspace_id)
                .fetch_one(&st.db)
                .await?;
        policy::for_action(&d.unwrap_or(Value::Null), "send")
    };
    st.metrics
        .policy_decisions
        .with_label_values(&[
            match pol {
                Policy::Auto => "auto",
                Policy::NeedsApproval => "needs_approval",
                Policy::Blocked => "blocked",
            },
            "send",
        ])
        .inc();
    decisions.push(json!({"rule": "send", "decision": pol}));
    if pol == Policy::Blocked {
        return Err(blocked(st, key, "policy", Error::new("blocked_by_policy", 403, "this key's policy blocks sending")
            .hint("an admin can change the key policy; agents may propose changes via POST /v1/policy/proposals"), record).await);
    }
    Ok(Plan {
        policy: pol,
        decisions,
        domain_id,
        transport,
    })
}

/// One `emails` row. Shared by single sends and broadcasts so both go through the same queue.
pub(crate) struct Row<'a> {
    pub id: Uuid,
    pub to: &'a str,
    pub subject: &'a str,
    pub vars: &'a Option<Value>,
    pub idem: Option<String>,
    pub status: &'a str,
    pub scheduled_at: Option<DateTime<Utc>>,
    pub max_age: DateTime<Utc>,
    /// `(broadcast id, contact id)` for broadcast rows (`source = 'broadcast'`).
    pub broadcast: Option<(Uuid, Option<Uuid>)>,
}

pub(crate) async fn insert_email(
    tx: &mut sqlx::PgConnection,
    key: &ApiKey,
    p: &Prepared,
    pl: &Plan,
    r: &Row<'_>,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO emails (id, workspace_id, api_key_id, domain_id, stream, env, source, from_addr, to_addr, reply_to, \
            subject, template_id, template_vars, headers, tags, idempotency_key, status, policy_decisions, \
            scheduled_at, next_attempt_at, max_age_at, broadcast_id, contact_id, transport_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$20,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($18, now()),$19,$21,$22,$23)",
    )
    .bind(r.id)
    .bind(key.workspace_id)
    .bind(key.id)
    .bind(pl.domain_id)
    .bind(stream_str(p.stream))
    .bind(key.env.as_str())
    .bind(&p.from)
    .bind(r.to)
    .bind(&p.reply_to)
    .bind(r.subject)
    .bind(p.template_id)
    .bind(r.vars)
    .bind(&p.headers)
    .bind(&p.tags)
    .bind(&r.idem)
    .bind(r.status)
    .bind(Value::Array(pl.decisions.clone()))
    .bind(r.scheduled_at)
    .bind(r.max_age)
    .bind(if r.broadcast.is_some() { "broadcast" } else { "api" })
    .bind(r.broadcast.map(|b| b.0))
    .bind(r.broadcast.and_then(|b| b.1))
    .bind(pl.transport.as_ref().map(|t| t.0))
    .execute(tx)
    .await?;
    Ok(())
}

/// Inserts one row per recipient (+ approval row when required). Returns the response data.
async fn enqueue(
    st: &AppState,
    key: &ApiKey,
    g: &mut Guard,
    p: &Prepared,
    pl: &Plan,
    item: usize,
) -> ApiResult<Value> {
    let needs_approval = pl.policy == Policy::NeedsApproval;
    let status = if needs_approval {
        "pending_approval"
    } else {
        "queued"
    };
    let mut recipients = Vec::new();
    let max_age = Utc::now() + chrono::Duration::hours(72);
    for (i, to) in p.to.iter().enumerate() {
        let id = Uuid::now_v7();
        let idem = g.row_key(item, i);
        insert_email(
            &mut g.tx,
            key,
            p,
            pl,
            &Row {
                id,
                to,
                subject: &p.subject,
                vars: &p.vars,
                idem,
                status,
                scheduled_at: p.scheduled_at,
                max_age,
                broadcast: None,
            },
        )
        .await?;
        if p.html.is_some() || p.text.is_some() {
            sqlx::query("INSERT INTO email_bodies (email_id, html, text) VALUES ($1,$2,$3)")
                .bind(id)
                .bind(&p.html)
                .bind(&p.text)
                .execute(&mut *g.tx)
                .await?;
        }
        st.metrics
            .emails
            .with_label_values(&[stream_str(p.stream), status, "", key.env.as_str()])
            .inc();
        recipients.push(json!({"email": to, "id": id}));
    }
    let first = recipients[0]["id"].as_str().unwrap_or_default().to_string();
    let mut data = json!({
        "id": first, "status": status, "stream": stream_str(p.stream),
        "policy_decisions": pl.decisions, "recipients": recipients,
    });
    let ids: Vec<&Value> = recipients.iter().map(|r| &r["id"]).collect();
    let mut approval = None;
    if needs_approval {
        let aid = Uuid::now_v7();
        sqlx::query("INSERT INTO approvals (id, workspace_id, kind, subject_id, requested_by, payload) VALUES ($1,$2,'email',$3,$4,$5)")
            .bind(aid)
            .bind(key.workspace_id)
            .bind(first.parse::<Uuid>().ok())
            .bind(key.id)
            .bind(json!({
                "email_ids": ids, "from": p.from, "to": p.to, "stream": stream_str(p.stream),
                "preview": {"subject": p.subject, "text": p.text.as_deref().map(|t| t.chars().take(500).collect::<String>()), "has_html": p.html.is_some()},
            }))
            .execute(&mut *g.tx)
            .await?;
        webhooks::enqueue(
            &mut g.tx,
            key.workspace_id,
            "approval.requested",
            json!({"approval_id": aid, "kind": "email"}),
        )
        .await?;
        data["approval_id"] = json!(aid);
        approval = Some(aid);
    }
    audit::append(
        &mut g.tx,
        key.workspace_id,
        Actor::Key(key),
        Entry {
            action: "email.send",
            args: json!({"email_ids": ids, "to": p.to, "from": p.from, "stream": stream_str(p.stream), "env": key.env.as_str()}),
            decision: if needs_approval { "needs_approval" } else { "auto" },
            approval_id: approval,
        },
    )
    .await?;
    Ok(data)
}

fn dry_run_preview(key: &ApiKey, p: &Prepared, pl: &Plan) -> Value {
    let mut lint = Vec::new();
    if p.text.is_none() && p.template_id.is_none() {
        lint.push(json!({"rule": "missing_text_part", "severity": "warning", "message": "no plain-text part; multipart/alternative improves deliverability"}));
    }
    if p.template_id.is_some() {
        lint.push(json!({"rule": "template_rendered_by_worker", "severity": "info", "message": "template output is rendered at send time"}));
    }
    json!({
        "dry_run": true, "status": if pl.policy == Policy::NeedsApproval { "pending_approval" } else { "queued" },
        "stream": stream_str(p.stream), "policy_decisions": pl.decisions,
        "rendered": {"subject": p.subject, "html": p.html, "text": p.text,
            "headers": {"From": p.from, "To": p.to.join(", "), "Subject": p.subject}},
        "lint": lint,
        "would_send_via": if key.env == KeyEnv::Test { "sandbox" } else { "transport" },
        "transport": pl.transport.as_ref().map(|t| &t.1),
    })
}

pub async fn send(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(req): ApiJson<SendEmail>,
) -> ApiResult {
    auth.require(Scope::Send)?;
    let key = &auth.0;
    let p = prepare(&st, key, &req).await?;
    if req.dry_run {
        let pl = plan(&st, key, &p, false).await?;
        return Ok(envelope(StatusCode::OK, dry_run_preview(key, &p, &pl)));
    }
    let mut g = match Guard::begin(&st, key, &headers, "POST /v1/emails", &req).await? {
        Begin::Replay(r) => return Ok(r),
        Begin::Fresh(g) => g,
    };
    let pl = plan(&st, key, &p, true).await?;
    let held = caps::reserve(&st, key, p.to.len() as i64).await?;
    let res = async {
        let data = enqueue(&st, key, &mut g, &p, &pl, 0).await?;
        g.finish(StatusCode::ACCEPTED, data).await
    }
    .await;
    if res.is_err() {
        held.release(&st).await;
    }
    res
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub emails: Vec<SendEmail>,
}

pub async fn batch(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(req): ApiJson<Batch>,
) -> ApiResult {
    auth.require(Scope::Send)?;
    let key = &auth.0;
    if req.emails.is_empty() || req.emails.len() > MAX_BATCH {
        return Err(invalid(format!("`emails` needs 1-{MAX_BATCH} items")).field("emails"));
    }
    if req.emails.iter().any(|e| e.dry_run) {
        return Err(
            invalid("dry_run is not supported in batch; call POST /v1/emails per item")
                .field("emails"),
        );
    }
    let mut g = match Guard::begin(&st, key, &headers, "POST /v1/emails/batch", &req).await? {
        Begin::Replay(r) => return Ok(r),
        Begin::Fresh(g) => g,
    };
    let mut held: Vec<Reservation> = Vec::new();
    let mut out = Vec::new();
    let mut fatal = None;
    for (i, item) in req.emails.iter().enumerate() {
        let r: ApiResult<Value> = async {
            let p = prepare(&st, key, item).await?;
            let pl = plan(&st, key, &p, true).await?;
            held.push(caps::reserve(&st, key, p.to.len() as i64).await?);
            enqueue(&st, key, &mut g, &p, &pl, i).await
        }
        .await;
        match r {
            Ok(d) => out.push(json!({"ok": true, "data": d})),
            Err(e) if e.0.status < 500 => out.push(json!({"ok": false, "error": e.0.body()})),
            Err(e) => {
                fatal = Some(e);
                break;
            }
        }
    }
    if let Some(e) = fatal {
        for h in held {
            h.release(&st).await;
        }
        return Err(e);
    }
    let res = g.finish(StatusCode::ACCEPTED, out).await;
    if res.is_err() {
        for h in held {
            h.release(&st).await;
        }
    }
    res
}

#[derive(sqlx::FromRow, Serialize)]
struct EmailRow {
    id: Uuid,
    status: String,
    stream: String,
    env: String,
    from_addr: String,
    to_addr: String,
    subject: String,
    tags: Value,
    policy_decisions: Value,
    scheduled_at: Option<DateTime<Utc>>,
    attempts: i32,
    last_error: Option<String>,
    sent_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

const EMAIL_COLS: &str = "id, status, stream, env, from_addr, to_addr, subject, tags, policy_decisions, scheduled_at, attempts, last_error, sent_at, created_at";

#[derive(Deserialize)]
pub struct ListQ {
    limit: Option<i64>,
    cursor: Option<String>,
    status: Option<String>,
    stream: Option<String>,
    env: Option<String>,
    /// Case-insensitive substring of to / from / subject (or an exact email id).
    q: Option<String>,
    /// created_at range: RFC 3339 or `YYYY-MM-DD` (`to` then includes that whole day).
    from: Option<String>,
    to: Option<String>,
}

/// `YYYY-MM-DD` or RFC 3339. `end` makes the bound exclusive: a date means the start of the next
/// day, a timestamp one microsecond later.
fn bound(v: &Option<String>, field: &'static str, end: bool) -> ApiResult<Option<DateTime<Utc>>> {
    let Some(v) = v.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let bad = || invalid(format!("`{field}` must be YYYY-MM-DD or RFC 3339")).field(field);
    if let Ok(d) = chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d") {
        let d = if end {
            d.succ_opt().ok_or_else(bad)?
        } else {
            d
        };
        return Ok(d.and_hms_opt(0, 0, 0).map(|t| t.and_utc()));
    }
    let t = DateTime::parse_from_rfc3339(v).map_err(|_| bad())?.to_utc();
    Ok(Some(if end {
        t + chrono::Duration::microseconds(1)
    } else {
        t
    }))
}

pub async fn list(State(st): State<AppState>, auth: Auth, Query(q): Query<ListQ>) -> ApiResult {
    auth.require(Scope::Read)?;
    let limit = q.limit.unwrap_or(25).clamp(1, 100);
    let (c_at, c_id) = match &q.cursor {
        Some(c) => {
            let (m, id) = c
                .split_once('.')
                .ok_or_else(|| invalid("bad cursor").field("cursor"))?;
            let at = m
                .parse::<i64>()
                .ok()
                .and_then(DateTime::from_timestamp_micros);
            let id = id.parse::<Uuid>().ok();
            if at.is_none() || id.is_none() {
                return Err(invalid("bad cursor").field("cursor"));
            }
            (at, id)
        }
        None => (None, None),
    };
    for (v, f, ok) in [
        (&q.stream, "stream", ["transactional", "marketing"]),
        (&q.env, "env", ["test", "live"]),
    ] {
        if v.as_deref().is_some_and(|v| !ok.contains(&v)) {
            return Err(invalid(format!("`{f}` must be {}", ok.join("|"))).field(f));
        }
    }
    let from = bound(&q.from, "from", false)?;
    let to = bound(&q.to, "to", true)?;
    // Trigram indexes (migration api_gaps) serve the ILIKEs.
    let needle = crate::services::like(q.q.as_deref());
    let by_id = q.q.as_deref().and_then(|s| s.trim().parse::<Uuid>().ok());
    let mut rows: Vec<EmailRow> = sqlx::query_as(&format!(
        "SELECT {EMAIL_COLS} FROM emails WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2) \
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4)) \
         AND ($6::text IS NULL OR stream = $6) AND ($7::text IS NULL OR env = $7) \
         AND ($8::timestamptz IS NULL OR created_at >= $8) AND ($9::timestamptz IS NULL OR created_at < $9) \
         AND ($10::text IS NULL OR to_addr ILIKE $10 OR from_addr ILIKE $10 OR subject ILIKE $10 OR id = $11) \
         ORDER BY created_at DESC, id DESC LIMIT $5"
    ))
    .bind(auth.0.workspace_id)
    .bind(&q.status)
    .bind(c_at)
    .bind(c_id)
    .bind(limit + 1)
    .bind(&q.stream)
    .bind(&q.env)
    .bind(from)
    .bind(to)
    .bind(needle)
    .bind(by_id)
    .fetch_all(&st.db)
    .await?;
    let next = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last()
            .map(|r| format!("{}.{}", r.created_at.timestamp_micros(), r.id))
    } else {
        None
    };
    Ok(envelope_list(rows, next))
}

pub async fn get(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Read)?;
    let row: EmailRow = sqlx::query_as(&format!(
        "SELECT {EMAIL_COLS} FROM emails WHERE id = $1 AND workspace_id = $2"
    ))
    .bind(id)
    .bind(auth.0.workspace_id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| not_found("email"))?;
    // Stored body: as sent, or rendered by the worker at dequeue (templates). Null until then.
    let (html, text, truncated): (Option<String>, Option<String>, bool) = sqlx::query_as(
        "SELECT left(html, $2), left(text, $2), COALESCE(length(html), 0) > $2 OR COALESCE(length(text), 0) > $2 \
         FROM email_bodies WHERE email_id = $1",
    )
    .bind(id)
    .bind(BODY_CAP)
    .fetch_optional(&st.db)
    .await?
    .unwrap_or((None, None, false));
    let mut out = serde_json::to_value(row).unwrap_or_default();
    out["html"] = json!(html);
    out["text"] = json!(text);
    out["body_truncated"] = json!(truncated);
    Ok(envelope(StatusCode::OK, out))
}

pub async fn events(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Read)?;
    type EventRow = (String, Option<String>, Option<String>, DateTime<Utc>);
    let rows: Vec<EventRow> = sqlx::query_as(
        "SELECT ev.type, ev.enhanced_code, ev.diagnostic, ev.occurred_at FROM email_events ev \
         JOIN emails e ON e.id = ev.email_id WHERE e.id = $1 AND e.workspace_id = $2 ORDER BY ev.id",
    )
    .bind(id)
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(t, c, d, at)| json!({"type": t, "enhanced_code": c, "diagnostic": d, "occurred_at": at}))
        .collect();
    Ok(envelope_list(items, None))
}

pub async fn cancel(State(st): State<AppState>, auth: Auth, Path(id): Path<Uuid>) -> ApiResult {
    auth.require(Scope::Send)?;
    let mut tx = st.db.begin().await?;
    let n = sqlx::query(
        "UPDATE emails SET status = 'cancelled' WHERE id = $1 AND workspace_id = $2 \
         AND status IN ('queued','deferred','pending_approval')",
    )
    .bind(id)
    .bind(auth.0.workspace_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT status FROM emails WHERE id = $1 AND workspace_id = $2")
                .bind(id)
                .bind(auth.0.workspace_id)
                .fetch_optional(&mut *tx)
                .await?;
        return Err(match exists {
            None => not_found("email"),
            Some(s) => err(
                "invalid_state",
                409,
                format!("email is already `{s}` and cannot be cancelled"),
            ),
        });
    }
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "email.cancel",
            args: json!({"email_id": id}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"id": id, "status": "cancelled"}),
    ))
}
