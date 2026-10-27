//! OpenAI-compatible chat-completions provider (OpenRouter default, OpenAI, Ollama),
//! implementing `mailcraft_core::llm::LlmProvider`.
use async_trait::async_trait;
use mailcraft_core::llm::{GenerateRequest, GenerateResult, LlmError, LlmProvider, Usage};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct OpenAiCompatConfig {
    /// Value returned by `LlmProvider::id`.
    pub id: &'static str,
    pub base_url: String,
    pub api_key: Option<String>,
    pub extra_headers: Vec<(String, String)>,
    /// OpenRouter-only: sends `provider: {require_parameters: true}` and `models` fallbacks.
    pub require_parameters: bool,
    /// OpenRouter `reasoning` object (`{"enabled":false}` or `{"effort":"low"}`); omitted when None.
    pub reasoning: Option<Value>,
    /// OpenRouter-only: models tried after the request's own (MAILCRAFT_LLM_FALLBACK_MODELS).
    /// Also the next model to retry with when a completion comes back empty.
    pub fallback_models: Vec<String>,
    pub timeout: Duration,
    pub max_retries: u32,
    pub backoff_base: Duration,
}

// Manual Debug: the API key must never reach logs.
impl std::fmt::Debug for OpenAiCompatConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiCompatConfig")
            .field("id", &self.id)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("require_parameters", &self.require_parameters)
            .finish_non_exhaustive()
    }
}

impl OpenAiCompatConfig {
    fn base(id: &'static str, url: &str, key: Option<String>) -> Self {
        Self {
            id,
            base_url: url.trim_end_matches('/').into(),
            api_key: key,
            extra_headers: vec![],
            require_parameters: false,
            reasoning: None,
            fallback_models: vec![],
            timeout: Duration::from_secs(60),
            max_retries: 3,
            backoff_base: Duration::from_millis(500),
        }
    }
    pub fn openrouter(key: impl Into<String>, referer: &str, title: &str) -> Self {
        let mut c = Self::base(
            "openrouter",
            "https://openrouter.ai/api/v1",
            Some(key.into()),
        );
        c.require_parameters = true;
        c.extra_headers = vec![
            ("HTTP-Referer".into(), referer.into()),
            ("X-Title".into(), title.into()),
        ];
        c
    }
    pub fn openai(key: impl Into<String>) -> Self {
        Self::base("openai", "https://api.openai.com/v1", Some(key.into()))
    }
    pub fn ollama() -> Self {
        let mut c = Self::base("ollama", "http://localhost:11434/v1", None);
        c.timeout = Duration::from_secs(180); // local models are slow
        c
    }
    pub fn with_base_url(mut self, url: &str) -> Self {
        self.base_url = url.trim_end_matches('/').into();
        self
    }
}

pub struct OpenAiCompat {
    cfg: OpenAiCompatConfig,
    http: reqwest::Client,
}

const EMPTY: &str = "empty completion";

fn strip_fences(s: &str) -> &str {
    let t = s.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim()
}

impl OpenAiCompat {
    pub fn new(cfg: OpenAiCompatConfig) -> Result<Self, LlmError> {
        let http = reqwest::Client::builder()
            .timeout(cfg.timeout)
            .build()
            .map_err(|e| LlmError::Fatal(e.to_string()))?;
        Ok(Self { cfg, http })
    }

    pub fn build_body(&self, r: &GenerateRequest) -> Value {
        let mut b = json!({"model": r.model, "messages": r.messages, "max_tokens": r.max_tokens});
        if let Some(t) = r.temperature {
            b["temperature"] = json!(t);
        }
        if let Some(s) = &r.json_schema {
            b["response_format"] = json!({"type": "json_schema",
                "json_schema": {"name": "email_slots", "strict": true, "schema": s}});
        }
        if let Some(r) = &self.cfg.reasoning {
            b["reasoning"] = r.clone();
        }
        if self.cfg.require_parameters {
            b["provider"] = json!({"require_parameters": true});
            if !r.fallbacks.is_empty() {
                b["models"] = json!(r.fallbacks);
            }
        }
        b
    }

    /// `GenerateResult.json` is the parsed completion; when the text is not valid JSON it is
    /// returned as `Value::String(raw)` so the caller can still audit and repair it.
    fn parse(v: &Value) -> Result<GenerateResult, LlmError> {
        let text = v["choices"][0]["message"]["content"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| LlmError::Transient(EMPTY.into()))?;
        let json = serde_json::from_str(strip_fences(text))
            .unwrap_or_else(|_| Value::String(text.to_string()));
        let u = &v["usage"];
        let n = |k: &str| u[k].as_u64().unwrap_or(0) as u32;
        Ok(GenerateResult {
            json,
            usage: Usage {
                prompt_tokens: n("prompt_tokens"),
                completion_tokens: n("completion_tokens"),
            },
            cost_usd: u["cost"].as_f64(),
            model: v["model"].as_str().unwrap_or_default().to_string(),
            request_id: v["id"].as_str().map(Into::into),
        })
    }
}

fn map_status(status: u16, retry_after: Option<u64>, body: &str) -> LlmError {
    let b: String = body.chars().take(300).collect();
    match status {
        429 => LlmError::RateLimited(retry_after),
        402 => LlmError::QuotaExceeded,
        400 | 422 if b.contains("schema") || b.contains("response_format") => {
            LlmError::InvalidSchema(b)
        }
        s if s >= 500 => LlmError::Transient(format!("http {s}: {b}")),
        s => LlmError::Fatal(format!("http {s}: {b}")),
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompat {
    fn id(&self) -> &'static str {
        self.cfg.id
    }

    async fn generate(&self, mut request: GenerateRequest) -> Result<GenerateResult, LlmError> {
        if request.fallbacks.is_empty() {
            request.fallbacks = self.cfg.fallback_models.clone();
        }
        let url = format!("{}/chat/completions", self.cfg.base_url);
        let mut attempt = 0u32;
        loop {
            let body = self.build_body(&request);
            let mut rb = self.http.post(&url).json(&body);
            if let Some(k) = &self.cfg.api_key {
                rb = rb.bearer_auth(k);
            }
            for (k, v) in &self.cfg.extra_headers {
                rb = rb.header(k, v);
            }
            let mut wait = self.cfg.backoff_base * 2u32.pow(attempt);
            let err = match rb.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let retry_after = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|h| h.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok());
                    if let Some(s) = retry_after {
                        wait = Duration::from_secs(s.min(30));
                    }
                    let text = resp
                        .text()
                        .await
                        .map_err(|e| LlmError::Transient(e.to_string()))?;
                    if status.is_success() {
                        let v: Value = serde_json::from_str(&text)
                            .map_err(|e| LlmError::Transient(format!("decode: {e}")))?;
                        match Self::parse(&v) {
                            // Free models sometimes return 200 with no text, and OpenRouter's own
                            // `models` fallback does not fire for that: retry on the next model.
                            Err(LlmError::Transient(m))
                                if m == EMPTY && !request.fallbacks.is_empty() =>
                            {
                                request.model = request.fallbacks.remove(0);
                                LlmError::Transient(m)
                            }
                            r => return r,
                        }
                    } else {
                        map_status(status.as_u16(), retry_after, &text)
                    }
                }
                Err(e) => LlmError::Transient(e.to_string()),
            };
            if !matches!(err, LlmError::RateLimited(_) | LlmError::Transient(_))
                || attempt >= self.cfg.max_retries
            {
                return Err(err);
            }
            attempt += 1;
            tokio::time::sleep(wait).await;
        }
    }
}
