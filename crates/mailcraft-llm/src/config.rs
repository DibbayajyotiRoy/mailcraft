//! Provider config from env: MAILCRAFT_LLM_PROVIDER (openrouter|openai|ollama, default openrouter),
//! MAILCRAFT_LLM_BASE_URL, MAILCRAFT_LLM_MODEL, MAILCRAFT_LLM_FALLBACK_MODELS (comma list, OpenRouter only),
//! Free models only on OpenRouter: ids must end in `:free` (see [`is_free_model`]); others are refused.
//! MAILCRAFT_LLM_REASONING (off|low|medium|high, default off,
//! OpenRouter only), MAILCRAFT_LLM_GUARDRAILS (default|api-product), OPENROUTER_API_KEY (OPENAI_API_KEY for openai).
//! The key is never logged: `Debug` of this type and of `OpenAiCompatConfig` redact it.
use crate::personalize::Guardrails;
use crate::provider::{OpenAiCompat, OpenAiCompatConfig};
use mailcraft_core::llm::LlmError;

/// Free models only (hard product requirement): the default is the bake-off winner.
pub const DEFAULT_MODEL: &str = "nvidia/nemotron-3.5-super-vl:free";

/// Used when MAILCRAFT_LLM_FALLBACK_MODELS is unset (OpenRouter only), tried in order.
/// All `:free`, tool/JSON capable open-weight models.
pub const DEFAULT_FALLBACK_MODELS: &[&str] = &[
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-4-31b-it:free",
];

/// True iff `id` is a free OpenRouter model. `:free` is an OpenRouter naming convention and
/// means nothing for openai/ollama ids, so only the `openrouter` provider is gated on it
/// (see `OpenAiCompat::generate`, the single choke point every generation passes through).
pub fn is_free_model(id: &str) -> bool {
    id.ends_with(":free")
}

pub struct LlmSettings {
    pub provider: OpenAiCompatConfig,
    pub model: String,
    /// MAILCRAFT_LLM_GUARDRAILS=default|api-product: pass to `PersonalizeRequest.guardrails`.
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
            provider.fallback_models = get("MAILCRAFT_LLM_FALLBACK_MODELS")
                .map(|v| {
                    v.split(',')
                        .map(|m| m.trim().to_owned())
                        .filter(|m| !m.is_empty())
                        .filter(|m| {
                            let free = is_free_model(m);
                            if !free {
                                tracing::warn!(model = %m, "MAILCRAFT_LLM_FALLBACK_MODELS: dropping non-:free model (free models only)");
                            }
                            free
                        })
                        .collect()
                })
                .unwrap_or_else(|| DEFAULT_FALLBACK_MODELS.iter().map(|m| (*m).into()).collect());
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
            "api-product" => Guardrails::api_product(),
            o => {
                return Err(format!(
                    "unknown MAILCRAFT_LLM_GUARDRAILS {o:?} (default|api-product)"
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
        assert_eq!(s.provider.fallback_models, DEFAULT_FALLBACK_MODELS);

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
            ("MAILCRAFT_LLM_GUARDRAILS", "api-product"),
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
        let s = LlmSettings::from_lookup(env(&[
            k,
            ("MAILCRAFT_LLM_FALLBACK_MODELS", " a/x:free, b/y:free ,"),
        ]))
        .unwrap();
        assert_eq!(s.provider.fallback_models, ["a/x:free", "b/y:free"]);
        assert!(LlmSettings::from_lookup(env(&[k, ("MAILCRAFT_LLM_REASONING", "x")])).is_err());
        let s = LlmSettings::from_lookup(env(&[("MAILCRAFT_LLM_PROVIDER", "ollama")])).unwrap();
        assert_eq!(s.provider.reasoning, None);

        assert!(LlmSettings::from_lookup(env(&[]))
            .unwrap_err()
            .contains("OPENROUTER_API_KEY"));
        assert!(LlmSettings::from_lookup(env(&[("MAILCRAFT_LLM_PROVIDER", "x")])).is_err());
    }

    #[test]
    fn is_free_model_means_colon_free_suffix() {
        assert!(is_free_model("nvidia/nemotron-3.5-super-vl:free"));
        assert!(!is_free_model("deepseek/deepseek-v4-flash"));
        assert!(!is_free_model("a/x:free:online"));
        assert!(!is_free_model("a/x:freebie"));
        assert!(!is_free_model(""));
    }

    #[test]
    fn defaults_are_free() {
        assert!(is_free_model(DEFAULT_MODEL));
        assert!(DEFAULT_FALLBACK_MODELS.iter().all(|m| is_free_model(m)));
        assert!(!DEFAULT_FALLBACK_MODELS.contains(&DEFAULT_MODEL));
    }

    #[test]
    fn paid_fallback_entries_are_dropped_and_free_override_accepted() {
        let k = ("OPENROUTER_API_KEY", "k");
        let s = LlmSettings::from_lookup(env(&[
            k,
            ("MAILCRAFT_LLM_MODEL", "google/gemma-4-31b-it:free"),
            (
                "MAILCRAFT_LLM_FALLBACK_MODELS",
                "deepseek/deepseek-v4-flash, a/x:free, openai/gpt-5-nano",
            ),
        ]))
        .unwrap();
        assert_eq!(s.model, "google/gemma-4-31b-it:free");
        assert_eq!(s.provider.fallback_models, ["a/x:free"]);
        // An explicit all-paid list means no fallbacks, not a silent switch to the defaults.
        let s = LlmSettings::from_lookup(env(&[
            k,
            ("MAILCRAFT_LLM_FALLBACK_MODELS", "openai/gpt-5-nano"),
        ]))
        .unwrap();
        assert!(s.provider.fallback_models.is_empty());
        // Non-OpenRouter providers are not gated and get no OpenRouter fallbacks.
        let s = LlmSettings::from_lookup(env(&[("MAILCRAFT_LLM_PROVIDER", "ollama")])).unwrap();
        assert!(s.provider.fallback_models.is_empty());
    }
}
