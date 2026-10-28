//! `/v1/broadcasts`: one template to a list of recipients, through the same queue and gates as
//! `/v1/emails`.
//!
//! Every recipient becomes an ordinary `emails` row (`source = 'broadcast'`, `broadcast_id` set),
//! so the worker's kill switch, suppression, key caps, approvals and unsubscribe links apply
//! unchanged. Template variables per recipient: `first_name`, `last_name`, `email` and
//! `data.<column>`; the worker adds `unsubscribe_url`, `preferences_url` and `workspace.name`.
//!
//! Pacing: with a daily cap (the default transport's `daily_cap`, the key's `daily_send_cap` or the
//! request's `max_per_day`, whichever is lowest) rows get `scheduled_at` spread evenly across the
//! day, and a second broadcast queues behind the first one's tail. No cap: rows are due at once and
//! the worker's per-destination throttle applies.
use std::collections::{BTreeSet, HashMap, HashSet};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Duration, Utc};
use mailcraft_core::{
    address::{self, magic_outcome},
    auth::{KeyEnv, Scope},
    services::UpsertContact,
    Policy, Stream,
};
use mailcraft_engine::LinkMaker;
use mailcraft_templates as mt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::{
    audit::{self, Actor, Entry},
    auth::{ApiKey, Auth},
    emails::{self, plan, prepare, Plan, Prepared, Row, SendEmail, TemplateRef},
    error::{envelope, envelope_list, err, invalid, not_found, ApiJson, ApiResult},
    page,
    state::AppState,
    templates, webhooks,
    wiring::{public_url, PgLinks},
};

const MAX_ROWS: usize = 5000;
const MAX_DATA_KEYS: usize = 50;

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Recipient {
    pub email: String,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    /// Extra columns, usable as `{{ data.<column> }}`. Scalar values only.
    #[serde(default)]
    pub data: Option<Map<String, Value>>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateBroadcast {
    /// Template id or alias.
    pub template_id: String,
    pub from: String,
    /// Replaces the template's subject; may use the same `{{ }}` variables.
    #[serde(default)]
    pub subject: Option<String>,
    /// Default `marketing`.
    #[serde(default)]
    pub stream: Option<Stream>,
    pub recipients: Vec<Recipient>,
    /// Upper bound on sends per day (the lowest of this and the transport / key caps applies).
    #[serde(default)]
    pub max_per_day: Option<u32>,
    /// Validate, screen and schedule without queueing anything.
    #[serde(default)]
    pub dry_run: bool,
}

fn blank(v: &Value) -> bool {
    v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty())
}

fn clean(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// What the template sees for one recipient. Blank values are left out, so `| default("x")`
/// covers them (it only fires on a missing value) and a bare `{{ first_name }}` is caught below.
fn vars_of(email: &str, r: &Recipient) -> Value {
    let mut m = Map::new();
    m.insert("email".into(), json!(email));
    for (k, v) in [("first_name", &r.first_name), ("last_name", &r.last_name)] {
        if let Some(v) = clean(v) {
            m.insert(k.into(), json!(v));
        }
    }
    let data: Map<String, Value> = r
        .data
        .iter()
        .flatten()
        .filter(|(_, v)| !blank(v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    m.insert("data".into(), Value::Object(data));
    Value::Object(m)
}

fn bad_data(d: &Option<Map<String, Value>>) -> Option<String> {
    let d = d.as_ref()?;
    if d.len() > MAX_DATA_KEYS {
        return Some(format!("more than {MAX_DATA_KEYS} extra columns"));
    }
    d.iter().find_map(|(k, v)| {
        let ident = k.len() <= 64
            && k.chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ident {
            return Some(format!("column `{k}` must be letters, digits and _ only"));
        }
        let ok = match v {
            Value::String(s) => s.len() <= 2000,
            Value::Number(_) | Value::Bool(_) | Value::Null => true,
            _ => false,
        };
        (!ok).then(|| format!("column `{k}` must be text, a number or true/false"))
    })
}

/// Published version first, else the newest (what the worker renders). `(id, stream, template)`.
async fn load_template(
    st: &AppState,
    ws: Uuid,
    id_or_alias: &str,
) -> ApiResult<(Uuid, mt::Template)> {
    let row: Option<(Uuid, Value)> = sqlx::query_as(
        "SELECT t.id, v.doc FROM templates t JOIN template_versions v ON v.template_id = t.id \
         WHERE t.workspace_id = $1 AND (t.alias = $2 OR t.id::text = $2) \
         ORDER BY (v.id = t.current_version_id) DESC, v.version DESC LIMIT 1",
    )
    .bind(ws)
    .bind(id_or_alias)
    .fetch_optional(&st.db)
    .await?;
    let (id, doc) = row.ok_or_else(|| {
        err(
            "not_found",
            404,
            format!("template `{id_or_alias}` not found"),
        )
        .field("template_id")
    })?;
    let tpl = mt::Template::from_json(&doc.to_string())
        .map_err(|e| err("template_corrupt", 500, e.to_string()))?;
    Ok((id, tpl))
}

/// Render context: the recipient's variables plus what the worker injects at send time.
fn context(st: &AppState, ws: Uuid, o: &mt::RenderOptions, vars: &Value) -> Value {
    let links = PgLinks {
        base: public_url(),
        secret: st.config.unsub_secret.clone(),
    };
    let (unsub, prefs) = links.links(ws, None, o.stream);
    let mut v = vars.clone();
    v["unsubscribe_url"] = json!(unsub);
    v["preferences_url"] = json!(prefs);
    v["workspace"] = json!({"name": o.footer.workspace_name});
    v
}

fn has_path(v: &Value, path: &str) -> bool {
    path.split('.')
        .try_fold(v, |c, k| c.get(k))
        .is_some_and(|x| !x.is_null())
}

fn set_path(root: &mut Value, path: &str, val: Value) {
    let mut cur = root;
    for k in path.split('.') {
        if !cur.is_object() {
            *cur = json!({});
        }
        cur = cur.as_object_mut().unwrap().entry(k).or_insert(Value::Null);
    }
    *cur = val;
}

/// Names the variables a render needs but the row lacks: those that, left out alone (the other
/// missing ones filled in), still make `fails` true. A variable with a fallback is not named.
fn needed(ctx: &Value, names: &[String], fails: impl Fn(&Value) -> bool) -> String {
    let absent: Vec<&String> = names.iter().filter(|n| !has_path(ctx, n)).collect();
    let need: Vec<&str> = absent
        .iter()
        .filter(|v| {
            let mut c = ctx.clone();
            absent
                .iter()
                .filter(|n| n != v)
                .for_each(|n| set_path(&mut c, n, json!("x")));
            fails(&c)
        })
        .map(|n| n.as_str())
        .collect();
    format!("needs a value for {}", need.join(", "))
}

/// Which fields a recipient has (not their values): all that decides whether the template renders.
fn shape(v: &Value) -> String {
    let keys = |m: Option<&Map<String, Value>>| -> BTreeSet<String> {
        m.map(|m| m.keys().cloned().collect()).unwrap_or_default()
    };
    format!("{:?}{:?}", keys(v.as_object()), keys(v["data"].as_object()))
}

struct Item {
    email: String,
    rec: Recipient,
    vars: Value,
    subject: String,
}

struct Analysis {
    p: Prepared,
    pl: Plan,
    stream: Stream,
    template_id: Uuid,
    items: Vec<Item>,
    skipped: Vec<Value>,
    slots: Vec<Option<DateTime<Utc>>>,
    schedule: Value,
}

/// Send times for `n` rows at `per_day` sends a day, evenly spaced from `start`.
fn slots(
    start: DateTime<Utc>,
    n: usize,
    per_day: Option<u32>,
) -> (Vec<Option<DateTime<Utc>>>, i64) {
    let gap_ms = per_day.map_or(0, |d| 86_400_000 / i64::from(d.max(1)));
    let at = (0..n)
        .map(|i| per_day.map(|_| start + Duration::milliseconds(gap_ms * i as i64)))
        .collect();
    (at, gap_ms)
}

/// Everything short of writing: validate, screen, render-check, gate, schedule.
async fn analyze(
    st: &AppState,
    key: &ApiKey,
    req: &CreateBroadcast,
    record: bool,
) -> ApiResult<Analysis> {
    let ws = key.workspace_id;
    if req.recipients.is_empty() || req.recipients.len() > MAX_ROWS {
        return Err(invalid(format!("`recipients` needs 1-{MAX_ROWS} rows")).field("recipients"));
    }
    let stream = req.stream.unwrap_or(Stream::Marketing);
    let override_subject = clean(&req.subject);
    if let Some(s) = override_subject {
        emails::no_ctl(s, "subject")?;
        if s.len() > 998 {
            return Err(invalid("subject is too long").field("subject"));
        }
    }
    let (template_id, tpl) = load_template(st, ws, &req.template_id).await?;
    let mut sub_tpl = tpl.clone();
    if let Some(s) = override_subject {
        sub_tpl.subject = s.to_owned();
    }

    // 1. parse, validate, dedupe (case-insensitive)
    let mut skipped: Vec<Value> = vec![];
    let skip = |skipped: &mut Vec<Value>, email: &str, reason: &str, detail: Option<String>| {
        skipped.push(json!({"email": email, "reason": reason, "detail": detail}));
    };
    let (mut seen, mut items) = (HashSet::new(), Vec::new());
    for r in &req.recipients {
        let Some((_, addr)) = address::parse_mailbox(&r.email) else {
            skip(&mut skipped, r.email.trim(), "invalid_email", None);
            continue;
        };
        if !seen.insert(addr.to_lowercase()) {
            skip(&mut skipped, &addr, "duplicate", None);
            continue;
        }
        if let Some(why) = bad_data(&r.data) {
            skip(&mut skipped, &addr, "invalid_data", Some(why));
            continue;
        }
        items.push(Item {
            vars: vars_of(&addr, r),
            email: addr,
            rec: r.clone(),
            subject: String::new(),
        });
    }

    // 2. screen: suppression list, topic opt-outs, test/allowlist rules (the worker re-checks at send time)
    let lower: Vec<String> = items.iter().map(|i| i.email.to_lowercase()).collect();
    let suppressed: HashSet<String> = sqlx::query_scalar(
        "SELECT email FROM suppressions WHERE workspace_id = $1 AND email = ANY($2)",
    )
    .bind(ws)
    .bind(&lower)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .collect();
    let opted_out: HashSet<String> = if stream == Stream::Marketing {
        sqlx::query_scalar(
            "SELECT lower(c.email) FROM contacts c JOIN contact_topics ct ON ct.contact_id = c.id \
             JOIN topics t ON t.id = ct.topic_id WHERE c.workspace_id = $1 AND lower(c.email) = ANY($2) \
             AND NOT ct.opted_in AND t.key IN ('product','digest')",
        )
        .bind(ws)
        .bind(&lower)
        .fetch_all(&st.db)
        .await?
        .into_iter()
        .collect()
    } else {
        HashSet::new()
    };
    let allow = key.allowlist.as_deref();
    items.retain(|i| {
        let l = i.email.to_lowercase();
        let why = if suppressed.contains(&l) {
            Some(("suppressed", None))
        } else if opted_out.contains(&l) {
            Some(("unsubscribed", None))
        } else if key.env == KeyEnv::Test
            && magic_outcome(&i.email).is_none()
            && !address::allowlist_matches(allow.unwrap_or(&[]), &i.email)
        {
            Some((
                "not_allowed",
                Some("test keys only send to test addresses".to_owned()),
            ))
        } else if key.env == KeyEnv::Live
            && allow.is_some_and(|al| !address::allowlist_matches(al, &i.email))
        {
            Some((
                "not_allowed",
                Some("not on this key's recipient allowlist".to_owned()),
            ))
        } else {
            None
        };
        if let Some((reason, detail)) = &why {
            skip(&mut skipped, &i.email, reason, detail.clone());
        }
        why.is_none()
    });
    if items.is_empty() {
        return Err(err(
            "no_deliverable_recipients",
            422,
            format!(
                "none of the {} recipients can be sent to",
                req.recipients.len()
            ),
        )
        .field("recipients")
        .hint_in("every row was invalid, a duplicate, suppressed, unsubscribed or not allowed for this key"));
    }

    // 3. the same gates as a single send (kill switch, go-live, verified domain, policy), once
    let p = prepare(
        st,
        key,
        &SendEmail {
            from: Some(req.from.clone()),
            to: vec![items[0].email.clone()],
            subject: override_subject.map(str::to_owned),
            html: None,
            text: None,
            reply_to: None,
            template: Some(TemplateRef {
                id: req.template_id.clone(),
                variables: None,
            }),
            stream: Some(stream),
            tags: None,
            headers: None,
            scheduled_at: None,
            dry_run: false,
        },
    )
    .await?;
    let mut pl = plan(st, key, &p, record).await?;
    // test-env decisions list the representative recipient only; each row's outcome is its own address
    for d in &mut pl.decisions {
        if let Some(o) = d.as_object_mut() {
            o.remove("recipients");
        }
    }

    // 4. render-check: a row missing something the template needs would fail at send time. Rendering
    //    depends only on which fields are present, so render once per distinct set, not per row.
    let o = templates::options(st, ws, stream).await?;
    let mut verdict: HashMap<String, Option<String>> = HashMap::new();
    let mut ok = Vec::with_capacity(items.len());
    for mut it in items {
        let sig = shape(&it.vars);
        if !verdict.contains_key(&sig) {
            let ctx = context(st, ws, &o, &it.vars);
            let v = match mt::render(&tpl, &ctx, &o) {
                Ok(_) => None,
                Err(mt::RenderError::Vars(_)) => Some(needed(&ctx, &mt::variables(&tpl), |c| {
                    matches!(mt::render(&tpl, c, &o), Err(mt::RenderError::Vars(_)))
                })),
                // not about this recipient: the template (or the workspace footer) is unusable
                Err(e) => {
                    return Err(
                        err("template_render_failed", 422, e.to_string()).field("template_id")
                    )
                }
            };
            verdict.insert(sig.clone(), v);
        }
        if let Some(m) = &verdict[&sig] {
            skip(&mut skipped, &it.email, "missing_variable", Some(m.clone()));
            continue;
        }
        if override_subject.is_some() {
            match mt::render_subject(&sub_tpl, &it.vars) {
                Ok(s) => it.subject = s,
                Err(_) => {
                    let why = needed(&it.vars, &mt::variables(&sub_tpl), |c| {
                        mt::render_subject(&sub_tpl, c).is_err()
                    });
                    skip(&mut skipped, &it.email, "missing_variable", Some(why));
                    continue;
                }
            }
        }
        ok.push(it);
    }
    let items = ok;
    if items.is_empty() {
        return Err(err(
            "no_deliverable_recipients",
            422,
            "every recipient is missing a value the template needs",
        )
        .field("recipients")
        .hint_in("fill the blank cells, or give the field a fallback: {{ first_name | default(\"there\") }}"));
    }

    // 5. pacing
    let transport_cap: Option<i32> = if key.env == KeyEnv::Live {
        sqlx::query_scalar::<_, Option<i32>>(
            "SELECT daily_cap FROM transports WHERE workspace_id = $1 ORDER BY is_default DESC, created_at LIMIT 1",
        )
        .bind(ws)
        .fetch_optional(&st.db)
        .await?
        .flatten()
    } else {
        None
    };
    let per_day = (key.env == KeyEnv::Live)
        .then(|| {
            [
                transport_cap.map(|c| c as u32),
                key.daily_cap.map(|c| c as u32),
                req.max_per_day,
            ]
            .into_iter()
            .flatten()
            .filter(|c| *c > 0)
            .min()
        })
        .flatten();
    let now = Utc::now();
    let mut start = now;
    if let Some(d) = per_day {
        // queue behind other broadcasts still waiting, so two together never exceed the rate
        let tail: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT max(scheduled_at) FROM emails WHERE workspace_id = $1 AND broadcast_id IS NOT NULL \
             AND status IN ('queued','pending_approval','deferred')",
        )
        .bind(ws)
        .fetch_one(&st.db)
        .await?;
        start = tail
            .map(|t| t + Duration::milliseconds(86_400_000 / i64::from(d)))
            .filter(|t| *t > now)
            .unwrap_or(now);
    }
    let (at, gap_ms) = slots(start, items.len(), per_day);
    let schedule = json!({
        "daily_cap": per_day, "transport_daily_cap": transport_cap,
        "spacing_seconds": gap_ms as f64 / 1000.0,
        "first_at": at.first().copied().flatten().unwrap_or(now),
        "last_at": at.last().copied().flatten().unwrap_or(now),
    });
    Ok(Analysis {
        p,
        pl,
        stream,
        template_id,
        items,
        skipped,
        slots: at,
        schedule,
    })
}

fn summary(a: &Analysis) -> Value {
    json!({"queued": a.items.len(), "skipped": a.skipped, "schedule": a.schedule})
}

pub async fn create(
    State(st): State<AppState>,
    auth: Auth,
    headers: HeaderMap,
    ApiJson(req): ApiJson<CreateBroadcast>,
) -> ApiResult {
    auth.require(Scope::Send)?;
    let key = &auth.0;
    if req.dry_run {
        let a = analyze(&st, key, &req, false).await?;
        let mut d = summary(&a);
        d["dry_run"] = json!(true);
        return Ok(envelope(StatusCode::OK, d));
    }
    let mut g = begin!(st, auth, headers, "POST /v1/broadcasts", req);
    let a = analyze(&st, key, &req, true).await?;
    let ws = key.workspace_id;

    // contacts: upsert through the service (a few in flight). A row it rejects cannot carry a
    // working unsubscribe link, so it is skipped rather than sent.
    let mut tasks = tokio::task::JoinSet::new();
    let per_task = a.items.len().div_ceil(8).max(1);
    for (n, chunk) in a.items.chunks(per_task).enumerate() {
        let contacts = st.contacts.clone();
        let rows: Vec<(String, Recipient)> = chunk
            .iter()
            .map(|i| (i.email.clone(), i.rec.clone()))
            .collect();
        tasks.spawn(async move {
            let mut out = Vec::with_capacity(rows.len());
            for (email, r) in rows {
                let properties = r.data.as_ref().map(|d| {
                    Value::Object(
                        d.iter()
                            .filter(|(_, v)| !blank(v))
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect(),
                    )
                });
                let id = contacts
                    .upsert(
                        ws,
                        UpsertContact {
                            email,
                            first_name: clean(&r.first_name).map(str::to_owned),
                            last_name: clean(&r.last_name).map(str::to_owned),
                            timezone: None,
                            properties,
                        },
                    )
                    .await
                    .ok()
                    .and_then(|c| c["id"].as_str().and_then(|s| s.parse::<Uuid>().ok()));
                out.push(id);
            }
            (n, out)
        });
    }
    let mut contact_ids = vec![None; a.items.len()];
    while let Some(done) = tasks.join_next().await {
        let (n, ids) = done.map_err(|e| err("internal_error", 500, e.to_string()))?;
        for (j, id) in ids.into_iter().enumerate() {
            contact_ids[n * per_task + j] = id;
        }
    }
    let mut skipped = a.skipped.clone();
    let mut rows = Vec::with_capacity(a.items.len());
    for ((it, at), cid) in a.items.iter().zip(&a.slots).zip(contact_ids) {
        match cid {
            Some(cid) => rows.push((it, *at, cid)),
            None => {
                skipped.push(json!({"email": it.email, "reason": "invalid_email", "detail": null}))
            }
        }
    }

    let needs_approval = a.pl.policy == Policy::NeedsApproval;
    let status = if needs_approval {
        "pending_approval"
    } else {
        "queued"
    };
    let bid = Uuid::now_v7();
    let queued = rows.len();
    let subject = clean(&req.subject).unwrap_or_default();
    let stream = emails::stream_str(a.stream);
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO broadcasts (id, workspace_id, api_key_id, template_id, from_addr, subject, stream, env, total, skipped) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(bid)
    .bind(ws)
    .bind(key.id)
    .bind(a.template_id)
    .bind(&a.p.from)
    .bind(subject)
    .bind(stream)
    .bind(key.env.as_str())
    .bind(queued as i32)
    .bind(Value::Array(skipped.clone()))
    .execute(&mut *g.tx)
    .await?;
    // ponytail: one INSERT per row inside the request transaction (~5k round trips at the cap);
    // switch to a single UNNEST insert if that ever shows up in latency.
    for (i, (it, at, cid)) in rows.iter().enumerate() {
        let idem = g.row_key(0, i);
        emails::insert_email(
            &mut g.tx,
            key,
            &a.p,
            &a.pl,
            &Row {
                id: Uuid::now_v7(),
                to: &it.email,
                subject: &it.subject,
                vars: &Some(it.vars.clone()),
                idem,
                status,
                scheduled_at: *at,
                max_age: at.unwrap_or(now) + Duration::hours(72),
                broadcast: Some((bid, Some(*cid))),
            },
        )
        .await?;
    }
    st.metrics
        .emails
        .with_label_values(&[stream, status, "", key.env.as_str()])
        .inc_by(queued as u64);
    let mut data = json!({
        "id": bid, "status": status, "queued": queued, "skipped": skipped,
        "schedule": a.schedule, "policy_decisions": a.pl.decisions,
    });
    let mut approval = None;
    if needs_approval {
        let aid = Uuid::now_v7();
        sqlx::query("INSERT INTO approvals (id, workspace_id, kind, subject_id, requested_by, payload) VALUES ($1,$2,'broadcast',$3,$4,$5)")
            .bind(aid)
            .bind(ws)
            .bind(bid)
            .bind(key.id)
            .bind(json!({
                "broadcast_id": bid, "from": a.p.from, "to": format!("{queued} recipients"),
                "stream": stream, "recipients": queued,
                "preview": {"subject": if subject.is_empty() { None } else { Some(subject) }, "text": format!("Broadcast of template {} to {queued} recipients.", req.template_id)},
            }))
            .execute(&mut *g.tx)
            .await?;
        webhooks::enqueue(
            &mut g.tx,
            ws,
            "approval.requested",
            json!({"approval_id": aid, "kind": "broadcast"}),
        )
        .await?;
        data["approval_id"] = json!(aid);
        approval = Some(aid);
    }
    audit::append(
        &mut g.tx,
        ws,
        Actor::Key(key),
        Entry {
            action: "broadcast.create",
            args: json!({
                "broadcast_id": bid, "template_id": a.template_id, "from": a.p.from, "stream": stream,
                "env": key.env.as_str(), "queued": queued, "skipped": skipped.len(),
                "daily_cap": a.schedule["daily_cap"],
            }),
            decision: if needs_approval { "needs_approval" } else { "auto" },
            approval_id: approval,
        },
    )
    .await?;
    g.finish(StatusCode::ACCEPTED, data).await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewBroadcast {
    pub template_id: String,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub stream: Option<Stream>,
    pub recipient: Recipient,
}

/// Renders one recipient exactly as the worker would (no send, nothing stored).
pub async fn preview(
    State(st): State<AppState>,
    auth: Auth,
    ApiJson(b): ApiJson<PreviewBroadcast>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let ws = auth.0.workspace_id;
    let (_, mut tpl) = load_template(&st, ws, &b.template_id).await?;
    if let Some(s) = clean(&b.subject) {
        tpl.subject = s.to_owned();
    }
    let (_, addr) = address::parse_mailbox(&b.recipient.email).ok_or_else(|| {
        invalid("`recipient.email` is not a valid email address").field("recipient")
    })?;
    if let Some(why) = bad_data(&b.recipient.data) {
        return Err(invalid(why).field("recipient"));
    }
    let o = templates::options(&st, ws, b.stream.unwrap_or(Stream::Marketing)).await?;
    let ctx = context(&st, ws, &o, &vars_of(&addr, &b.recipient));
    let r = mt::render(&tpl, &ctx, &o)
        .map_err(|e| err("template_render_failed", 422, e.to_string()).field("recipient"))?;
    Ok(envelope(
        StatusCode::OK,
        json!({"subject": r.subject, "html": r.html, "text": r.text}),
    ))
}

const SELECT: &str = "SELECT b.id, b.template_id, t.name AS template_name, b.from_addr, b.subject, b.stream, b.env, \
    b.total, b.created_at, jsonb_array_length(b.skipped)::bigint AS skipped_at_create, \
    c.queued, c.pending_approval, c.sent, c.delivered, c.bounced, c.failed, c.skipped_rows, c.first_at, c.last_at \
    FROM broadcasts b JOIN templates t ON t.id = b.template_id \
    CROSS JOIN LATERAL (SELECT \
      count(*) FILTER (WHERE status IN ('queued','deferred','sending')) AS queued, \
      count(*) FILTER (WHERE status = 'pending_approval') AS pending_approval, \
      count(*) FILTER (WHERE status = 'sent') AS sent, \
      count(*) FILTER (WHERE status = 'delivered') AS delivered, \
      count(*) FILTER (WHERE status = 'bounced') AS bounced, \
      count(*) FILTER (WHERE status = 'failed') AS failed, \
      count(*) FILTER (WHERE status IN ('suppressed','cancelled')) AS skipped_rows, \
      min(scheduled_at) AS first_at, max(scheduled_at) AS last_at \
      FROM emails e WHERE e.broadcast_id = b.id) c";

#[derive(sqlx::FromRow)]
struct BRow {
    id: Uuid,
    template_id: Uuid,
    template_name: String,
    from_addr: String,
    subject: String,
    stream: String,
    env: String,
    total: i32,
    created_at: DateTime<Utc>,
    skipped_at_create: i64,
    queued: i64,
    pending_approval: i64,
    sent: i64,
    delivered: i64,
    bounced: i64,
    failed: i64,
    skipped_rows: i64,
    first_at: Option<DateTime<Utc>>,
    last_at: Option<DateTime<Utc>>,
}

impl BRow {
    fn view(&self) -> Value {
        let status = if self.pending_approval > 0 {
            "pending_approval"
        } else if self.queued > 0 {
            "sending"
        } else {
            "done"
        };
        json!({
            "id": self.id, "template_id": self.template_id, "template_name": self.template_name,
            "from": self.from_addr, "subject": self.subject, "stream": self.stream, "env": self.env,
            "status": status, "total": self.total, "created_at": self.created_at,
            "counts": {
                "queued": self.queued + self.pending_approval, "sent": self.sent,
                "delivered": self.delivered, "bounced": self.bounced, "failed": self.failed,
                "skipped": self.skipped_at_create + self.skipped_rows,
            },
            "first_at": self.first_at, "last_at": self.last_at,
        })
    }
}

#[derive(Deserialize)]
pub struct ListQ {
    limit: Option<u32>,
    cursor: Option<String>,
}

pub async fn list(State(st): State<AppState>, auth: Auth, Query(q): Query<ListQ>) -> ApiResult {
    auth.require(Scope::Read)?;
    let (at, after) = page::decode(q.cursor.as_deref())?;
    let lim = page::limit(q.limit);
    let mut rows: Vec<BRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE b.workspace_id = $1 AND (b.created_at, b.id::text) < ($2, $3) \
         ORDER BY b.created_at DESC, b.id::text DESC LIMIT $4"
    ))
    .bind(auth.0.workspace_id)
    .bind(at)
    .bind(after)
    .bind(lim + 1)
    .fetch_all(&st.db)
    .await?;
    let next = (rows.len() as i64 > lim).then(|| {
        rows.truncate(lim as usize);
        let l = rows.last().unwrap();
        page::encode(l.created_at, l.id)
    });
    Ok(envelope_list(
        rows.iter().map(BRow::view).collect::<Vec<_>>(),
        next,
    ))
}

#[derive(Deserialize)]
pub struct GetQ {
    limit: Option<u32>,
    /// Last recipient email id of the previous page.
    cursor: Option<Uuid>,
    status: Option<String>,
}

pub async fn get(
    State(st): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    Query(q): Query<GetQ>,
) -> ApiResult {
    auth.require(Scope::Read)?;
    let ws = auth.0.workspace_id;
    let b: BRow = sqlx::query_as(&format!("{SELECT} WHERE b.workspace_id = $1 AND b.id = $2"))
        .bind(ws)
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| not_found("broadcast"))?;
    let skipped: Value = sqlx::query_scalar("SELECT skipped FROM broadcasts WHERE id = $1")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    let lim = page::limit(q.limit);
    type R = (
        Uuid,
        String,
        String,
        Option<String>,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
    );
    let mut rows: Vec<R> = sqlx::query_as(
        "SELECT id, to_addr, status, last_error, scheduled_at, sent_at FROM emails \
         WHERE broadcast_id = $1 AND workspace_id = $2 AND ($3::text IS NULL OR status = $3) \
         AND ($4::uuid IS NULL OR id > $4) ORDER BY id LIMIT $5",
    )
    .bind(id)
    .bind(ws)
    .bind(&q.status)
    .bind(q.cursor)
    .bind(lim + 1)
    .fetch_all(&st.db)
    .await?;
    let next = (rows.len() as i64 > lim).then(|| {
        rows.truncate(lim as usize);
        rows.last().map(|r| r.0)
    });
    let mut out = b.view();
    out["recipients"] = rows
        .into_iter()
        .map(|(id, to, status, last_error, scheduled_at, sent_at)| {
            json!({"id": id, "email": to, "status": status, "last_error": last_error, "scheduled_at": scheduled_at, "sent_at": sent_at})
        })
        .collect();
    out["next_cursor"] = json!(next.flatten());
    out["skipped"] = skipped;
    Ok(envelope(StatusCode::OK, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pacing_is_even_and_off_without_a_cap() {
        let t0 = Utc::now();
        let (at, gap) = slots(t0, 1000, Some(100));
        assert_eq!(gap, 864_000, "100 a day is one every 14.4 minutes");
        assert_eq!(at[0], Some(t0));
        assert_eq!(at[999], Some(t0 + Duration::milliseconds(864_000 * 999)));
        let (at, gap) = slots(t0, 3, None);
        assert!(gap == 0 && at.iter().all(Option::is_none));
    }

    #[test]
    fn blank_values_are_left_out_of_the_variables() {
        let r = Recipient {
            email: "a@b.co".into(),
            first_name: Some("  ".into()),
            last_name: Some("Lovelace".into()),
            data: Some(
                json!({"company": "Acme", "title": "", "n": 3})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        };
        let v = vars_of("a@b.co", &r);
        assert_eq!(
            v,
            json!({"email": "a@b.co", "last_name": "Lovelace", "data": {"company": "Acme", "n": 3}})
        );
    }

    #[test]
    fn data_columns_must_be_template_friendly() {
        let d = |v: Value| Some(v.as_object().unwrap().clone());
        assert!(bad_data(&d(json!({"company_name": "x", "n": 1, "ok": true}))).is_none());
        assert!(bad_data(&d(json!({"Company Name": "x"}))).is_some());
        assert!(bad_data(&d(json!({"a": {"nested": 1}}))).is_some());
    }
}
