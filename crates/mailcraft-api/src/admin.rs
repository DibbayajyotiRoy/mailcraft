//! First-run setup, stats, settings, doctor and suppressions.
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use mailcraft_core::auth::{KeyEnv, Scope};
use mailcraft_deliverability::{
    dns::verify::HickoryDns,
    doctor::{self, Level},
    store::{postgres::PgDomains, DomainStore},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::Auth,
    error::{envelope, envelope_list, err, invalid, not_found, ApiJson, ApiResult},
    keys::{insert_key, CreateKey},
    page,
    state::AppState,
};

// ------------------------------------------------------------------- setup

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    #[serde(default)]
    pub admin_email: Option<String>,
}

fn key(name: &str, env: KeyEnv, scopes: &[Scope]) -> CreateKey {
    CreateKey {
        name: name.into(),
        env,
        scopes: scopes.to_vec(),
        domain_id: None,
        policy: None,
        recipient_allowlist: None,
        daily_send_cap: None,
        minute_send_cap: None,
        expires_at: None,
    }
}

/// Unauthenticated; works only while no API key exists (SPEC 16 first-run). Secrets are shown once.
pub async fn setup(State(st): State<AppState>, ApiJson(b): ApiJson<Setup>) -> ApiResult {
    if let Some(e) = &b.admin_email {
        if mailcraft_core::address::parse_mailbox(e).is_none() {
            return Err(invalid("admin_email is not an email address").field("admin_email"));
        }
    }
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('setup', 0))")
        .execute(&mut *tx)
        .await?;
    let used: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM api_keys)")
        .fetch_one(&mut *tx)
        .await?;
    if used {
        return Err(
            err("invalid_state", 409, "setup already ran: an API key exists").hint_in(
                "sign in with an existing key, or mint one with `mailcraft-server bootstrap`",
            ),
        );
    }
    let ws: Uuid = match sqlx::query_scalar("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")
        .fetch_optional(&mut *tx)
        .await?
    {
        Some(id) => id,
        None => {
            sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ('default') RETURNING id")
                .fetch_one(&mut *tx)
                .await?
        }
    };
    let all = [Scope::Read, Scope::Send, Scope::Manage, Scope::Admin];
    let (_, admin) = insert_key(&mut tx, ws, &key("admin", KeyEnv::Live, &all)).await?;
    let (_, test) = insert_key(&mut tx, ws, &key("test", KeyEnv::Test, &all[..3])).await?;
    if let Some(e) = &b.admin_email {
        sqlx::query("INSERT INTO users (workspace_id, email, role) VALUES ($1, lower($2), 'owner') ON CONFLICT (email) DO NOTHING")
            .bind(ws)
            .bind(e)
            .execute(&mut *tx)
            .await?;
    }
    audit::append(
        &mut tx,
        ws,
        Actor::System,
        Entry {
            action: "setup",
            args: json!({"admin_email": b.admin_email}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(
        StatusCode::CREATED,
        json!({"workspace_id": ws, "admin_key": admin, "test_key": test}),
    ))
}

// ------------------------------------------------------------------- status

/// `{kind, detail?}`: where a key's mail goes. Test keys always sandbox.
pub async fn delivery_path(st: &AppState, ws: Uuid, env: KeyEnv) -> Result<Value, sqlx::Error> {
    if env == KeyEnv::Test {
        return Ok(
            json!({"kind": "sandbox", "detail": "test keys deliver to the built-in sandbox inbox"}),
        );
    }
    let t: Option<(String, String)> =
        sqlx::query_as("SELECT kind, name FROM transports WHERE workspace_id = $1 ORDER BY is_default DESC, created_at LIMIT 1")
            .bind(ws)
            .fetch_optional(&st.db)
            .await?;
    Ok(match t {
        Some((kind, name)) => json!({"kind": kind, "detail": name}),
        None => json!({"kind": "sandbox", "detail": "no transport configured"}),
    })
}

// -------------------------------------------------------------------- stats

#[derive(Deserialize)]
pub struct StatsQ {
    days: Option<i64>,
}

pub async fn stats_overview(
    State(st): State<AppState>,
    auth: Auth,
    Query(q): Query<StatsQ>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let days = q.days.unwrap_or(7);
    if !(1..=90).contains(&days) {
        return Err(invalid("days must be 1-90").field("days"));
    }
    let today = Utc::now().date_naive();
    let from = today - Duration::days(days - 1);
    let rows: Vec<(NaiveDate, String, i64)> = sqlx::query_as(
        "SELECT (occurred_at AT TIME ZONE 'UTC')::date, type, count(*) FROM email_events \
         WHERE workspace_id = $1 AND (occurred_at AT TIME ZONE 'UTC')::date >= $2 \
           AND type IN ('sent','delivered','bounced','complained','delivery_delayed') GROUP BY 1, 2",
    )
    .bind(auth.0.workspace_id)
    .bind(from)
    .fetch_all(&st.db)
    .await?;
    let mut by_day: BTreeMap<NaiveDate, [i64; 5]> = (0..days)
        .map(|i| (from + Duration::days(i), [0; 5]))
        .collect();
    let mut totals = [0i64; 5];
    for (d, t, n) in rows {
        let i = [
            "sent",
            "delivered",
            "bounced",
            "complained",
            "delivery_delayed",
        ]
        .iter()
        .position(|x| *x == t)
        .unwrap();
        if let Some(c) = by_day.get_mut(&d) {
            c[i] = n;
        }
        totals[i] += n;
    }
    Ok(envelope(
        StatusCode::OK,
        json!({
            "totals": {"sent": totals[0], "delivered": totals[1], "bounced": totals[2], "complained": totals[3], "deferred": totals[4]},
            "series": by_day.into_iter().map(|(d, c)| json!({"date": d, "sent": c[0], "delivered": c[1], "bounced": c[2], "complained": c[3]})).collect::<Vec<_>>(),
        }),
    ))
}

// ----------------------------------------------------------------- settings

const LLM_KINDS: [&str; 3] = ["openrouter", "openai", "ollama"];
const LLM_KEY_AAD: &[u8] = b"settings:llm_api_key";

async fn settings_view(st: &AppState, auth: &Auth) -> Result<Value, sqlx::Error> {
    let s: Value = sqlx::query_scalar("SELECT settings FROM workspaces WHERE id = $1")
        .bind(auth.0.workspace_id)
        .fetch_one(&st.db)
        .await?;
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let kind = s["llm"]["kind"]
        .as_str()
        .map(String::from)
        .or_else(|| env("MAILCRAFT_LLM_PROVIDER"))
        .unwrap_or_else(|| "openrouter".into());
    let key_set = s["llm"]["api_key_enc"].is_string()
        || env("OPENROUTER_API_KEY").is_some()
        || env("OPENAI_API_KEY").is_some();
    Ok(json!({
        "llm_provider": {
            "kind": kind,
            "model": s["llm"]["model"].as_str().map(String::from).or_else(|| env("MAILCRAFT_LLM_MODEL")),
            "base_url": s["llm"]["base_url"].as_str().map(String::from).or_else(|| env("MAILCRAFT_LLM_BASE_URL")),
            "api_key_set": key_set,
        },
        "delivery_path": delivery_path(st, auth.0.workspace_id, auth.0.env).await?,
        "default_from": s["default_from"],
        "reply_to": s["reply_to"],
    }))
}

pub async fn settings_get(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    Ok(envelope(StatusCode::OK, settings_view(&st, &auth).await?))
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct LlmIn {
    pub kind: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    /// Write-only. Empty string clears.
    pub api_key: Option<String>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsIn {
    pub llm_provider: Option<LlmIn>,
    pub default_from: Option<String>,
    pub reply_to: Option<String>,
}

/// Partial update; an empty string clears a field. Admin only.
pub async fn settings_put(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<SettingsIn>,
) -> ApiResult {
    auth.require(Scope::Admin)?;
    let mut patch = serde_json::Map::new();
    for (k, v) in [("default_from", &b.default_from), ("reply_to", &b.reply_to)] {
        if let Some(v) = v {
            if !v.is_empty() && mailcraft_core::address::parse_mailbox(v).is_none() {
                return Err(invalid(format!("{k} is not an email address")).field(k));
            }
            patch.insert(k.into(), if v.is_empty() { Value::Null } else { json!(v) });
        }
    }
    let mut llm = serde_json::Map::new();
    if let Some(l) = &b.llm_provider {
        if let Some(k) = &l.kind {
            if !LLM_KINDS.contains(&k.as_str()) {
                return Err(invalid(format!(
                    "llm_provider.kind must be one of {}",
                    LLM_KINDS.join(", ")
                ))
                .field("llm_provider.kind"));
            }
            llm.insert("kind".into(), json!(k));
        }
        if let Some(u) = &l.base_url {
            if !u.is_empty() && !(u.starts_with("http://") || u.starts_with("https://")) {
                return Err(
                    invalid("llm_provider.base_url must be http(s)").field("llm_provider.base_url")
                );
            }
            llm.insert(
                "base_url".into(),
                if u.is_empty() { Value::Null } else { json!(u) },
            );
        }
        if let Some(m) = &l.model {
            llm.insert(
                "model".into(),
                if m.is_empty() { Value::Null } else { json!(m) },
            );
        }
        if let Some(k) = &l.api_key {
            let v = if k.is_empty() {
                Value::Null
            } else {
                json!(B64.encode(st.secrets.seal(k.as_bytes(), LLM_KEY_AAD)))
            };
            llm.insert("api_key_enc".into(), v);
        }
        patch.insert("llm".into(), Value::Object(llm));
    }
    let mut tx = st.db.begin().await?;
    // Shallow merge at the top level, one level deeper for `llm`.
    sqlx::query(
        "UPDATE workspaces SET settings = (settings || ($2::jsonb - 'llm')) || \
         CASE WHEN $2::jsonb ? 'llm' THEN jsonb_build_object('llm', COALESCE(settings->'llm', '{}') || ($2::jsonb->'llm')) ELSE '{}' END \
         WHERE id = $1",
    )
    .bind(auth.0.workspace_id)
    .bind(Value::Object(patch))
    .execute(&mut *tx)
    .await?;
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "settings.update",
            args: json!({"default_from": b.default_from, "reply_to": b.reply_to, "llm_kind": b.llm_provider.as_ref().and_then(|l| l.kind.clone()), "llm_key_changed": b.llm_provider.as_ref().is_some_and(|l| l.api_key.is_some())}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(StatusCode::OK, settings_view(&st, &auth).await?))
}

// ------------------------------------------------------------------- doctor

fn status(l: Level) -> &'static str {
    match l {
        Level::Pass => "pass",
        Level::Warn => "warn",
        Level::Fail => "fail",
        Level::Unknown => "skipped",
    }
}

fn check(id: impl Into<String>, status: &str, detail: impl Into<String>, hint: &str) -> Value {
    json!({"id": id.into(), "status": status, "detail": detail.into(), "hint": hint})
}

/// Server-side checks only; the CLI adds local probes (port 25, FCrDNS, blocklists).
pub async fn doctor(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    let ws = auth.0.workspace_id;
    let mut out = vec![];
    out.push(
        match sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&st.db)
            .await
        {
            Ok(_) => check("postgres", "pass", "reachable", ""),
            Err(_) => check(
                "postgres",
                "fail",
                "query failed",
                "check DATABASE_URL and that Postgres is up",
            ),
        },
    );
    out.push(match st.redis.clone() {
        None => check(
            "redis",
            "skipped",
            "not configured; caps fall back to Postgres",
            "set REDIS_URL for fast rate limits",
        ),
        Some(mut r) => match redis::cmd("PING").query_async::<String>(&mut r).await {
            Ok(_) => check("redis", "pass", "reachable", ""),
            Err(_) => check(
                "redis",
                "warn",
                "unreachable; caps fall back to Postgres",
                "check REDIS_URL",
            ),
        },
    });
    let kinds: Vec<String> = sqlx::query_scalar(
        "SELECT kind FROM transports WHERE workspace_id = $1 ORDER BY created_at",
    )
    .bind(ws)
    .fetch_all(&st.db)
    .await?;
    out.push(if kinds.is_empty() {
        check(
            "transport_auth",
            "warn",
            "no transport configured: live sends have nowhere to go",
            "mailcraft connect gmail | connect relay",
        )
    } else {
        check(
            "transport_auth",
            "pass",
            format!("{} transport(s): {}", kinds.len(), kinds.join(", ")),
            "",
        )
    });
    let killed: bool = sqlx::query_scalar("SELECT kill_switch FROM workspaces WHERE id = $1")
        .bind(ws)
        .fetch_one(&st.db)
        .await?;
    if killed {
        out.push(check(
            "kill_switch",
            "warn",
            "kill switch is ON: nothing is sending",
            "POST /v1/kill-switch {\"on\":false} with an admin key",
        ));
    }
    // DNS: one check per domain, plus the DMARC record on its own (advisory).
    let store = PgDomains::new(st.db.clone());
    let domains = store.list(ws).await?;
    match (domains.is_empty(), HickoryDns::system()) {
        (true, _) => out.push(check(
            "dns_records",
            "skipped",
            "no domains added",
            "mailcraft domain add example.com",
        )),
        (_, Err(e)) => out.push(check(
            "dns_records",
            "skipped",
            format!("no DNS resolver: {e}"),
            "",
        )),
        (false, Ok(dns)) => {
            for d in domains {
                let Some(plan) = store.load_plan(d.id).await? else {
                    continue;
                };
                let checks = tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    doctor::records(&dns, &plan, Utc::now().timestamp().max(0) as u64),
                )
                .await
                .unwrap_or_default();
                let worst = |it: &mut dyn Iterator<Item = Level>| {
                    it.fold(Level::Pass, |a, l| match (a, l) {
                        (Level::Fail, _) | (_, Level::Fail) => Level::Fail,
                        (Level::Warn, _) | (_, Level::Warn) => Level::Warn,
                        (Level::Unknown, _) | (_, Level::Unknown) => Level::Unknown,
                        _ => Level::Pass,
                    })
                };
                let (dmarc, rest): (Vec<_>, Vec<_>) =
                    checks.iter().partition(|c| c.name.contains(":_dmarc."));
                let bad: Vec<String> = rest
                    .iter()
                    .filter(|c| c.level != Level::Pass)
                    .map(|c| format!("{}: {}", c.name, c.detail))
                    .collect();
                let lvl = worst(&mut rest.iter().map(|c| c.level));
                out.push(check(
                    format!("dns_records:{}", d.name),
                    status(lvl),
                    if bad.is_empty() {
                        "all required records resolve".into()
                    } else {
                        bad.join("; ")
                    },
                    "mailcraft domain show / verify",
                ));
                out.push(check(
                    format!("dmarc_policy:{}", d.name),
                    status(worst(&mut dmarc.iter().map(|c| c.level))),
                    dmarc
                        .first()
                        .map_or("no DMARC check ran".into(), |c| c.detail.clone()),
                    "publish the DMARC record from the domain's plan",
                ));
            }
        }
    }
    Ok(envelope(StatusCode::OK, json!({"checks": out})))
}

// ------------------------------------------------------------- suppressions

#[derive(Deserialize)]
pub struct SuppQ {
    limit: Option<u32>,
    cursor: Option<String>,
    reason: Option<String>,
}

pub async fn suppressions_list(
    State(st): State<AppState>,
    auth: Auth,
    Query(q): Query<SuppQ>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let (at, after) = page::decode(q.cursor.as_deref())?;
    let lim = page::limit(q.limit);
    let mut rows: Vec<(String, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT email, reason, source, created_at FROM suppressions WHERE workspace_id = $1 AND ($4::text IS NULL OR reason = $4) \
         AND (created_at, email) < ($2, $3) ORDER BY created_at DESC, email DESC LIMIT $5",
    )
    .bind(auth.0.workspace_id)
    .bind(at)
    .bind(after)
    .bind(&q.reason)
    .bind(lim + 1)
    .fetch_all(&st.db)
    .await?;
    let next = (rows.len() as i64 > lim).then(|| {
        rows.truncate(lim as usize);
        let l = rows.last().unwrap();
        page::encode(l.3, &l.0)
    });
    let items: Vec<Value> = rows.into_iter().map(|(email, reason, source, at)| json!({"email": email, "reason": reason, "source": source, "created_at": at})).collect();
    Ok(envelope_list(items, next))
}

/// `{id}` is the email address (URL-encoded).
pub async fn suppressions_delete(
    State(st): State<AppState>,
    auth: Auth,
    Path(email): Path<String>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    let email = email.trim().to_ascii_lowercase();
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("DELETE FROM suppressions WHERE workspace_id = $1 AND lower(email) = $2")
        .bind(auth.0.workspace_id)
        .bind(&email)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(not_found("suppression"));
    }
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "suppression.remove",
            args: json!({"email": email}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"email": email, "deleted": true}),
    ))
}

// ------------------------------------------------------------------- policy

/// `{default, keys:[{key_id, name, policy}]}`. `default` is the workspace default (stored in settings).
pub async fn policy_get(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    let ws = auth.0.workspace_id;
    let s: Value = sqlx::query_scalar("SELECT settings FROM workspaces WHERE id = $1")
        .bind(ws)
        .fetch_one(&st.db)
        .await?;
    let keys: Vec<(Uuid, String, Value)> = sqlx::query_as("SELECT id, name, policy FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY created_at, id")
        .bind(ws)
        .fetch_all(&st.db)
        .await?;
    Ok(envelope(
        StatusCode::OK,
        json!({"default": s.get("policy_default").cloned().unwrap_or_else(|| json!({"send": "auto"})),
               "keys": keys.into_iter().map(|(k, n, p)| json!({"key_id": k, "name": n, "policy": p})).collect::<Vec<_>>()}),
    ))
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyPut {
    pub default: Value,
}

pub async fn policy_put(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<PolicyPut>,
) -> ApiResult {
    auth.require(Scope::Admin)?;
    mailcraft_core::policy::validate(&b.default).map_err(|m| invalid(m).field("default"))?;
    let mut tx = st.db.begin().await?;
    sqlx::query("UPDATE workspaces SET settings = settings || jsonb_build_object('policy_default', $2::jsonb) WHERE id = $1")
        .bind(auth.0.workspace_id)
        .bind(&b.default)
        .execute(&mut *tx)
        .await?;
    audit::append(
        &mut tx,
        auth.0.workspace_id,
        Actor::Key(&auth.0),
        Entry {
            action: "policy.set_default",
            args: json!({"default": b.default}),
            decision: "auto",
            approval_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(envelope(StatusCode::OK, json!({"default": b.default})))
}

// ------------------------------------------------------- event definitions

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventDef {
    pub name: String,
    #[serde(default)]
    pub schema: Option<Value>,
    #[serde(default)]
    pub description: Option<String>,
}

pub async fn event_defs_create(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<EventDef>,
) -> ApiResult {
    auth.require(Scope::Manage)?;
    if b.name.trim().is_empty() || b.name.len() > 128 {
        return Err(invalid("name must be 1-128 characters").field("name"));
    }
    sqlx::query(
        "INSERT INTO event_defs (workspace_id, name, schema, description) VALUES ($1,$2,$3,$4) \
         ON CONFLICT (workspace_id, name) DO UPDATE SET schema = $3, description = $4",
    )
    .bind(auth.0.workspace_id)
    .bind(&b.name)
    .bind(&b.schema)
    .bind(&b.description)
    .execute(&st.db)
    .await?;
    Ok(envelope(
        StatusCode::CREATED,
        json!({"name": b.name, "schema": b.schema, "description": b.description}),
    ))
}

pub async fn event_defs_list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Manage)?;
    let rows: Vec<(String, Option<Value>, Option<String>)> = sqlx::query_as(
        "SELECT name, schema, description FROM event_defs WHERE workspace_id = $1 ORDER BY name",
    )
    .bind(auth.0.workspace_id)
    .fetch_all(&st.db)
    .await?;
    Ok(envelope_list(
        rows.into_iter()
            .map(|(n, s, d)| json!({"name": n, "schema": s, "description": d}))
            .collect::<Vec<_>>(),
        None,
    ))
}
