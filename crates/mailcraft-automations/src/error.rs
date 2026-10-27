use thiserror::Error;

pub type Result<T> = std::result::Result<T, AutomationError>;

#[derive(Debug, Error)]
pub enum AutomationError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("invalid: {0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("template: {0}")]
    Template(#[from] mailcraft_templates::RenderError),
}

impl AutomationError {
    pub fn invalid(m: impl Into<String>) -> Self {
        Self::Invalid(m.into())
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::NotFound(m.into())
    }
}

impl From<AutomationError> for mailcraft_core::Error {
    fn from(e: AutomationError) -> Self {
        use mailcraft_core::Error as E;
        match e {
            AutomationError::Db(e) => E::new("internal", 500, e.to_string()).retryable(),
            AutomationError::Invalid(m) => E::new("invalid_request", 422, m),
            AutomationError::NotFound(m) => E::new("not_found", 404, m),
            AutomationError::Template(e) => E::new("template_render_failed", 422, e.to_string()),
        }
    }
}
