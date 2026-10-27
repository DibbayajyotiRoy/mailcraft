//! Provider config from env: MAILCRAFT_LLM_PROVIDER (openrouter|openai|ollama, default openrouter),
//! MAILCRAFT_LLM_BASE_URL, MAILCRAFT_LLM_MODEL, OPENROUTER_API_KEY (OPENAI_API_KEY for openai).
//! The key is never logged: `Debug` of this type and of `OpenAiCompatConfig` redact it.
use crate::provider::{OpenAiCompat, OpenAiCompatConfig};
use mailcraft_core::llm::LlmError;

pub const DEFAULT_MODEL: &str = "deepseek/deepseek-v4-flash";

pub struct LlmSettings {
    pub provider: OpenAiCompatConfig,
    pub model: String,
}

impl std::fmt::Debug for LlmSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "LlmSettings {{ provider: {:?}, model: {:?} }}",
            self.provider, self.model
        )
    }
}

impl LlmSettings {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let need = |k: &str| get(k).ok_or_else(|| format!("{k} is required"));
        let mut provider = match get("MAILCRAFT_LLM_PROVIDER")
            .unwrap_or_else(|| "openrouter".into())
            .as_str()
        {
            "openrouter" => OpenAiCompatConfig::openrouter(
                need("OPENROUTER_API_KEY")?,
                "https://github.com/DibbayajyotiRoy/mailcraft",
                "mailcraft",
            ),
            "openai" => OpenAiCompatConfig::openai(need("OPENAI_API_KEY")?),
            "ollama" => OpenAiCompatConfig::ollama(),
            other => {
                return Err(format!(
                    "unknown MAILCRAFT_LLM_PROVIDER {other:?} (openrouter|openai|ollama)"
                ))
            }
        };
        if let Some(u) = get("MAILCRAFT_LLM_BASE_URL") {
            provider = provider.with_base_url(&u);
        }
        let model = get("MAILCRAFT_LLM_MODEL").unwrap_or_else(|| DEFAULT_MODEL.into());
        Ok(Self { provider, model })
    }

    pub fn build(self) -> Result<(OpenAiCompat, String), LlmError> {
        Ok((OpenAiCompat::new(self.provider)?, self.model))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(kv: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = kv
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn defaults_overrides_and_redaction() {
        let s = LlmSettings::from_lookup(env(&[("OPENROUTER_API_KEY", "sk-secret")])).unwrap();
        assert_eq!(s.provider.id, "openrouter");
        assert_eq!(s.model, DEFAULT_MODEL);
        assert!(!format!("{s:?}").contains("sk-secret"));

        let s = LlmSettings::from_lookup(env(&[
            ("MAILCRAFT_LLM_PROVIDER", "ollama"),
            ("MAILCRAFT_LLM_BASE_URL", "http://x:1/v1/"),
            ("MAILCRAFT_LLM_MODEL", "llama3"),
        ]))
        .unwrap();
        assert_eq!(
            (s.provider.base_url.as_str(), s.model.as_str()),
            ("http://x:1/v1", "llama3")
        );

        assert!(LlmSettings::from_lookup(env(&[]))
            .unwrap_err()
            .contains("OPENROUTER_API_KEY"));
        assert!(LlmSettings::from_lookup(env(&[("MAILCRAFT_LLM_PROVIDER", "x")])).is_err());
    }
}
