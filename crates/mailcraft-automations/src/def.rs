//! Automation definitions: the `{key,type,config,next}` step graph stored in
//! `automation_versions.steps`, validation, and install (publish a new version).
use crate::error::{AutomationError, Result};
use crate::policy::parse_duration;
use crate::rules::Rule;
use chrono::Duration;
use mailcraft_core::Stream;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

pub const MAX_WAIT_DAYS: i64 = 30;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TriggerCfg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<String>,
    /// Entry when a contact enters this segment (name or id) instead of on an event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment: Option<String>,
    /// Rule over `event.*` and `contact.*`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Rule>,
}

impl TriggerCfg {
    pub fn event_names(&self) -> Vec<&str> {
        self.event
            .iter()
            .chain(&self.events)
            .map(String::as_str)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConditionCfg {
    pub rule: Rule,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DelayCfg {
    /// `5m`, `2d`, ... max 30d.
    pub duration: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WaitCfg {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Rule>,
    pub timeout: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendMode {
    #[default]
    Static,
    Llm,
}

pub const MAX_STEP_INSTRUCTIONS: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SendCfg {
    /// Template alias or id (alias wins if both could match).
    pub template: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    /// Defaults to the template's stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<Stream>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// Send through this transport instead of the one the `from` address routes to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport_id: Option<Uuid>,
    /// Overrides the template subject.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default)]
    pub mode: SendMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Per-step writing guidance, appended to the workspace's custom instructions (<= 1,000 chars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
    /// Account/transactional-style mail: skips the lifecycle frequency caps (still dedupes by key).
    #[serde(default)]
    pub cap_exempt: bool,
    /// May go Sat/Sun, window 09:00-20:00.
    #[serde(default)]
    pub weekend_ok: bool,
    /// Extra template variables; strings starting with `$` are looked up (`$event.plan`).
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub vars: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateCfg {
    /// `first_name` / `last_name` / `timezone` or a property (`plan` or `properties.plan`).
    /// String values starting with `$` are looked up in the run context.
    pub set: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SegmentCfg {
    /// Segment name or id (a missing name creates a static segment).
    pub segment: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ExitCfg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StepKind {
    Trigger(TriggerCfg),
    Condition(ConditionCfg),
    Delay(DelayCfg),
    WaitForEvent(WaitCfg),
    SendEmail(SendCfg),
    UpdateContact(UpdateCfg),
    AddToSegment(SegmentCfg),
    Exit(ExitCfg),
}

impl StepKind {
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Trigger(_) => "trigger",
            Self::Condition(_) => "condition",
            Self::Delay(_) => "delay",
            Self::WaitForEvent(_) => "wait_for_event",
            Self::SendEmail(_) => "send_email",
            Self::UpdateContact(_) => "update_contact",
            Self::AddToSegment(_) => "add_to_segment",
            Self::Exit(_) => "exit",
        }
    }
}

/// Outgoing edge(s): a step key, or named edges (`true`/`false`, `event`/`timeout`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Next {
    One(String),
    Branch(BTreeMap<String, String>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub key: String,
    pub kind: StepKind,
    pub next: Option<Next>,
}

impl Step {
    /// Edge by name; a plain `next` string answers to any name.
    pub fn edge(&self, name: &str) -> Option<&str> {
        match &self.next {
            Some(Next::One(s)) => Some(s),
            Some(Next::Branch(m)) => m.get(name).map(String::as_str),
            None => None,
        }
    }
    fn targets(&self) -> Vec<&str> {
        match &self.next {
            Some(Next::One(s)) => vec![s],
            Some(Next::Branch(m)) => m.values().map(String::as_str).collect(),
            None => vec![],
        }
    }
}

#[derive(Serialize, Deserialize)]
struct RawStep {
    key: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    config: Value,
    #[serde(default)]
    next: Option<Next>,
}

impl<'de> Deserialize<'de> for Step {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        use serde::de::Error;
        let raw = RawStep::deserialize(d)?;
        let cfg = if raw.config.is_null() {
            json!({})
        } else {
            raw.config
        };
        let e = |x: serde_json::Error| {
            D::Error::custom(format!("step `{}` ({}): {x}", raw.key, raw.ty))
        };
        let kind = match raw.ty.as_str() {
            "trigger" => StepKind::Trigger(serde_json::from_value(cfg).map_err(e)?),
            "condition" => StepKind::Condition(serde_json::from_value(cfg).map_err(e)?),
            "delay" => StepKind::Delay(serde_json::from_value(cfg).map_err(e)?),
            "wait_for_event" => StepKind::WaitForEvent(serde_json::from_value(cfg).map_err(e)?),
            "send_email" => StepKind::SendEmail(serde_json::from_value(cfg).map_err(e)?),
            "update_contact" => StepKind::UpdateContact(serde_json::from_value(cfg).map_err(e)?),
            "add_to_segment" => StepKind::AddToSegment(serde_json::from_value(cfg).map_err(e)?),
            "exit" => StepKind::Exit(serde_json::from_value(cfg).map_err(e)?),
            other => return Err(D::Error::custom(format!("unknown step type `{other}`"))),
        };
        Ok(Step {
            key: raw.key,
            kind,
            next: raw.next,
        })
    }
}

impl Serialize for Step {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let config = match &self.kind {
            StepKind::Trigger(c) => serde_json::to_value(c),
            StepKind::Condition(c) => serde_json::to_value(c),
            StepKind::Delay(c) => serde_json::to_value(c),
            StepKind::WaitForEvent(c) => serde_json::to_value(c),
            StepKind::SendEmail(c) => serde_json::to_value(c),
            StepKind::UpdateContact(c) => serde_json::to_value(c),
            StepKind::AddToSegment(c) => serde_json::to_value(c),
            StepKind::Exit(c) => serde_json::to_value(c),
        }
        .map_err(serde::ser::Error::custom)?;
        RawStep {
            key: self.key.clone(),
            ty: self.kind.type_name().into(),
            config,
            next: self.next.clone(),
        }
        .serialize(s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryRule {
    #[default]
    Once,
    Always,
    AfterDays,
    IfNoActiveRun,
}

impl EntryRule {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::AfterDays => "after_days",
            Self::IfNoActiveRun => "if_no_active_run",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "always" => Self::Always,
            "after_days" => Self::AfterDays,
            "if_no_active_run" => Self::IfNoActiveRun,
            _ => Self::Once,
        }
    }
}

/// Exits the run when one of `events` arrives (and `filter` holds over `event.*`/`contact.*`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Goal {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Rule>,
}

impl Goal {
    pub fn matches(&self, name: &str, ctx: &Value) -> bool {
        (self.event.as_deref() == Some(name) || self.events.iter().any(|e| e == name))
            && self.filter.as_ref().is_none_or(|f| f.eval(ctx))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FrequencyOverride {
    pub min_gap_hours: Option<i64>,
    pub max_per_7d: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PerContactCap {
    pub max: usize,
    pub window_days: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Caps {
    /// Overrides the engine-wide lifecycle frequency caps for this automation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequency: Option<FrequencyOverride>,
    /// At most `max` emails from this automation per contact per window; extra sends are dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_contact: Option<PerContactCap>,
    /// Max emails this automation enqueues per rolling 24h (deferred, not dropped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_sends: Option<i64>,
}

fn default_approval() -> String {
    "first_n:5".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Definition {
    pub name: String,
    /// `draft` (default), `active` or `paused`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default)]
    pub entry_rule: EntryRule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_days: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<Goal>,
    /// `always` | `never` | `first_n:N`
    #[serde(default = "default_approval")]
    pub approval: String,
    #[serde(default)]
    pub caps: Caps,
    pub steps: Vec<Step>,
}

pub fn parse_duration_max(s: &str, what: &str) -> Result<Duration> {
    let d = parse_duration(s).ok_or_else(|| {
        AutomationError::invalid(format!("{what}: `{s}` is not a duration (use 5m, 2d, ...)"))
    })?;
    if d > Duration::days(MAX_WAIT_DAYS) {
        return Err(AutomationError::invalid(format!(
            "{what}: `{s}` exceeds the {MAX_WAIT_DAYS} day maximum"
        )));
    }
    Ok(d)
}

pub fn parse_approval(s: &str) -> Result<Option<i64>> {
    // None = never; Some(n) = the first n sends need approval (always = i64::MAX)
    match s {
        "never" => Ok(None),
        "always" => Ok(Some(i64::MAX)),
        _ => s
            .strip_prefix("first_n:")
            .and_then(|n| n.parse().ok())
            .map(Some)
            .ok_or_else(|| {
                AutomationError::invalid(format!("approval `{s}`: use always | never | first_n:N"))
            }),
    }
}

impl Definition {
    pub fn step(&self, key: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.key == key)
    }

    pub fn trigger(&self) -> Option<(&Step, &TriggerCfg)> {
        self.steps.iter().find_map(|s| match &s.kind {
            StepKind::Trigger(t) => Some((s, t)),
            _ => None,
        })
    }

    /// Value for `automations.trigger_event`.
    pub fn trigger_event(&self) -> String {
        match self.trigger() {
            Some((_, t)) if t.segment.is_some() => "segment.entered".into(),
            Some((_, t)) => t
                .event_names()
                .first()
                .map(|s| s.to_string())
                .unwrap_or_default(),
            None => String::new(),
        }
    }

    /// Structural validation; run on install and by the API before publish.
    pub fn validate(&self) -> Result<()> {
        let bad = |m: String| {
            Err(AutomationError::invalid(format!(
                "automation `{}`: {m}",
                self.name
            )))
        };
        if self.name.trim().is_empty() {
            return Err(AutomationError::invalid("automation name is empty"));
        }
        let triggers = self
            .steps
            .iter()
            .filter(|s| matches!(s.kind, StepKind::Trigger(_)))
            .count();
        if triggers != 1 {
            return bad(format!("needs exactly one trigger step (found {triggers})"));
        }
        let (_, t) = self.trigger().unwrap();
        if t.event_names().is_empty() == t.segment.is_none() {
            return bad("trigger needs either `event`/`events` or `segment`, not both".into());
        }
        let mut keys = HashSet::new();
        for s in &self.steps {
            if !keys.insert(s.key.as_str()) {
                return bad(format!("duplicate step key `{}`", s.key));
            }
        }
        for s in &self.steps {
            for t in s.targets() {
                if !keys.contains(t) {
                    return bad(format!("step `{}` points at unknown step `{t}`", s.key));
                }
            }
            match &s.kind {
                StepKind::Delay(d) => {
                    parse_duration_max(&d.duration, &format!("step `{}`", s.key))?;
                }
                StepKind::WaitForEvent(w) => {
                    parse_duration_max(&w.timeout, &format!("step `{}`", s.key))?;
                    if !matches!(&s.next, Some(Next::Branch(m)) if m.contains_key("event") || m.contains_key("timeout"))
                    {
                        return bad(format!(
                            "wait_for_event `{}` needs next {{event, timeout}} edges",
                            s.key
                        ));
                    }
                }
                StepKind::SendEmail(c) if c.custom_instructions.is_some() => {
                    let ci = c.custom_instructions.as_deref().unwrap_or_default();
                    if c.mode != SendMode::Llm {
                        return bad(format!(
                            "step `{}`: custom_instructions only applies to `mode: llm` sends",
                            s.key
                        ));
                    }
                    if ci.trim().chars().count() > MAX_STEP_INSTRUCTIONS {
                        return bad(format!(
                            "step `{}`: custom_instructions is over {MAX_STEP_INSTRUCTIONS} characters",
                            s.key
                        ));
                    }
                }
                StepKind::Condition(_) if !matches!(&s.next, Some(Next::Branch(_))) => {
                    return bad(format!(
                        "condition `{}` needs next {{true, false}} edges",
                        s.key
                    ));
                }
                StepKind::Exit(_) if s.next.is_some() => {
                    return bad(format!("exit `{}` cannot have next", s.key))
                }
                _ => {}
            }
        }
        parse_approval(&self.approval)?;
        if self.entry_rule == EntryRule::AfterDays && self.entry_days.unwrap_or(0) <= 0 {
            return bad("entry_rule after_days needs entry_days > 0".into());
        }
        // no cycles: a loop could mail a contact forever
        let by_key: HashMap<&str, &Step> = self.steps.iter().map(|s| (s.key.as_str(), s)).collect();
        fn visit<'a>(
            k: &'a str,
            by: &HashMap<&'a str, &'a Step>,
            stack: &mut Vec<&'a str>,
            done: &mut HashSet<&'a str>,
        ) -> bool {
            if stack.contains(&k) {
                return true;
            }
            if !done.insert(k) {
                return false;
            }
            stack.push(k);
            let cyc = by[k]
                .targets()
                .into_iter()
                .any(|t| visit(t, by, stack, done));
            stack.pop();
            cyc
        }
        if visit(
            &self
                .steps
                .iter()
                .find(|s| matches!(s.kind, StepKind::Trigger(_)))
                .unwrap()
                .key,
            &by_key,
            &mut vec![],
            &mut HashSet::new(),
        ) {
            return bad("step graph has a cycle".into());
        }
        Ok(())
    }
}

/// Create or update (new version) an automation by name. Returns `(automation_id, version)`.
/// Refuses `mode: llm` sends whose template has a slot without fallback copy (SPEC 10.1.5).
pub async fn install(pool: &PgPool, workspace_id: Uuid, def: &Definition) -> Result<(Uuid, i32)> {
    def.validate()?;
    for s in &def.steps {
        if let StepKind::SendEmail(c) = &s.kind {
            let doc: Option<Value> = sqlx::query_scalar(
                "SELECT v.doc FROM templates t JOIN template_versions v ON v.id = t.current_version_id WHERE t.workspace_id = $1 AND (t.alias = $2 OR t.id::text = $2) ORDER BY (t.alias = $2) DESC LIMIT 1",
            )
            .bind(workspace_id)
            .bind(&c.template)
            .fetch_optional(pool)
            .await?;
            let Some(doc) = doc else {
                return Err(AutomationError::invalid(format!(
                    "step `{}`: template `{}` does not exist or has no published version",
                    s.key, c.template
                )));
            };
            if c.mode == SendMode::Llm {
                let t = mailcraft_templates::Template::from_json(&doc.to_string())?;
                for slot in t.slots() {
                    if let mailcraft_templates::Block::Slot { name, fallback, .. } = slot {
                        if fallback.as_deref().is_none_or(|f| f.trim().is_empty()) {
                            return Err(AutomationError::invalid(format!(
                                "step `{}`: llm send needs fallback copy for slot `{name}` in template `{}`",
                                s.key, c.template
                            )));
                        }
                    }
                }
            }
        }
    }
    let mut tx = pool.begin().await?;
    let status = def.status.as_deref().unwrap_or("draft");
    let (id, version): (Uuid, i32) = sqlx::query_as(
        "INSERT INTO automations (workspace_id, name, status, trigger_event, entry_rule, entry_days, goal, approval, caps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_id, name) DO UPDATE SET
           trigger_event = $4, entry_rule = $5, entry_days = $6, goal = $7, approval = $8, caps = $9,
           current_version = automations.current_version + 1
         RETURNING id, current_version",
    )
    .bind(workspace_id)
    .bind(&def.name)
    .bind(status)
    .bind(def.trigger_event())
    .bind(def.entry_rule.as_str())
    .bind(def.entry_days)
    .bind(def.goal.as_ref().map(sqlx::types::Json))
    .bind(&def.approval)
    .bind(sqlx::types::Json(&def.caps))
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO automation_versions (automation_id, version, steps, published_at) VALUES ($1,$2,$3,now())")
        .bind(id)
        .bind(version)
        .bind(sqlx::types::Json(&def.steps))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((id, version))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(steps: Value) -> Result<Definition> {
        let d: Definition = serde_json::from_value(json!({"name":"t","steps":steps}))
            .map_err(|e| AutomationError::invalid(e.to_string()))?;
        d.validate().map(|_| d)
    }

    #[test]
    fn validates_graph() {
        let ok = def(json!([
            {"key":"t","type":"trigger","config":{"event":"signed_up"},"next":"d"},
            {"key":"d","type":"delay","config":{"duration":"5m"},"next":"x"},
            {"key":"x","type":"exit"}
        ]))
        .unwrap();
        assert_eq!(ok.trigger_event(), "signed_up");
        let round: Vec<Step> =
            serde_json::from_value(serde_json::to_value(&ok.steps).unwrap()).unwrap();
        assert_eq!(round, ok.steps);
        for (steps, why) in [
            (
                json!([{"key":"t","type":"trigger","config":{"event":"a"},"next":"zzz"}]),
                "unknown step",
            ),
            (
                json!([{"key":"t","type":"trigger","config":{"event":"a"},"next":"d"},{"key":"d","type":"delay","config":{"duration":"31d"}}]),
                "maximum",
            ),
            (
                json!([{"key":"t","type":"trigger","config":{"event":"a"},"next":"d"},{"key":"d","type":"delay","config":{"duration":"1m"},"next":"d"}]),
                "cycle",
            ),
            (json!([{"key":"t","type":"trigger","config":{}}]), "either"),
            (
                json!([{"key":"t","type":"trigger","config":{"event":"a"},"next":"w"},{"key":"w","type":"wait_for_event","config":{"event":"b","timeout":"1d"},"next":"t2"}]),
                "unknown step",
            ),
        ] {
            let e = def(steps).unwrap_err().to_string();
            assert!(e.contains(why), "{e} should contain {why}");
        }
    }

    #[test]
    fn step_custom_instructions_validated() {
        let send = |mode: &str, ci: String| {
            def(json!([
                {"key":"t","type":"trigger","config":{"event":"a"},"next":"s"},
                {"key":"s","type":"send_email","config":{"template":"w","mode":mode,"custom_instructions":ci}}
            ]))
        };
        assert!(send("llm", "x".repeat(1_000)).is_ok());
        let e = send("llm", "x".repeat(1_001)).unwrap_err().to_string();
        assert!(
            e.contains("1000 characters") || e.contains("1_000") || e.contains("over 1000"),
            "{e}"
        );
        let e = send("static", "be brief".into()).unwrap_err().to_string();
        assert!(e.contains("mode: llm"), "{e}");
    }
}
