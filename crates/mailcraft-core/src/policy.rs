//! Per-key policy lookup (SPEC 4.5): `{"send": "auto|needs_approval|blocked"}`.
use serde_json::Value;

use crate::Policy;

pub const ACTIONS: [&str; 1] = ["send"];

/// Unset action -> `Auto`. A malformed value fails closed to `NeedsApproval`.
pub fn for_action(policy: &Value, action: &str) -> Policy {
    match policy.get(action) {
        None | Some(Value::Null) => Policy::Auto,
        Some(v) => serde_json::from_value(v.clone()).unwrap_or(Policy::NeedsApproval),
    }
}

/// Validates a policy map supplied by a client.
pub fn validate(policy: &Value) -> Result<(), String> {
    let m = policy.as_object().ok_or("policy must be an object")?;
    for (k, v) in m {
        if !ACTIONS.contains(&k.as_str()) {
            return Err(format!(
                "unknown policy action `{k}` (known: {})",
                ACTIONS.join(", ")
            ));
        }
        if serde_json::from_value::<Policy>(v.clone()).is_err() {
            return Err(format!(
                "policy.{k} must be auto, needs_approval or blocked"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lookup_defaults_and_fails_closed() {
        assert_eq!(for_action(&json!({}), "send"), Policy::Auto);
        assert_eq!(
            for_action(&json!({"send":"blocked"}), "send"),
            Policy::Blocked
        );
        assert_eq!(
            for_action(&json!({"send":"wat"}), "send"),
            Policy::NeedsApproval
        );
        assert!(validate(&json!({"send":"auto"})).is_ok());
        assert!(validate(&json!({"nope":"auto"})).is_err());
        assert!(validate(&json!({"send":"x"})).is_err());
    }
}
