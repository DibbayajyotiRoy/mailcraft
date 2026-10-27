//! Contacts, topics (unsubscribe categories) and segments.
use crate::error::{AutomationError, Result};
use crate::rules::Rule;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgExecutor, QueryBuilder};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Contact {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub properties: Value,
    pub timezone: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl Contact {
    /// JSON used by rules/templates: properties flattened, fixed columns win.
    pub fn to_json(&self) -> Value {
        let mut m = self.properties.as_object().cloned().unwrap_or_default();
        m.insert("properties".into(), self.properties.clone());
        m.insert("id".into(), json!(self.id));
        m.insert("email".into(), json!(self.email));
        m.insert("first_name".into(), json!(self.first_name));
        m.insert("last_name".into(), json!(self.last_name));
        m.insert("timezone".into(), json!(self.timezone));
        Value::Object(m)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContactInput {
    pub email: String,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    /// Merged into existing properties (shallow).
    #[serde(default)]
    pub properties: Option<Value>,
    /// Consent ledger entry `{at, ip, source, text}`; only written when the contact has none.
    #[serde(default)]
    pub consent: Option<Value>,
}

/// Trim and lowercase the domain part.
pub fn normalize_email(raw: &str) -> Result<String> {
    let e = raw.trim();
    match e.rsplit_once('@') {
        Some((l, d)) if !l.is_empty() && d.contains('.') && !e.contains(char::is_whitespace) => {
            Ok(format!("{l}@{}", d.to_lowercase()))
        }
        _ => Err(AutomationError::invalid(format!(
            "`{raw}` is not a valid email address"
        ))),
    }
}

pub async fn upsert_contact(
    db: impl PgExecutor<'_>,
    workspace_id: Uuid,
    input: &ContactInput,
    now: DateTime<Utc>,
) -> Result<Contact> {
    let email = normalize_email(&input.email)?;
    if let Some(p) = &input.properties {
        if !p.is_object() {
            return Err(AutomationError::invalid("properties must be a JSON object"));
        }
    }
    Ok(sqlx::query_as::<_, Contact>(
        "INSERT INTO contacts (workspace_id, email, first_name, last_name, timezone, properties, consent, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, '{}'::jsonb), $7, $8, $8)
         ON CONFLICT (workspace_id, email) DO UPDATE SET
           first_name = COALESCE($3, contacts.first_name),
           last_name  = COALESCE($4, contacts.last_name),
           timezone   = COALESCE($5, contacts.timezone),
           properties = contacts.properties || COALESCE($6, '{}'::jsonb),
           consent    = COALESCE(contacts.consent, $7),
           updated_at = $8
         RETURNING id, workspace_id, email, first_name, last_name, properties, timezone, created_at",
    )
    .bind(workspace_id)
    .bind(email)
    .bind(&input.first_name)
    .bind(&input.last_name)
    .bind(&input.timezone)
    .bind(input.properties.as_ref().map(sqlx::types::Json))
    .bind(input.consent.as_ref().map(sqlx::types::Json))
    .bind(now)
    .fetch_one(db)
    .await?)
}

pub async fn get_contact(db: impl PgExecutor<'_>, contact_id: Uuid) -> Result<Contact> {
    sqlx::query_as::<_, Contact>(
        "SELECT id, workspace_id, email, first_name, last_name, properties, timezone, created_at FROM contacts WHERE id = $1",
    )
    .bind(contact_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AutomationError::not_found(format!("contact {contact_id}")))
}

pub async fn upsert_topic(
    db: impl PgExecutor<'_>,
    workspace_id: Uuid,
    key: &str,
    name: &str,
    default_opt_in: bool,
    can_unsubscribe: bool,
) -> Result<Uuid> {
    Ok(sqlx::query_scalar(
        "INSERT INTO topics (workspace_id, key, name, default_opt_in, can_unsubscribe) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workspace_id, key) DO UPDATE SET name = $3, default_opt_in = $4, can_unsubscribe = $5
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(key)
    .bind(name)
    .bind(default_opt_in)
    .bind(can_unsubscribe)
    .fetch_one(db)
    .await?)
}

/// Opt a contact in or out of a topic (`opted_in = false` is the unsubscribe).
pub async fn set_topic(
    db: impl PgExecutor<'_>,
    workspace_id: Uuid,
    contact_id: Uuid,
    topic_key: &str,
    opted_in: bool,
    now: DateTime<Utc>,
) -> Result<()> {
    let n = sqlx::query(
        "INSERT INTO contact_topics (contact_id, topic_id, opted_in, updated_at)
         SELECT $2, t.id, $3, $4 FROM topics t WHERE t.workspace_id = $1 AND t.key = $5
         ON CONFLICT (contact_id, topic_id) DO UPDATE SET opted_in = $3, updated_at = $4",
    )
    .bind(workspace_id)
    .bind(contact_id)
    .bind(opted_in)
    .bind(now)
    .bind(topic_key)
    .execute(db)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AutomationError::not_found(format!("topic `{topic_key}`")));
    }
    Ok(())
}

pub async fn create_segment(
    db: impl PgExecutor<'_>,
    workspace_id: Uuid,
    name: &str,
    filter: Option<&Rule>,
) -> Result<Uuid> {
    Ok(sqlx::query_scalar(
        "INSERT INTO segments (workspace_id, name, filter) VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id, name) DO UPDATE SET filter = $3 RETURNING id",
    )
    .bind(workspace_id)
    .bind(name)
    .bind(filter.map(|f| sqlx::types::Json(f.clone())))
    .fetch_one(db)
    .await?)
}

/// Accepts a segment id or name.
pub async fn resolve_segment(
    db: impl PgExecutor<'_>,
    workspace_id: Uuid,
    name_or_id: &str,
) -> Result<Uuid> {
    let by_id = name_or_id.parse::<Uuid>().ok();
    sqlx::query_scalar("SELECT id FROM segments WHERE workspace_id = $1 AND (id = $2 OR name = $3)")
        .bind(workspace_id)
        .bind(by_id)
        .bind(name_or_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AutomationError::not_found(format!("segment `{name_or_id}`")))
}

pub async fn add_to_segment(
    db: impl PgExecutor<'_>,
    segment_id: Uuid,
    contact_id: Uuid,
    now: DateTime<Utc>,
) -> Result<bool> {
    Ok(sqlx::query(
        "INSERT INTO segment_members (segment_id, contact_id, added_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    )
    .bind(segment_id)
    .bind(contact_id)
    .bind(now)
    .execute(db)
    .await?
    .rows_affected()
        > 0)
}

/// Contacts matching a filter right now (evaluated in SQL).
pub async fn matching_contacts(
    db: impl PgExecutor<'_>,
    workspace_id: Uuid,
    filter: &Rule,
) -> Result<Vec<Uuid>> {
    let mut qb = QueryBuilder::new("SELECT c.id FROM contacts c WHERE c.workspace_id = ");
    qb.push_bind(workspace_id).push(" AND ");
    filter.push_sql(&mut qb)?;
    Ok(qb.build_query_scalar().fetch_all(db).await?)
}

/// Recompute a dynamic segment's membership. Returns the contacts that newly entered.
/// Static segments (no filter) are left alone.
pub async fn materialize_segment(
    pool: &sqlx::PgPool,
    segment_id: Uuid,
    now: DateTime<Utc>,
) -> Result<Vec<Uuid>> {
    let row: Option<(Uuid, Option<sqlx::types::Json<Rule>>)> =
        sqlx::query_as("SELECT workspace_id, filter FROM segments WHERE id = $1")
            .bind(segment_id)
            .fetch_optional(pool)
            .await?;
    let Some((ws, Some(sqlx::types::Json(filter)))) = row else {
        return Ok(vec![]);
    };
    let mut tx = pool.begin().await?;
    let matching = matching_contacts(&mut *tx, ws, &filter).await?;
    sqlx::query("DELETE FROM segment_members WHERE segment_id = $1 AND NOT (contact_id = ANY($2))")
        .bind(segment_id)
        .bind(&matching)
        .execute(&mut *tx)
        .await?;
    let entered = sqlx::query_scalar(
        "INSERT INTO segment_members (segment_id, contact_id, added_at)
         SELECT $1, m, $3 FROM unnest($2::uuid[]) m ON CONFLICT DO NOTHING RETURNING contact_id",
    )
    .bind(segment_id)
    .bind(&matching)
    .bind(now)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(entered)
}
