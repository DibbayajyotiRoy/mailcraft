//! Canonical template: JSON block tree -> MJML (deterministic) -> minijinja vars -> mrml -> HTML + text.
//! SPEC section 11. Order: variables are rendered on the MJML string, then compiled.
//!
//! * `render` / `render_subject`: block tree to HTML + plain text (footer owned by the renderer).
//! * `import_*` / `export_*`: HTML, MJML, React Email (rendered HTML) and canonical JSON.
//! * `lint` / `preview`: checks and sample-data previews.

mod import;
mod lint;
mod mjml_parse;
mod render;
mod text;

pub use import::{
    import_html, import_json, import_mjml, import_react_email, Imported, SourceFormat,
};
pub use lint::{lint, preview, LintIssue, Preview, Severity, GMAIL_CLIP_BYTES};
pub use mailcraft_core::Stream;
pub use render::{
    export_html, export_json, export_mjml, json_schema, render, render_html, render_subject,
    to_mjml, variables, Footer, RenderOptions, Rendered, RESERVED_VARS,
};
pub use text::html_to_text;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("variable render failed: {0}")]
    Vars(String),
    #[error("mjml compile failed: {0}")]
    Mjml(String),
    #[error("slot `{0}`: {1}")]
    Slot(String, String),
    #[error("footer: {0}")]
    Footer(String),
    #[error("invalid template: {0}")]
    Invalid(String),
}

/// One block of the canonical tree. `footer` is deliberately not a block: the renderer owns it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Heading {
        text: String,
    },
    #[serde(alias = "text")]
    Paragraph {
        text: String,
    },
    Button {
        label: String,
        url: String,
    },
    Image {
        src: String,
        #[serde(default)]
        alt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        href: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width: Option<String>,
    },
    Divider,
    Spacer {
        #[serde(default = "default_spacer")]
        height: String,
    },
    /// Side by side columns; each column is a list of blocks (no nesting of `columns`).
    Columns {
        columns: Vec<Vec<Block>>,
    },
    /// Raw HTML (placed in the body as-is). A lone full-document raw_html bypasses MJML.
    RawHtml {
        html: String,
    },
    /// Raw MJML. A fragment starting with `<mj-section|wrapper|hero>` is placed at body level,
    /// anything else inside the current column.
    RawMjml {
        mjml: String,
    },
    /// Text filled by the LLM (or `fallback`); the model never writes markup or links.
    Slot {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_len: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback: Option<String>,
    },
}

fn default_spacer() -> String {
    "20px".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    pub version: u32,
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preheader: Option<String>,
    /// Preserved `<mj-head>` content (styles, fonts, attributes) from an MJML import.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub blocks: Vec<Block>,
}

impl Template {
    pub fn new(subject: impl Into<String>, blocks: Vec<Block>) -> Self {
        Self {
            version: SCHEMA_VERSION,
            subject: subject.into(),
            preheader: None,
            head: None,
            blocks,
        }
    }

    /// Slots declared by the template: (name, max_len, instructions, fallback).
    pub fn slots(&self) -> Vec<&Block> {
        fn walk<'a>(bs: &'a [Block], out: &mut Vec<&'a Block>) {
            for b in bs {
                match b {
                    Block::Slot { .. } => out.push(b),
                    Block::Columns { columns } => columns.iter().for_each(|c| walk(c, out)),
                    _ => {}
                }
            }
        }
        let mut out = vec![];
        walk(&self.blocks, &mut out);
        out
    }

    pub fn from_json(src: &str) -> Result<Self, RenderError> {
        let t: Template =
            serde_json::from_str(src).map_err(|e| RenderError::Invalid(e.to_string()))?;
        t.check_version()?;
        Ok(t)
    }

    pub fn check_version(&self) -> Result<(), RenderError> {
        if self.version != SCHEMA_VERSION {
            return Err(RenderError::Invalid(format!(
                "unsupported template version {} (supported: {SCHEMA_VERSION})",
                self.version
            )));
        }
        Ok(())
    }
}
