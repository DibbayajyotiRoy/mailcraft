//! Hash-chain maths for the append-only audit log (SPEC 14): `row_hash = sha256(prev_hash || canonical(row))`.
use serde_json::Value;
use uuid::Uuid;

use crate::crypto::sha256;

/// Everything that is hashed. `at_micros` is microseconds since the epoch (Postgres precision).
#[derive(Debug, Clone)]
pub struct AuditRow {
    pub workspace_id: Uuid,
    pub at_micros: i64,
    pub actor_type: String,
    pub actor_id: Option<Uuid>,
    pub action: String,
    pub args: Value,
    pub decision: String,
    pub approval_id: Option<Uuid>,
}

/// Key-sorted JSON so the hash does not depend on map ordering or jsonb round trips.
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<_> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), canonical_json(&m[k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical_json).collect::<Vec<_>>().join(",")
        ),
        other => other.to_string(),
    }
}

pub fn row_hash(prev: Option<&[u8]>, r: &AuditRow) -> [u8; 32] {
    let mut buf = Vec::new();
    buf.extend_from_slice(prev.unwrap_or(&[]));
    for part in [
        r.workspace_id.to_string(),
        r.at_micros.to_string(),
        r.actor_type.clone(),
        r.actor_id.map(|u| u.to_string()).unwrap_or_default(),
        r.action.clone(),
        canonical_json(&r.args),
        r.decision.clone(),
        r.approval_id.map(|u| u.to_string()).unwrap_or_default(),
    ] {
        buf.push(0x1f);
        buf.extend_from_slice(part.as_bytes());
    }
    sha256(&buf)
}

const SENSITIVE: [&str; 7] = [
    "secret",
    "token",
    "password",
    "authorization",
    "api_key",
    "private_key",
    "credential",
];

/// Redacts values whose key looks secret-bearing, recursively.
pub fn redact(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, val)| {
                    let lk = k.to_ascii_lowercase();
                    if SENSITIVE.iter().any(|s| lk.contains(s)) {
                        (k.clone(), Value::String("[redacted]".into()))
                    } else {
                        (k.clone(), redact(val))
                    }
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(redact).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(action: &str) -> AuditRow {
        AuditRow {
            workspace_id: Uuid::nil(),
            at_micros: 1,
            actor_type: "system".into(),
            actor_id: None,
            action: action.into(),
            args: json!({"b":1,"a":{"y":2,"x":3}}),
            decision: "auto".into(),
            approval_id: None,
        }
    }

    #[test]
    fn chain_depends_on_prev_and_content() {
        let h1 = row_hash(None, &row("a"));
        assert_ne!(h1, row_hash(None, &row("b")));
        assert_ne!(row_hash(Some(&h1), &row("a")), h1);
        assert_eq!(
            canonical_json(&row("a").args),
            r#"{"a":{"x":3,"y":2},"b":1}"#
        );
    }

    #[test]
    fn redacts_nested_secrets() {
        let r = redact(&json!({"name":"k","token":"mc_live_x","n":{"webhook_secret":"s","ok":1}}));
        assert_eq!(r["token"], "[redacted]");
        assert_eq!(r["n"]["webhook_secret"], "[redacted]");
        assert_eq!(r["n"]["ok"], 1);
    }
}
