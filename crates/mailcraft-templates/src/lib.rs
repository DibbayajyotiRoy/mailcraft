//! Canonical template: JSON block tree -> MJML (deterministic) -> minijinja vars -> mrml -> HTML.
//! SPEC section 11. Order: variables are rendered on the MJML string, then compiled.
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("variable render failed: {0}")]
    Vars(String),
    #[error("mjml compile failed: {0}")]
    Mjml(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Heading { text: String },
    Paragraph { text: String },
    Button { label: String, url: String },
    Divider,
    RawMjml { mjml: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub version: u32,
    pub subject: String,
    pub blocks: Vec<Block>,
}

fn esc(s: &str) -> String {
    // Escape only literal text. `{{ var }}` is left for minijinja, which autoescapes values.
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Deterministic block tree -> MJML.
pub fn to_mjml(t: &Template) -> String {
    let mut body = String::new();
    for b in &t.blocks {
        match b {
            Block::Heading { text } => body.push_str(&format!(
                "<mj-text font-size=\"22px\" font-weight=\"bold\">{}</mj-text>",
                esc(text)
            )),
            Block::Paragraph { text } => {
                body.push_str(&format!("<mj-text>{}</mj-text>", esc(text)))
            }
            Block::Button { label, url } => body.push_str(&format!(
                "<mj-button href=\"{}\">{}</mj-button>",
                esc(url),
                esc(label)
            )),
            Block::Divider => body.push_str("<mj-divider />"),
            Block::RawMjml { mjml } => body.push_str(mjml),
        }
    }
    format!(
        "<mjml><mj-body><mj-section><mj-column>{body}</mj-column></mj-section></mj-body></mjml>"
    )
}

/// Render with variables. Undefined variables are an error (strict), never "Hi null".
pub fn render_html(t: &Template, vars: &serde_json::Value) -> Result<String, RenderError> {
    let mut env = minijinja::Environment::new();
    env.set_undefined_behavior(minijinja::UndefinedBehavior::Strict);
    let mjml = env
        .render_str(&to_mjml(t), vars)
        .map_err(|e| RenderError::Vars(e.to_string()))?;
    let parsed = mrml::parse(&mjml).map_err(|e| RenderError::Mjml(e.to_string()))?;
    parsed
        .element
        .render(&mrml::prelude::render::RenderOptions::default())
        .map_err(|e| RenderError::Mjml(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tpl() -> Template {
        Template {
            version: 1,
            subject: "Welcome".into(),
            blocks: vec![
                Block::Heading {
                    text: "Hi {{ first_name }}".into(),
                },
                Block::Paragraph {
                    text: "Thanks for joining.".into(),
                },
                Block::Button {
                    label: "Open app".into(),
                    url: "{{ app_url }}".into(),
                },
            ],
        }
    }

    #[test]
    fn renders_variables_into_html() {
        let html = render_html(
            &tpl(),
            &json!({"first_name":"Ana","app_url":"https://app.example.com"}),
        )
        .unwrap();
        assert!(html.contains("Hi Ana"));
        assert!(html.contains("https://app.example.com"));
    }

    #[test]
    fn missing_variable_is_an_error() {
        assert!(render_html(&tpl(), &json!({"first_name":"Ana"})).is_err());
    }
}
