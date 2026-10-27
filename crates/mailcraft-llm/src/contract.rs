//! Generation contract: the model fills named slots only. Links, footer and
//! unsubscribe belong to the template.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Slots {
    pub subject: String,
    pub preheader: String,
    pub greeting: String,
    pub body_paragraphs: Vec<String>,
    pub cta_label: String,
}

impl Slots {
    /// (slot name, text) for every text field, for validators.
    pub fn texts(&self) -> Vec<(String, &str)> {
        let mut v = vec![
            ("subject".to_string(), self.subject.as_str()),
            ("preheader".into(), self.preheader.as_str()),
            ("greeting".into(), self.greeting.as_str()),
            ("cta_label".into(), self.cta_label.as_str()),
        ];
        v.extend(
            self.body_paragraphs
                .iter()
                .enumerate()
                .map(|(i, p)| (format!("body_paragraphs[{i}]"), p.as_str())),
        );
        v
    }

    /// JSON Schema sent as the strict structured-output format.
    pub fn json_schema() -> serde_json::Value {
        json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["subject", "preheader", "greeting", "body_paragraphs", "cta_label"],
                "properties": {
                    "subject": {"type": "string", "description": "Plain text, <= 60 chars"},
                    "preheader": {"type": "string", "description": "Plain text preview line"},
                    "greeting": {"type": "string", "description": "e.g. 'Hi Ana,'"},
                    "body_paragraphs": {"type": "array", "maxItems": 3, "items": {"type": "string"},
                        "description": "Plain text paragraphs, <= 120 words total"},
                    "cta_label": {"type": "string", "description": "Button/link label; the URL is added by the template"}
                }
        })
    }
}

/// Template-owned parts. The model never sees or writes these.
#[derive(Debug, Clone)]
pub struct EmailTemplate {
    pub cta_url: String,
    pub signature: String,
    pub footer: String,
    pub unsubscribe_url: String,
}

impl EmailTemplate {
    /// Plain-text render (journeys.md 4.1: plain text).
    pub fn render_text(&self, s: &Slots) -> String {
        format!(
            "{}\n\n{}\n\n{}: {}\n\n{}\n\n--\n{}\nUnsubscribe: {}\n",
            s.greeting,
            s.body_paragraphs.join("\n\n"),
            s.cta_label,
            self.cta_url,
            self.signature,
            self.footer,
            self.unsubscribe_url
        )
    }
}

/// A template-declared slot (the dynamic contract). `subject` and `preheader` are always
/// generated and need no spec.
#[derive(Debug, Clone, PartialEq)]
pub struct SlotSpec {
    pub name: String,
    pub max_len: Option<usize>,
    pub instructions: Option<String>,
    pub fallback: Option<String>,
}

/// Declared slots minus the always-present subject/preheader, first occurrence of a name wins.
pub fn declared(specs: &[SlotSpec]) -> Vec<&SlotSpec> {
    let mut out: Vec<&SlotSpec> = vec![];
    for s in specs {
        if s.name != "subject" && s.name != "preheader" && !out.iter().any(|o| o.name == s.name) {
            out.push(s);
        }
    }
    out
}

fn desc(s: &SlotSpec) -> String {
    let mut d = s.instructions.clone().unwrap_or_default();
    if let Some(m) = s.max_len {
        d.push_str(&format!(" Max {m} characters."));
    }
    d.trim().to_string()
}

/// Strict JSON Schema with exactly subject, preheader and the declared slots, all plain strings.
pub fn dynamic_schema(specs: &[SlotSpec]) -> serde_json::Value {
    let mut props = serde_json::Map::new();
    props.insert(
        "subject".into(),
        json!({"type": "string", "description": "Plain text, <= 60 chars"}),
    );
    props.insert(
        "preheader".into(),
        json!({"type": "string", "description": "Plain text preview line, <= 110 chars"}),
    );
    for s in declared(specs) {
        props.insert(
            s.name.clone(),
            json!({"type": "string", "description": desc(s)}),
        );
    }
    let required: Vec<&String> = props.keys().collect();
    json!({"type": "object", "additionalProperties": false, "required": required, "properties": props})
}

/// Prompt section naming every key and what it holds.
pub fn dynamic_prompt(specs: &[SlotSpec]) -> String {
    let mut p = String::from(
        "SLOTS: return JSON with exactly these keys, each a plain-text string:\n- subject (max 60 characters)\n- preheader (max 110 characters)",
    );
    for s in declared(specs) {
        let mut line = format!("\n- {}", s.name);
        if let Some(m) = s.max_len {
            line.push_str(&format!(" (max {m} characters)"));
        }
        if let Some(i) = s.instructions.as_deref().filter(|i| !i.trim().is_empty()) {
            line.push_str(&format!(": {}", i.trim()));
        }
        p.push_str(&line);
    }
    p
}

/// Rule override appended to the system prompt in dynamic mode: the base rules name the legacy slots.
pub const DYNAMIC_SYSTEM_NOTE: &str = "Fill exactly the keys listed under SLOTS in the user message. The rules above about greeting, body and cta_label apply to the listed slots that play those roles; ignore slots that are not listed.";

impl Slots {
    /// Spam-scoring view of a dynamic result: declared slots other than greeting/cta_label become body paragraphs.
    pub fn from_values(values: &BTreeMap<String, String>, specs: &[SlotSpec]) -> Self {
        let get = |k: &str| values.get(k).cloned().unwrap_or_default();
        Self {
            subject: get("subject"),
            preheader: get("preheader"),
            greeting: get("greeting"),
            body_paragraphs: declared(specs)
                .iter()
                .filter(|s| s.name != "greeting" && s.name != "cta_label")
                .map(|s| get(&s.name))
                .collect(),
            cta_label: get("cta_label"),
        }
    }
}
