//! Rule trees: evaluated in Rust against a JSON context (conditions, goals, trigger filters)
//! and compiled to SQL over `contacts` (segments).
use crate::error::{AutomationError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, QueryBuilder};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    In,
    Contains,
    Exists,
}

/// `{"and":[..]}`, `{"or":[..]}`, `{"not":..}` or `{"field":"contact.plan","op":"eq","value":"pro"}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Rule {
    And {
        and: Vec<Rule>,
    },
    Or {
        or: Vec<Rule>,
    },
    Not {
        not: Box<Rule>,
    },
    Cmp {
        field: String,
        op: Op,
        #[serde(default)]
        value: Value,
    },
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn lookup<'a>(ctx: &'a Value, field: &str) -> Option<&'a Value> {
    if let Some(v) = ctx.get(field) {
        return Some(v); // prefetched keys such as `event_count:foo` contain dots/colons
    }
    let mut cur = ctx;
    for part in field.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur)
}

fn values_eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b)) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

fn order(a: &Value, b: &Value) -> Option<std::cmp::Ordering> {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => num(a)?.partial_cmp(&num(b)?),
        (Value::String(x), Value::String(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

impl Rule {
    pub fn eval(&self, ctx: &Value) -> bool {
        match self {
            Rule::And { and } => and.iter().all(|r| r.eval(ctx)),
            Rule::Or { or } => or.iter().any(|r| r.eval(ctx)),
            Rule::Not { not } => !not.eval(ctx),
            Rule::Cmp { field, op, value } => {
                let got = lookup(ctx, field).filter(|v| !v.is_null());
                match op {
                    Op::Exists => got.is_some() == value.as_bool().unwrap_or(true),
                    Op::Eq => got.is_some_and(|g| values_eq(g, value)),
                    Op::Neq => !got.is_some_and(|g| values_eq(g, value)),
                    Op::Lt | Op::Lte | Op::Gt | Op::Gte => {
                        got.and_then(|g| order(g, value)).is_some_and(|o| match op {
                            Op::Lt => o.is_lt(),
                            Op::Lte => o.is_le(),
                            Op::Gt => o.is_gt(),
                            _ => o.is_ge(),
                        })
                    }
                    Op::In => got.is_some_and(|g| {
                        value
                            .as_array()
                            .is_some_and(|a| a.iter().any(|x| values_eq(g, x)))
                    }),
                    Op::Contains => got.is_some_and(|g| match (g, value) {
                        (Value::Array(a), v) => a.iter().any(|x| values_eq(x, v)),
                        (Value::String(s), Value::String(v)) => s.contains(v.as_str()),
                        _ => false,
                    }),
                }
            }
        }
    }

    /// Every field name referenced (used to prefetch DB-backed fields).
    pub fn fields(&self, out: &mut Vec<String>) {
        match self {
            Rule::And { and: r } | Rule::Or { or: r } => r.iter().for_each(|x| x.fields(out)),
            Rule::Not { not } => not.fields(out),
            Rule::Cmp { field, .. } => out.push(field.clone()),
        }
    }

    /// Rejects a rule the SQL compiler cannot express (unknown field, bad operand) before it is stored.
    pub fn validate(&self) -> Result<()> {
        self.push_sql(&mut QueryBuilder::new(""))
    }

    /// Append `(<predicate over contacts alias c>)` to `qb`.
    ///
    /// Fields: `email`, `first_name`, `last_name`, `timezone`, `created_at`, `properties.<path>`,
    /// `topic:<key>` (effective opt-in), `list:<id or name>` (true when in that list), `event_count:<name>` and `days_since:<name>` (whole days
    /// since the contact last tracked that event; missing when it never did). The last one is
    /// segments-only: automation conditions are evaluated in Rust against prefetched fields.
    pub fn push_sql(&self, qb: &mut QueryBuilder<'_, Postgres>) -> Result<()> {
        match self {
            Rule::And { and: rs } | Rule::Or { or: rs } => {
                let (word, empty) = if matches!(self, Rule::And { .. }) {
                    (" AND ", "true")
                } else {
                    (" OR ", "false")
                };
                if rs.is_empty() {
                    qb.push(empty);
                }
                qb.push("(");
                for (i, r) in rs.iter().enumerate() {
                    if i > 0 {
                        qb.push(word);
                    }
                    r.push_sql(qb)?;
                }
                qb.push(")");
            }
            Rule::Not { not } => {
                qb.push("(NOT ");
                not.push_sql(qb)?;
                qb.push(")");
            }
            Rule::Cmp { field, op, value } => cmp_sql(qb, field, *op, value)?,
        }
        Ok(())
    }
}

fn push_field(qb: &mut QueryBuilder<'_, Postgres>, field: &str) -> Result<()> {
    const COLS: &[&str] = &[
        "email",
        "first_name",
        "last_name",
        "timezone",
        "created_at",
        "updated_at",
    ];
    if COLS.contains(&field) {
        qb.push(format!("to_jsonb(c.{field})"));
    } else if let Some(path) = field.strip_prefix("properties.") {
        let parts: Vec<String> = path.split('.').map(str::to_owned).collect();
        qb.push("(c.properties #> ")
            .push_bind(parts)
            .push("::text[])");
    } else if let Some(key) = field.strip_prefix("topic:") {
        qb.push("to_jsonb(COALESCE((SELECT ct.opted_in FROM contact_topics ct JOIN topics t ON t.id = ct.topic_id WHERE ct.contact_id = c.id AND t.key = ")
            .push_bind(key.to_owned())
            .push(" AND t.workspace_id = c.workspace_id), (SELECT t.default_opt_in FROM topics t WHERE t.workspace_id = c.workspace_id AND t.key = ")
            .push_bind(key.to_owned())
            .push("), false))");
    } else if let Some(list) = field.strip_prefix("list:") {
        // Membership of a list (a manual segment), by id or name: `{"field":"list:Webinar","op":"eq","value":true}`.
        qb.push("to_jsonb(EXISTS (SELECT 1 FROM segment_members m JOIN segments s ON s.id = m.segment_id WHERE m.contact_id = c.id AND s.workspace_id = c.workspace_id AND s.filter IS NULL AND (s.id::text = ")
            .push_bind(list.to_owned())
            .push(" OR s.name = ")
            .push_bind(list.to_owned())
            .push(")))");
    } else if let Some(name) = field.strip_prefix("event_count:") {
        qb.push(
            "to_jsonb((SELECT count(*) FROM track_events e WHERE e.contact_id = c.id AND e.name = ",
        )
        .push_bind(name.to_owned())
        .push("))");
    } else if let Some(name) = field.strip_prefix("days_since:") {
        qb.push("to_jsonb((SELECT floor(extract(epoch FROM now() - max(e.received_at)) / 86400)::int FROM track_events e WHERE e.contact_id = c.id AND e.name = ")
            .push_bind(name.to_owned())
            .push("))");
    } else {
        return Err(AutomationError::invalid(format!(
            "segment filter field `{field}` is not supported (use email, first_name, last_name, timezone, created_at, properties.*, topic:*, list:*, event_count:*, days_since:*)"
        )));
    }
    Ok(())
}

fn cmp_sql(qb: &mut QueryBuilder<'_, Postgres>, field: &str, op: Op, value: &Value) -> Result<()> {
    use sqlx::types::Json;
    match op {
        Op::Exists => {
            let want = value.as_bool().unwrap_or(true);
            qb.push("(");
            push_field(qb, field)?;
            qb.push(" IS NOT NULL AND jsonb_typeof(");
            push_field(qb, field)?;
            qb.push(if want {
                ") <> 'null')"
            } else {
                ") <> 'null') IS NOT TRUE"
            });
        }
        Op::Eq => {
            qb.push("(");
            push_field(qb, field)?;
            qb.push(" = ")
                .push_bind(Json(value.clone()))
                .push("::jsonb)");
        }
        Op::Neq => {
            qb.push("(");
            push_field(qb, field)?;
            qb.push(" IS DISTINCT FROM ")
                .push_bind(Json(value.clone()))
                .push("::jsonb)");
        }
        Op::Lt | Op::Lte | Op::Gt | Op::Gte => {
            let sym = match op {
                Op::Lt => "<",
                Op::Lte => "<=",
                Op::Gt => ">",
                _ => ">=",
            };
            match value {
                Value::Number(n) => {
                    qb.push("((CASE WHEN jsonb_typeof(");
                    push_field(qb, field)?;
                    qb.push(") = 'number' THEN (");
                    push_field(qb, field)?;
                    qb.push(format!(")::text::float8 END) {sym} "))
                        .push_bind(n.as_f64().unwrap_or(0.0))
                        .push(")");
                }
                Value::String(s) => {
                    qb.push("((CASE WHEN jsonb_typeof(");
                    push_field(qb, field)?;
                    qb.push(") = 'string' THEN (");
                    push_field(qb, field)?;
                    qb.push(format!(" #>> '{{}}') END) {sym} "))
                        .push_bind(s.clone())
                        .push(")");
                }
                _ => {
                    return Err(AutomationError::invalid(format!(
                        "`{field}`: lt/gt need a number or string value"
                    )))
                }
            }
        }
        Op::In => {
            if !value.is_array() {
                return Err(AutomationError::invalid(format!(
                    "`{field}`: `in` needs an array value"
                )));
            }
            qb.push("(");
            push_field(qb, field)?;
            qb.push(" IN (SELECT jsonb_array_elements(")
                .push_bind(Json(value.clone()))
                .push("::jsonb)))");
        }
        Op::Contains => {
            qb.push("(COALESCE(CASE jsonb_typeof(");
            push_field(qb, field)?;
            qb.push(") WHEN 'array' THEN ");
            push_field(qb, field)?;
            qb.push(" @> jsonb_build_array(")
                .push_bind(Json(value.clone()))
                .push("::jsonb)");
            if let Value::String(s) = value {
                qb.push(" WHEN 'string' THEN strpos(");
                push_field(qb, field)?;
                qb.push(" #>> '{}', ").push_bind(s.clone()).push(") > 0");
            }
            qb.push(" ELSE false END, false))");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(v: Value) -> Rule {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn evaluates() {
        let ctx = json!({"event":{"count":4,"code":"X","tags":["a","b"]},"contact":{"plan":"free"},"event_count:foo":0});
        assert!(r(json!({"field":"event.count","op":"gte","value":2})).eval(&ctx));
        assert!(!r(json!({"field":"event.count","op":"lt","value":4})).eval(&ctx));
        assert!(r(json!({"and":[{"field":"contact.plan","op":"eq","value":"free"},{"not":{"field":"event.zzz","op":"exists"}}]})).eval(&ctx));
        assert!(r(json!({"field":"event.code","op":"in","value":["X","Y"]})).eval(&ctx));
        assert!(r(json!({"field":"event.tags","op":"contains","value":"b"})).eval(&ctx));
        assert!(r(json!({"field":"event_count:foo","op":"eq","value":0})).eval(&ctx));
        assert!(r(json!({"field":"event.missing","op":"neq","value":1})).eval(&ctx));
        assert!(!r(json!({"or":[]})).eval(&ctx) && r(json!({"and":[]})).eval(&ctx));
    }
}
