//! Read-only "what would change" for a contact, shared by the import and contact-source previews.
//! Mirrors what `upsert_contact` writes: names and timezone replace when given, `properties` merge
//! shallowly (given keys overwrite, others stay).
use std::collections::HashMap;

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
pub struct Existing {
    pub id: Uuid,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub timezone: Option<String>,
    pub properties: Value,
    pub external_source_id: Option<Uuid>,
}

/// The contacts that already have one of `emails` (already normalised), keyed by email.
pub async fn existing(
    db: &PgPool,
    ws: Uuid,
    emails: &[String],
) -> Result<HashMap<String, Existing>, sqlx::Error> {
    let rows: Vec<Existing> = sqlx::query_as(
        "SELECT id, email, first_name, last_name, timezone, properties, external_source_id FROM contacts WHERE workspace_id = $1 AND email = ANY($2)",
    )
    .bind(ws)
    .bind(emails)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|c| (c.email.clone(), c)).collect())
}

/// `[{field, old, new}]` for what an upsert of these values would change on `c`.
pub fn changes(
    c: &Existing,
    first_name: Option<&str>,
    last_name: Option<&str>,
    timezone: Option<&str>,
    properties: Option<&Value>,
) -> Vec<Value> {
    let mut out = Vec::new();
    for (field, old, new) in [
        ("first_name", &c.first_name, first_name),
        ("last_name", &c.last_name, last_name),
        ("timezone", &c.timezone, timezone),
    ] {
        if let Some(n) = new.filter(|n| old.as_deref() != Some(*n)) {
            out.push(json!({"field": field, "old": old, "new": n}));
        }
    }
    if let Some(p) = properties.and_then(Value::as_object) {
        for (k, v) in p {
            let old = c.properties.get(k);
            if old != Some(v) {
                out.push(json!({"field": format!("properties.{k}"), "old": old, "new": v}));
            }
        }
    }
    out
}

/// Which of `ids` are already on `list`.
pub async fn members(
    db: &PgPool,
    list: Uuid,
    ids: &[Uuid],
) -> Result<std::collections::HashSet<Uuid>, sqlx::Error> {
    Ok(sqlx::query_scalar(
        "SELECT contact_id FROM segment_members WHERE segment_id = $1 AND contact_id = ANY($2)",
    )
    .bind(list)
    .bind(ids)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_differences_count() {
        let c = Existing {
            id: Uuid::nil(),
            email: "a@x.io".into(),
            first_name: Some("Ana".into()),
            last_name: None,
            timezone: None,
            properties: json!({"plan": "free", "vip": true}),
            external_source_id: None,
        };
        assert!(changes(&c, Some("Ana"), None, None, Some(&json!({"plan": "free"}))).is_empty());
        let d = changes(
            &c,
            Some("Anna"),
            Some("Li"),
            None,
            Some(&json!({"plan": "pro", "new": 1})),
        );
        let fields: Vec<_> = d.iter().map(|x| x["field"].as_str().unwrap()).collect();
        assert_eq!(
            fields,
            [
                "first_name",
                "last_name",
                "properties.plan",
                "properties.new"
            ]
        );
        assert_eq!(d[0]["old"], "Ana");
        assert_eq!(d[3]["old"], "free");
    }
}
