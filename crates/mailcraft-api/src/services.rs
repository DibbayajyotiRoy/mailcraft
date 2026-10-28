//! Real implementations of the `mailcraft_core::services` traits: domains over
//! `mailcraft-deliverability`, contacts / segments / events over `mailcraft-automations`.
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use mailcraft_automations::{
    contacts::{self, normalize_email},
    ContactInput, Engine, EngineConfig, Personalizer, Rule, TrackInput,
};
use mailcraft_core::{services::*, transport::DnsRecord, Error, Result, Stream};
use mailcraft_deliverability::{
    crypto::SecretBox as DelivBox,
    dns::{
        plan::{Instance, Options},
        verify::HickoryDns,
    },
    keys::Algo,
    service,
    store::{
        postgres::{PgDomains, PgKeys},
        DomainRow, DomainStore,
    },
};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{page, state::AppState};

fn db(e: sqlx::Error) -> Error {
    tracing::error!(error = %e, "database error");
    Error::new("internal_error", 500, "internal error").retryable()
}

/// Maps automations errors without leaking driver text.
pub(crate) fn ae(e: mailcraft_automations::AutomationError) -> Error {
    match e {
        mailcraft_automations::AutomationError::Db(e) => db(e),
        e => e.into(),
    }
}

fn not_found(what: &str) -> Error {
    Error::new("not_found", 404, format!("{what} not found"))
}

// ------------------------------------------------------------------ domains

/// Instance facts the DNS planner needs, from env: `MAILCRAFT_PUBLIC_URL` (host = instance
/// domain), `MAILCRAFT_MX_HOST` (default `mx.<instance domain>`), `MAILCRAFT_EGRESS_IP` (comma list).
pub fn instance_from_env() -> Instance {
    let domain = std::env::var("MAILCRAFT_PUBLIC_URL").ok().and_then(|u| {
        reqwest::Url::parse(&u)
            .ok()
            .and_then(|u| u.host_str().map(String::from))
    });
    let mx_host = std::env::var("MAILCRAFT_MX_HOST")
        .ok()
        .or_else(|| domain.as_ref().map(|d| format!("mx.{d}")))
        .unwrap_or_else(|| "mx.localhost".into());
    let ips = std::env::var("MAILCRAFT_EGRESS_IP")
        .map(|v| v.split(',').filter_map(|s| s.trim().parse().ok()).collect())
        .unwrap_or_default();
    Instance {
        domain,
        mx_host,
        ips,
    }
}

pub struct Domains {
    db: PgPool,
    store: PgDomains,
    keys: PgKeys,
    dns: HickoryDns,
    instance: Instance,
}

impl Domains {
    pub fn new(db: PgPool, secrets: DelivBox, dns: HickoryDns, instance: Instance) -> Self {
        Self {
            store: PgDomains::new(db.clone()),
            keys: PgKeys::new(db.clone(), secrets),
            db,
            dns,
            instance,
        }
    }

    async fn owned(&self, ws: Uuid, id: Uuid) -> Result<DomainRow> {
        match self.store.get(id).await? {
            Some(d) if d.workspace_id == ws => Ok(d),
            _ => Err(Error::new("domain_not_found", 404, "domain not found")),
        }
    }

    async fn view(&self, d: DomainRow) -> Result<DomainView> {
        type Rec = (
            String,
            String,
            String,
            String,
            Option<i32>,
            String,
            Option<String>,
            Option<String>,
            Option<chrono::DateTime<Utc>>,
        );
        let rows: Vec<Rec> = sqlx::query_as(
            "SELECT record, type, name, value, priority, status, detail, found, checked_at FROM domain_records WHERE domain_id = $1 ORDER BY record, name",
        )
        .bind(d.id)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        let last_checked_at =
            sqlx::query_scalar("SELECT last_checked_at FROM domains WHERE id = $1")
                .bind(d.id)
                .fetch_one(&self.db)
                .await
                .map_err(db)?;
        Ok(DomainView {
            last_checked_at,
            id: d.id,
            name: d.name,
            stream: if d.stream == Stream::Marketing {
                "marketing"
            } else {
                "transactional"
            }
            .into(),
            status: d.status.as_str().into(),
            records: rows
                .into_iter()
                .map(
                    |(record, kind, name, value, priority, status, detail, found, checked_at)| {
                        DnsRecord {
                            detail,
                            found,
                            checked_at,
                            priority: priority.and_then(|p| u16::try_from(p).ok()),
                            record,
                            kind,
                            name,
                            value,
                            status,
                        }
                    },
                )
                .collect(),
        })
    }
}

#[async_trait]
impl DomainService for Domains {
    async fn add(&self, ws: Uuid, req: AddDomain) -> Result<DomainView> {
        let domain = req.domain.trim().trim_end_matches('.').to_ascii_lowercase();
        if domain.len() > 253
            || !domain.contains('.')
            || domain.contains(char::is_whitespace)
            || domain.contains('/')
        {
            return Err(Error::new(
                "invalid_request",
                400,
                format!("`{}` is not a domain name", req.domain),
            )
            .field("domain"));
        }
        let options = Options {
            mta_sts_id: Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
            ..Options::default()
        };
        let (row, _) = service::add_domain(
            &self.store,
            &self.keys,
            service::AddDomain {
                workspace_id: ws,
                domain: &domain,
                stream: req.stream.unwrap_or(Stream::Transactional),
                use_subdomain: false,
                ed25519: false,
                instance: &self.instance,
                options: &options,
                now: Utc::now().timestamp(),
            },
        )
        .await?;
        if let Some(t) = req.tracking {
            sqlx::query("UPDATE domains SET open_tracking = $2, click_tracking = $3 WHERE id = $1")
                .bind(row.id)
                .bind(t.opens)
                .bind(t.clicks)
                .execute(&self.db)
                .await
                .map_err(db)?;
        }
        self.view(row).await
    }

    async fn list(&self, ws: Uuid) -> Result<Vec<DomainView>> {
        let mut out = vec![];
        for d in self.store.list(ws).await? {
            out.push(self.view(d).await?);
        }
        Ok(out)
    }

    async fn get(&self, ws: Uuid, id: Uuid) -> Result<DomainView> {
        let d = self.owned(ws, id).await?;
        self.view(d).await
    }

    async fn verify(&self, ws: Uuid, id: Uuid) -> Result<DomainView> {
        self.owned(ws, id).await?;
        service::verify_domain(&self.store, &self.dns, id, Utc::now().timestamp()).await?;
        self.get(ws, id).await
    }

    async fn rotate_dkim(&self, ws: Uuid, id: Uuid) -> Result<DomainView> {
        self.owned(ws, id).await?;
        service::rotate_dkim(
            &self.store,
            &self.keys,
            id,
            Algo::Rsa2048,
            &self.instance,
            Utc::now().timestamp(),
        )
        .await?;
        self.get(ws, id).await
    }

    async fn delete(&self, ws: Uuid, id: Uuid) -> Result<()> {
        self.owned(ws, id).await?;
        // api_keys.domain_id has no cascade; a restricted key must be revoked first.
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM api_keys WHERE domain_id = $1 AND revoked_at IS NULL",
        )
        .bind(id)
        .fetch_one(&self.db)
        .await
        .map_err(db)?;
        if n > 0 {
            return Err(Error::new(
                "domain_in_use",
                409,
                format!("{n} active API key(s) are restricted to this domain"),
            )
            .hint("revoke them first: DELETE /v1/keys/{id}"));
        }
        self.store.delete(id).await?;
        Ok(())
    }
}

// ----------------------------------------------------------------- contacts

/// `%needle%` for ILIKE with `\`, `%` and `_` escaped; `None` for a blank needle.
pub(crate) fn like(q: Option<&str>) -> Option<String> {
    let q = q.map(str::trim).filter(|s| !s.is_empty())?;
    Some(format!(
        "%{}%",
        q.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    ))
}

async fn resolve(pool: &PgPool, ws: Uuid, id_or_email: &str) -> Result<Uuid> {
    let by_id = id_or_email.parse::<Uuid>().ok();
    let email = if by_id.is_none() {
        Some(normalize_email(id_or_email).map_err(ae)?)
    } else {
        None
    };
    sqlx::query_scalar(
        "SELECT id FROM contacts WHERE workspace_id = $1 AND (id = $2 OR lower(email) = lower($3))",
    )
    .bind(ws)
    .bind(by_id)
    .bind(email)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| not_found("contact"))
}

pub struct Contacts {
    db: PgPool,
}

/// Suppression reason per (lowercased) address; both spellings are tried so the primary key serves it.
async fn suppression_reasons(
    pool: &PgPool,
    ws: Uuid,
    emails: &[String],
) -> Result<std::collections::HashMap<String, String>> {
    let lower: Vec<String> = emails.iter().map(|e| e.to_lowercase()).collect();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT email, reason FROM suppressions WHERE workspace_id = $1 AND (email = ANY($2) OR email = ANY($3))",
    )
    .bind(ws)
    .bind(emails)
    .bind(&lower)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|(e, r)| (e.to_lowercase(), r))
        .collect())
}

fn with_suppression(
    c: contacts::Contact,
    reasons: &std::collections::HashMap<String, String>,
) -> Value {
    let reason = reasons.get(&c.email.to_lowercase());
    let mut v = serde_json::to_value(c).unwrap_or_default();
    v["suppressed"] = json!(reason.is_some());
    v["suppression_reason"] = json!(reason);
    v
}

/// Adds `lists: [{id, name, origin}]` (the manual lists each contact is in) to contact objects.
async fn attach_lists(pool: &PgPool, items: &mut [Value]) -> Result<()> {
    let ids: Vec<Uuid> = items
        .iter()
        .filter_map(|v| v["id"].as_str()?.parse().ok())
        .collect();
    let rows: Vec<(Uuid, Uuid, String, String)> = sqlx::query_as(
        "SELECT m.contact_id, s.id, s.name, s.origin FROM segment_members m JOIN segments s ON s.id = m.segment_id \
         WHERE m.contact_id = ANY($1) AND s.filter IS NULL ORDER BY s.name",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for v in items.iter_mut() {
        let id = v["id"].as_str().and_then(|s| s.parse::<Uuid>().ok());
        v["lists"] = rows
            .iter()
            .filter(|r| Some(r.0) == id)
            .map(|r| json!({"id": r.1, "name": r.2, "origin": r.3}))
            .collect::<Vec<_>>()
            .into();
    }
    Ok(())
}

#[async_trait]
impl ContactService for Contacts {
    async fn upsert(&self, ws: Uuid, r: UpsertContact) -> Result<Value> {
        let c = contacts::upsert_contact(
            &self.db,
            ws,
            &ContactInput {
                email: r.email,
                first_name: r.first_name,
                last_name: r.last_name,
                timezone: r.timezone,
                properties: r.properties,
                consent: None,
            },
            Utc::now(),
        )
        .await
        .map_err(ae)?;
        Ok(serde_json::to_value(c).unwrap_or_default())
    }

    async fn update(&self, ws: Uuid, id_or_email: &str, r: UpsertContact) -> Result<Value> {
        let id = resolve(&self.db, ws, id_or_email).await?;
        contacts::patch_contact(
            &self.db,
            ws,
            id,
            &ContactInput {
                email: r.email,
                first_name: r.first_name,
                last_name: r.last_name,
                timezone: r.timezone,
                properties: r.properties,
                consent: None,
            },
            Utc::now(),
        )
        .await
        .map_err(ae)?;
        self.get(ws, &id.to_string()).await
    }

    async fn get(&self, ws: Uuid, id_or_email: &str) -> Result<Value> {
        let id = resolve(&self.db, ws, id_or_email).await?;
        let c = contacts::get_contact(&self.db, id).await.map_err(ae)?;
        let reasons = suppression_reasons(&self.db, ws, std::slice::from_ref(&c.email)).await?;
        let mut v = [with_suppression(c, &reasons)];
        attach_lists(&self.db, &mut v).await?;
        let [v] = v;
        Ok(v)
    }

    async fn activity(&self, ws: Uuid, id_or_email: &str) -> Result<Value> {
        let id = resolve(&self.db, ws, id_or_email).await?;
        let c = contacts::get_contact(&self.db, id).await.map_err(ae)?;
        let events: Vec<(Uuid, String, Value, chrono::DateTime<Utc>)> = sqlx::query_as(
            "SELECT id, name, properties, received_at FROM track_events WHERE contact_id = $1 \
             ORDER BY received_at DESC, id LIMIT 25",
        )
        .bind(id)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        // API sends carry no contact_id, so match the recipient address too (trigram-indexed ILIKE).
        let emails: Vec<(Uuid, String, String, String, String, chrono::DateTime<Utc>)> = sqlx::query_as(
            "SELECT id, subject, status, stream, source, created_at FROM emails WHERE workspace_id = $1 \
             AND (contact_id = $2 OR to_addr ILIKE replace(replace(replace($3, '\\', '\\\\'), '%', '\\%'), '_', '\\_')) \
             ORDER BY created_at DESC, id DESC LIMIT 25",
        )
        .bind(ws)
        .bind(id)
        .bind(&c.email)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        let runs: Vec<(Uuid, Uuid, String, String, Option<String>, chrono::DateTime<Utc>, Option<chrono::DateTime<Utc>>)> = sqlx::query_as(
            "SELECT r.id, r.automation_id, a.name, r.state, r.current_step, r.started_at, r.ended_at \
             FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.contact_id = $1 \
             ORDER BY r.started_at DESC, r.id LIMIT 25",
        )
        .bind(id)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        let topics: Vec<(String, String, bool)> = sqlx::query_as(
            "SELECT t.key, t.name, ct.opted_in FROM contact_topics ct JOIN topics t ON t.id = ct.topic_id \
             WHERE ct.contact_id = $1 ORDER BY t.key",
        )
        .bind(id)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        // A manual list is its stored members; a rule-based segment is whoever matches now.
        let all: Vec<(Uuid, String, Option<Value>, bool)> = sqlx::query_as(
            "SELECT s.id, s.name, s.filter, EXISTS (SELECT 1 FROM segment_members m WHERE m.segment_id = s.id AND m.contact_id = $2) \
             FROM segments s WHERE s.workspace_id = $1 ORDER BY s.name",
        )
        .bind(ws)
        .bind(id)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        let mut segments = Vec::new();
        for (sid, name, filter, member) in all {
            let rule = filter.and_then(|f| serde_json::from_value::<Rule>(f).ok());
            let inside = match &rule {
                Some(r) => contacts::contact_matches(&self.db, id, r)
                    .await
                    .map_err(ae)?,
                None => member,
            };
            if inside {
                segments.push((sid, name));
            }
        }
        Ok(json!({
            "events": events.into_iter().map(|(id, name, properties, received_at)| json!({"id": id, "name": name, "properties": properties, "received_at": received_at})).collect::<Vec<_>>(),
            "emails": emails.into_iter().map(|(id, subject, status, stream, source, created_at)| json!({"id": id, "subject": subject, "status": status, "stream": stream, "source": source, "created_at": created_at})).collect::<Vec<_>>(),
            "runs": runs.into_iter().map(|(id, automation_id, automation, state, current_step, started_at, ended_at)| json!({"id": id, "automation_id": automation_id, "automation": automation, "state": state, "current_step": current_step, "started_at": started_at, "ended_at": ended_at})).collect::<Vec<_>>(),
            "topics": topics.into_iter().map(|(key, name, opted_in)| json!({"key": key, "name": name, "opted_in": opted_in})).collect::<Vec<_>>(),
            "segments": segments.into_iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
        }))
    }

    async fn list(
        &self,
        ws: Uuid,
        limit: u32,
        cursor: Option<String>,
        q: Option<String>,
        list: Option<Uuid>,
    ) -> Result<Page> {
        let (at, id) = page::decode(cursor.as_deref()).map_err(|e| e.0)?;
        let lim = i64::from(limit);
        let rows: Vec<contacts::Contact> = sqlx::query_as(
            "SELECT id, workspace_id, email, first_name, last_name, properties, timezone, created_at FROM contacts \
             WHERE workspace_id = $1 AND (created_at, id::text) < ($2, $3) \
             AND ($5::text IS NULL OR email ILIKE $5 OR first_name ILIKE $5 OR last_name ILIKE $5 \
                  OR concat_ws(' ', first_name, last_name) ILIKE $5) \
             AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM segment_members m WHERE m.segment_id = $6 AND m.contact_id = contacts.id)) \
             ORDER BY created_at DESC, id::text DESC LIMIT $4",
        )
        .bind(ws)
        .bind(at)
        .bind(id)
        .bind(lim + 1)
        .bind(like(q.as_deref()))
        .bind(list)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        let next_cursor = (rows.len() as i64 > lim)
            .then(|| page::encode(rows[lim as usize - 1].created_at, rows[lim as usize - 1].id));
        let rows: Vec<_> = rows.into_iter().take(lim as usize).collect();
        let emails: Vec<String> = rows.iter().map(|c| c.email.clone()).collect();
        let reasons = suppression_reasons(&self.db, ws, &emails).await?;
        let mut items: Vec<Value> = rows
            .into_iter()
            .map(|c| with_suppression(c, &reasons))
            .collect();
        attach_lists(&self.db, &mut items).await?;
        Ok(Page { items, next_cursor })
    }

    async fn delete(&self, ws: Uuid, id_or_email: &str) -> Result<()> {
        let id = resolve(&self.db, ws, id_or_email).await?;
        // Erasure: history that references the contact goes with it (emails keep their row).
        let mut tx = self.db.begin().await.map_err(db)?;
        for q in [
            "UPDATE emails SET contact_id = NULL WHERE contact_id = $1",
            "DELETE FROM automation_runs WHERE contact_id = $1",
            "DELETE FROM track_events WHERE contact_id = $1",
            "DELETE FROM contacts WHERE id = $1",
        ] {
            sqlx::query(q)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }

    async fn suppress(&self, ws: Uuid, id_or_email: &str, reason: &str) -> Result<()> {
        let id = resolve(&self.db, ws, id_or_email).await?;
        // `reason` is free text from the caller; the column is an enum, so anything else is `manual`.
        let known = [
            "hard_bounce",
            "soft_bounce_limit",
            "complaint",
            "unsubscribe",
            "manual",
            "spam_trap",
        ];
        let col = if known.contains(&reason) {
            reason
        } else {
            "manual"
        };
        sqlx::query(
            "INSERT INTO suppressions (workspace_id, email, reason, source) SELECT workspace_id, email, $2, 'api' FROM contacts WHERE id = $1 \
             ON CONFLICT (workspace_id, email) DO NOTHING",
        )
        .bind(id)
        .bind(col)
        .execute(&self.db)
        .await
        .map_err(db)?;
        Ok(())
    }
}

pub struct Segments {
    db: PgPool,
}

/// Names of automations whose steps reference a segment by any of `keys` (its name or id).
pub(crate) async fn segment_users(
    db: &PgPool,
    ws: Uuid,
    keys: &[&str],
) -> std::result::Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT DISTINCT a.name FROM automations a JOIN automation_versions v ON v.automation_id = a.id, \
         jsonb_array_elements(v.steps) st WHERE a.workspace_id = $1 AND st->'config'->>'segment' = ANY($2) ORDER BY 1",
    )
    .bind(ws)
    .bind(keys.iter().map(|k| k.to_string()).collect::<Vec<_>>())
    .fetch_all(db)
    .await
}

/// Parses and validates a filter so a rule the SQL compiler cannot express never gets stored.
fn parse_rule(filter: Option<&Value>) -> Result<Option<Rule>> {
    let rule: Option<Rule> = filter
        .filter(|f| !f.is_null())
        .map(|f| serde_json::from_value(f.clone()))
        .transpose()
        .map_err(|e| Error::new("invalid_request", 400, format!("filter: {e}")).field("filter"))?;
    if let Some(r) = &rule {
        r.validate().map_err(|e| ae(e).field("filter"))?;
    }
    Ok(rule)
}

#[async_trait]
impl SegmentService for Segments {
    async fn create(&self, ws: Uuid, name: &str, filter: Option<Value>) -> Result<Value> {
        let rule = parse_rule(filter.as_ref())?;
        let id = contacts::create_segment(&self.db, ws, name, rule.as_ref())
            .await
            .map_err(ae)?;
        Ok(json!({"id": id, "name": name, "filter": filter}))
    }

    async fn update(&self, ws: Uuid, id: Uuid, name: &str, filter: Option<Value>) -> Result<Value> {
        let rule = parse_rule(filter.as_ref())?;
        // A source's list is filled by the sync; turning it into a rule would make the poller empty it.
        let fed: Option<bool> = sqlx::query_scalar(
            "SELECT source_id IS NOT NULL FROM segments WHERE id = $1 AND workspace_id = $2",
        )
        .bind(id)
        .bind(ws)
        .fetch_optional(&self.db)
        .await
        .map_err(db)?;
        if fed == Some(true) && rule.is_some() {
            return Err(Error::new(
                "invalid_state",
                409,
                "this list is fed by a contact source and cannot become a rule-based segment",
            ));
        }
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM segments WHERE workspace_id = $1 AND name = $2 AND id <> $3)",
        )
        .bind(ws)
        .bind(name)
        .bind(id)
        .fetch_one(&self.db)
        .await
        .map_err(db)?;
        if taken {
            return Err(Error::new(
                "invalid_state",
                409,
                format!("a segment named `{name}` already exists"),
            )
            .field("name"));
        }
        let n = sqlx::query(
            "UPDATE segments SET name = $3, filter = $4 WHERE id = $1 AND workspace_id = $2",
        )
        .bind(id)
        .bind(ws)
        .bind(name)
        .bind(rule.as_ref().map(sqlx::types::Json))
        .execute(&self.db)
        .await
        .map_err(db)?
        .rows_affected();
        if n == 0 {
            return Err(not_found("segment"));
        }
        Ok(json!({"id": id, "name": name, "filter": rule}))
    }

    async fn delete(&self, ws: Uuid, id: Uuid) -> Result<()> {
        let name: String =
            sqlx::query_scalar("SELECT name FROM segments WHERE id = $1 AND workspace_id = $2")
                .bind(id)
                .bind(ws)
                .fetch_optional(&self.db)
                .await
                .map_err(db)?
                .ok_or_else(|| not_found("segment"))?;
        // Triggers and `add_to_segment` steps name a segment by name or id; deleting it would
        // make every later poll of that automation fail.
        let users = segment_users(&self.db, ws, &[&name, &id.to_string()])
            .await
            .map_err(db)?;
        if !users.is_empty() {
            return Err(Error::new(
                "invalid_state",
                409,
                format!("automation(s) still use this segment: {}", users.join(", ")),
            )
            .hint("change or delete those automations first"));
        }
        sqlx::query("DELETE FROM segments WHERE id = $1")
            .bind(id)
            .execute(&self.db)
            .await
            .map_err(db)?;
        Ok(())
    }

    async fn preview(&self, ws: Uuid, filter: Value) -> Result<Value> {
        let rule = parse_rule(Some(&filter))?.ok_or_else(|| {
            Error::new("invalid_request", 400, "filter is required").field("filter")
        })?;
        let count = contacts::count_matching(&self.db, ws, &rule)
            .await
            .map_err(ae)?;
        let sample = contacts::sample_matching(&self.db, ws, &rule, 5)
            .await
            .map_err(ae)?;
        Ok(json!({
            "count": count,
            "sample": sample.into_iter().map(|(email, first_name, last_name)| json!({"email": email, "first_name": first_name, "last_name": last_name})).collect::<Vec<_>>(),
        }))
    }

    async fn list(&self, ws: Uuid) -> Result<Vec<Value>> {
        type Seg = (Uuid, String, Option<Value>, i64, String, Option<String>);
        let rows: Vec<Seg> = sqlx::query_as(
            "SELECT s.id, s.name, s.filter, (SELECT count(*) FROM segment_members m WHERE m.segment_id = s.id), s.origin, s.description \
             FROM segments s WHERE s.workspace_id = $1 ORDER BY s.name",
        )
        .bind(ws)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        let mut out = Vec::with_capacity(rows.len());
        for (id, name, filter, stored, origin, description) in rows {
            // A rule-based segment is whoever matches now; its stored members are only the last poll's snapshot.
            let live = match filter
                .as_ref()
                .and_then(|f| serde_json::from_value::<Rule>(f.clone()).ok())
            {
                Some(r) => contacts::count_matching(&self.db, ws, &r).await.ok(),
                None => None,
            };
            let members = live.unwrap_or(stored);
            out.push(json!({"id": id, "name": name, "filter": filter, "members": members, "member_count": members, "origin": origin, "description": description}));
        }
        Ok(out)
    }

    async fn add_members(&self, ws: Uuid, segment: Uuid, emails: Vec<String>) -> Result<Value> {
        let seg = contacts::resolve_segment(&self.db, ws, &segment.to_string())
            .await
            .map_err(ae)?;
        let now = Utc::now();
        let (mut added, mut existing) = (0, 0);
        for e in emails {
            let c = contacts::upsert_contact(
                &self.db,
                ws,
                &ContactInput {
                    email: e,
                    ..Default::default()
                },
                now,
            )
            .await
            .map_err(ae)?;
            if contacts::add_to_segment(&self.db, seg, c.id, now)
                .await
                .map_err(ae)?
            {
                added += 1;
            } else {
                existing += 1;
            }
        }
        Ok(json!({"segment_id": seg, "added": added, "already_members": existing}))
    }
}

pub struct Events {
    engine: Engine,
}

#[async_trait]
impl EventService for Events {
    async fn track(&self, ws: Uuid, r: TrackEvent) -> Result<Value> {
        if r.dry_run {
            let hits: Vec<(Uuid, String, String)> = sqlx::query_as(
                "SELECT id, name, status FROM automations WHERE workspace_id = $1 AND trigger_event = $2 ORDER BY name",
            )
            .bind(ws)
            .bind(&r.name)
            .fetch_all(self.engine.pool())
            .await
            .map_err(db)?;
            return Ok(json!({
                "dry_run": true,
                "event": r.name,
                "event_id": null,
                "contact_id": null,
                "triggered_automations": hits.iter().filter(|h| h.2 == "active").map(|h| json!({"id": h.0, "name": h.1, "run_id": null})).collect::<Vec<_>>(),
                "would_send": [],
                "inactive_matches": hits.iter().filter(|h| h.2 != "active").map(|h| json!({"id": h.0, "name": h.1, "status": h.2})).collect::<Vec<_>>(),
            }));
        }
        let t0 = Utc::now();
        let t = self
            .engine
            .ingest(
                ws,
                TrackInput {
                    name: r.name,
                    contact: ContactInput {
                        email: r.contact.email,
                        properties: r.contact_properties,
                        ..Default::default()
                    },
                    properties: r.properties.unwrap_or(Value::Null),
                    idempotency_key: r.idempotency_key,
                    suppress_entry: false,
                },
                Utc::now(),
            )
            .await
            .map_err(ae)?;
        let runs: Vec<(Uuid, Uuid)> = sqlx::query_as("SELECT automation_id, id FROM automation_runs WHERE contact_id = $1 AND started_at >= $2")
            .bind(t.contact_id)
            .bind(t0)
            .fetch_all(self.engine.pool())
            .await
            .map_err(db)?;
        Ok(json!({
            "event_id": t.event_id, "contact_id": t.contact_id, "duplicate": t.duplicate,
            "triggered_automations": runs.into_iter().map(|(a, run)| json!({"id": a, "run_id": run})).collect::<Vec<_>>(),
            "would_send": [],
        }))
    }
}

impl AppState {
    /// State with the real domain / contact / segment / event services. `secret_key` is the raw
    /// `MAILCRAFT_SECRET_KEY` value (hex, base64 or passphrase); the deliverability crate keeps its
    /// own `SecretBox`, so both are built from it. Falls back to the 501 stub for domains when no
    /// system DNS resolver can be built.
    pub fn with_services(
        db: PgPool,
        redis: Option<redis::aio::ConnectionManager>,
        secret_key: &str,
        config: crate::Config,
        personalizer: Arc<dyn Personalizer>,
    ) -> Result<Self> {
        let secrets = mailcraft_core::crypto::SecretBox::from_secret(secret_key)?;
        let mut st = Self::new(db.clone(), redis, secrets.clone(), config);
        let deliv = secrets;
        st.dkim_box = Some(deliv.clone());
        match HickoryDns::system() {
            Ok(dns) => {
                st.domains = Arc::new(Domains::new(db.clone(), deliv, dns, instance_from_env()))
            }
            Err(e) => tracing::warn!(error = %e, "no system DNS resolver: domains stay 501"),
        }
        st.contacts = Arc::new(Contacts { db: db.clone() });
        st.segments = Arc::new(Segments { db: db.clone() });
        st.events = Arc::new(Events {
            engine: Engine::new(db, personalizer, EngineConfig::default()),
        });
        Ok(st)
    }
}
