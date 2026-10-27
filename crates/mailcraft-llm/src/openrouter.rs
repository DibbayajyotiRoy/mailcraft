use async_trait::async_trait;
use mailcraft_core::llm::{GenerateRequest, GenerateResult, LlmError, LlmProvider};
use serde_json::{json, Value};

/// OpenRouter via OpenAI-compatible chat completions (architecture.md 4.1).
/// `base_url` is configurable so the same code later serves OpenAI/Ollama.
pub struct OpenRouter {
    pub base_url: String,
    pub api_key: String,
    pub http: reqwest::Client,
}

impl OpenRouter {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            base_url: "https://openrouter.ai/api/v1".into(),
            api_key: api_key.into(),
            http: reqwest::Client::new(),
        }
    }

    /// Request body. `provider.require_parameters` makes OpenRouter route only to
    /// endpoints that honour `response_format` (structured output is per endpoint).
    pub fn request_body(req: &GenerateRequest) -> Value {
        let mut body = json!({
            "model": req.model,
            "messages": req.messages,
            "max_tokens": req.max_tokens,
            "provider": { "require_parameters": true },
        });
        if !req.fallbacks.is_empty() {
            body["models"] = json!(req.fallbacks);
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        if let Some(schema) = &req.json_schema {
            body["response_format"] = json!({
                "type": "json_schema",
                "json_schema": { "name": "email_slots", "strict": true, "schema": schema }
            });
        }
        body
    }
}

#[async_trait]
impl LlmProvider for OpenRouter {
    fn id(&self) -> &'static str {
        "openrouter"
    }
    async fn generate(&self, _req: GenerateRequest) -> Result<GenerateResult, LlmError> {
        // Stub: HTTP call + error normalisation land in the llm work package.
        let _ = (&self.http, &self.base_url, &self.api_key);
        Err(LlmError::NotImplemented)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailcraft_core::llm::Msg;

    #[test]
    fn body_requires_parameters_and_strict_schema() {
        let req = GenerateRequest {
            model: "deepseek/deepseek-v4-flash".into(),
            fallbacks: vec![],
            messages: vec![Msg {
                role: "user".into(),
                content: "hi".into(),
            }],
            json_schema: Some(json!({"type":"object"})),
            max_tokens: 400,
            temperature: None,
        };
        let b = OpenRouter::request_body(&req);
        assert_eq!(b["provider"]["require_parameters"], true);
        assert_eq!(b["response_format"]["json_schema"]["strict"], true);
    }
}
