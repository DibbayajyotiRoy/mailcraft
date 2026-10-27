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
        let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
            "SELECT record, type, name, value, status FROM domain_records WHERE domain_id = $1 ORDER BY record, name",
        )
        .bind(d.id)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        Ok(DomainView {
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
                .map(|(record, kind, name, value, status)| DnsRecord {
                    record,
                    kind,
                    name,
                    value,
                    status,
                })
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

    async fn get(&self, ws: Uuid, id_or_email: &str) -> Result<Value> {
        let id = resolve(&self.db, ws, id_or_email).await?;
        let c = contacts::get_contact(&self.db, id).await.map_err(ae)?;
        let suppressed: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2)",
        )
        .bind(ws)
        .bind(&c.email)
        .fetch_one(&self.db)
        .await
        .map_err(db)?;
        let mut v = serde_json::to_value(c).unwrap_or_default();
        v["suppressed"] = json!(suppressed);
        Ok(v)
    }

    async fn list(&self, ws: Uuid, limit: u32, cursor: Option<String>) -> Result<Page> {
        let (at, id) = page::decode(cursor.as_deref()).map_err(|e| e.0)?;
        let lim = i64::from(limit);
        let rows: Vec<contacts::Contact> = sqlx::query_as(
            "SELECT id, workspace_id, email, first_name, last_name, properties, timezone, created_at FROM contacts \
             WHERE workspace_id = $1 AND (created_at, id::text) < ($2, $3) ORDER BY created_at DESC, id::text DESC LIMIT $4",
        )
        .bind(ws)
        .bind(at)
        .bind(id)
        .bind(lim + 1)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        let next_cursor = (rows.len() as i64 > lim)
            .then(|| page::encode(rows[lim as usize - 1].created_at, rows[lim as usize - 1].id));
        let items = rows
            .into_iter()
            .take(lim as usize)
            .map(|c| serde_json::to_value(c).unwrap_or_default())
            .collect();
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

#[async_trait]
impl SegmentService for Segments {
    async fn create(&self, ws: Uuid, name: &str, filter: Option<Value>) -> Result<Value> {
        let rule: Option<Rule> = filter
            .as_ref()
            .map(|f| serde_json::from_value(f.clone()))
            .transpose()
            .map_err(|e| {
                Error::new("invalid_request", 400, format!("filter: {e}")).field("filter")
            })?;
        let id = contacts::create_segment(&self.db, ws, name, rule.as_ref())
            .await
            .map_err(ae)?;
        Ok(json!({"id": id, "name": name, "filter": filter}))
    }

    async fn list(&self, ws: Uuid) -> Result<Vec<Value>> {
        let rows: Vec<(Uuid, String, Option<Value>, i64)> = sqlx::query_as(
            "SELECT s.id, s.name, s.filter, (SELECT count(*) FROM segment_members m WHERE m.segment_id = s.id) \
             FROM segments s WHERE s.workspace_id = $1 ORDER BY s.name",
        )
        .bind(ws)
        .fetch_all(&self.db)
        .await
        .map_err(db)?;
        Ok(rows.into_iter().map(|(id, name, filter, members)| json!({"id": id, "name": name, "filter": filter, "members": members})).collect())
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
        let bad = |m: String| Error::new("invalid_secret_key", 500, m);
        let secrets =
            mailcraft_core::crypto::SecretBox::from_env_value(secret_key).or_else(|_| {
                mailcraft_core::crypto::SecretBox::from_key(&mailcraft_core::crypto::sha256(
                    secret_key.as_bytes(),
                ))
            })?;
        let mut st = Self::new(db.clone(), redis, secrets, config);
        let deliv = DelivBox::from_secret(secret_key).map_err(|e| bad(e.to_string()))?;
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
