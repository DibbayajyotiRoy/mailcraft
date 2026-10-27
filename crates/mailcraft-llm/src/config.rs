//! Provider config from env: MAILCRAFT_LLM_PROVIDER (openrouter|openai|ollama, default openrouter),
//! MAILCRAFT_LLM_BASE_URL, MAILCRAFT_LLM_MODEL, MAILCRAFT_LLM_REASONING (off|low|medium|high, default off,
//! OpenRouter only), MAILCRAFT_LLM_GUARDRAILS (default|spicrawl), OPENROUTER_API_KEY (OPENAI_API_KEY for openai).
//! The key is never logged: `Debug` of this type and of `OpenAiCompatConfig` redact it.
use crate::personalize::Guardrails;
use crate::provider::{OpenAiCompat, OpenAiCompatConfig};
use mailcraft_core::llm::LlmError;

pub const DEFAULT_MODEL: &str = "deepseek/deepseek-v4-flash";

pub struct LlmSettings {
    pub provider: OpenAiCompatConfig,
    pub model: String,
    /// MAILCRAFT_LLM_GUARDRAILS=default|spicrawl: pass to `PersonalizeRequest.guardrails`.
    pub guardrails: Guardrails,
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
        if provider.id == "openrouter" {
            provider.reasoning = Some(
                match get("MAILCRAFT_LLM_REASONING").as_deref().unwrap_or("off") {
                    "off" => serde_json::json!({"enabled": false}),
                    e @ ("low" | "medium" | "high") => serde_json::json!({"effort": e}),
                    o => {
                        return Err(format!(
                            "unknown MAILCRAFT_LLM_REASONING {o:?} (off|low|medium|high)"
                        ))
                    }
                },
            );
        }
        let guardrails = match get("MAILCRAFT_LLM_GUARDRAILS")
            .as_deref()
            .unwrap_or("default")
        {
            "default" => Guardrails::default(),
            "spicrawl" => Guardrails::spicrawl(),
            o => {
                return Err(format!(
                    "unknown MAILCRAFT_LLM_GUARDRAILS {o:?} (default|spicrawl)"
                ))
            }
        };
        let model = get("MAILCRAFT_LLM_MODEL").unwrap_or_else(|| DEFAULT_MODEL.into());
        Ok(Self {
            provider,
            model,
            guardrails,
        })
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

        // reasoning + guardrails
        let k = ("OPENROUTER_API_KEY", "k");
        let s = LlmSettings::from_lookup(env(&[k])).unwrap();
        assert_eq!(
            s.provider.reasoning,
            Some(serde_json::json!({"enabled": false}))
        );
        assert_eq!(
            s.guardrails.banned_terms,
            Guardrails::default().banned_terms
        );
        let s = LlmSettings::from_lookup(env(&[
            k,
            ("MAILCRAFT_LLM_REASONING", "low"),
            ("MAILCRAFT_LLM_GUARDRAILS", "spicrawl"),
        ]))
        .unwrap();
        assert_eq!(
            s.provider.reasoning,
            Some(serde_json::json!({"effort": "low"}))
        );
        assert!(s
            .guardrails
            .banned_terms
            .iter()
            .any(|t| t.contains("camoufox")));
        assert!(LlmSettings::from_lookup(env(&[k, ("MAILCRAFT_LLM_REASONING", "x")])).is_err());
        let s = LlmSettings::from_lookup(env(&[("MAILCRAFT_LLM_PROVIDER", "ollama")])).unwrap();
        assert_eq!(s.provider.reasoning, None);

        assert!(LlmSettings::from_lookup(env(&[]))
            .unwrap_err()
            .contains("OPENROUTER_API_KEY"));
        assert!(LlmSettings::from_lookup(env(&[("MAILCRAFT_LLM_PROVIDER", "x")])).is_err());
    }
}
