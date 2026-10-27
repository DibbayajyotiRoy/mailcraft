use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

/// Structured error shared by REST, CLI and MCP (agent-native.md section 2, item 9).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct Error {
    pub code: &'static str,
    pub message: String,
    pub field: Option<String>,
    pub hint: Option<String>,
    pub retryable: bool,
    pub status: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    pub doc_url: String,
    pub retryable: bool,
}

impl Error {
    pub fn new(code: &'static str, status: u16, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            field: None,
            hint: None,
            retryable: false,
            status,
        }
    }
    pub fn hint(mut self, h: impl Into<String>) -> Self {
        self.hint = Some(h.into());
        self
    }
    pub fn field(mut self, f: impl Into<String>) -> Self {
        self.field = Some(f.into());
        self
    }
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
    pub fn not_implemented(what: &str) -> Self {
        Self::new(
            "not_implemented",
            501,
            format!("{what} is not implemented yet"),
        )
        .hint("mailcraft is pre-alpha; see SPEC.md section 17 for the MVP scope")
    }
    pub fn body(&self) -> ErrorBody {
        ErrorBody {
            code: self.code.into(),
            message: self.message.clone(),
            field: self.field.clone(),
            hint: self.hint.clone(),
            doc_url: format!("https://mailcraft.dev/errors/{}.md", self.code),
            retryable: self.retryable,
        }
    }
}
