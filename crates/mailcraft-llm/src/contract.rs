//! Generation contract: the model fills named slots only. Links, footer and
//! unsubscribe belong to the template.
use serde::{Deserialize, Serialize};
use serde_json::json;

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
