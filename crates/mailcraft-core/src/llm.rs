use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Msg {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct GenerateRequest {
    pub model: String,
    pub fallbacks: Vec<String>,
    pub messages: Vec<Msg>,
    /// JSON Schema for structured output. LLM output is data, never raw HTML (SPEC 10).
    pub json_schema: Option<serde_json::Value>,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct GenerateResult {
    pub json: serde_json::Value,
    pub usage: Usage,
    pub cost_usd: Option<f64>,
    pub model: String,
    pub request_id: Option<String>,
}

/// Provider-independent failure set so retry policy does not depend on the vendor.
#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("rate limited (retry after {0:?}s)")]
    RateLimited(Option<u64>),
    #[error("quota exceeded")]
    QuotaExceeded,
    #[error("invalid schema: {0}")]
    InvalidSchema(String),
    #[error("content filtered")]
    ContentFiltered,
    #[error("transient: {0}")]
    Transient(String),
    #[error("fatal: {0}")]
    Fatal(String),
    #[error("not implemented")]
    NotImplemented,
}

/// Content-generation plugin. First implementation: OpenRouter.
#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn id(&self) -> &'static str;
    async fn generate(&self, req: GenerateRequest) -> Result<GenerateResult, LlmError>;
}
