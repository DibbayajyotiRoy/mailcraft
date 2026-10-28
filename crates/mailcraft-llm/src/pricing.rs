//! Model price table, used only when the provider does not return `usage.cost`
//! (OpenAI and Ollama never do; OpenRouter does).
use mailcraft_core::llm::Usage;

/// (model id, USD per 1M input tokens, USD per 1M output tokens). Prices drift; update here.
const PRICES: &[(&str, f64, f64)] = &[
    ("deepseek/deepseek-v4-flash", 0.14, 0.28),
    ("anthropic/claude-haiku-5.5", 0.10, 0.50),
    ("openai/gpt-6-luna", 0.10, 0.50),
    ("qwen/qwen3.8-flash", 0.15, 0.47),
    ("google/gemini-2.5-flash-lite", 0.10, 0.40),
    ("openai/gpt-5-nano", 0.05, 0.40),
    ("gpt-5-nano", 0.05, 0.40),
    ("mistralai/mistral-small-3.2-24b-instruct", 0.075, 0.20),
    ("meta-llama/llama-3.3-70b-instruct", 0.10, 0.32),
];

/// Unknown models are billed at this conservative rate so the budget cap still bites.
const UNKNOWN: (f64, f64) = (1.0, 3.0);

/// Estimated USD cost. Local providers (`ollama`) are free; variant suffixes (`:free`, `:online`) are ignored.
pub fn estimate_cost_usd(provider_id: &str, model: &str, usage: &Usage) -> f64 {
    if provider_id == "ollama" {
        return 0.0;
    }
    let base = model.split(':').next().unwrap_or(model);
    let (i, o) = PRICES
        .iter()
        .find(|p| p.0 == base)
        .map(|p| (p.1, p.2))
        .unwrap_or(UNKNOWN);
    (usage.prompt_tokens as f64 * i + usage.completion_tokens as f64 * o) / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_unknown_and_local() {
        let u = Usage {
            prompt_tokens: 1_000_000,
            completion_tokens: 1_000_000,
        };
        // A paid id still prices from the table (the table is pure; mailcraft never calls it).
        let llama = "meta-llama/llama-3.3-70b-instruct";
        assert!((estimate_cost_usd("openrouter", llama, &u) - 0.42).abs() < 1e-9);
        assert!(
            (estimate_cost_usd("openrouter", &format!("{llama}:free"), &u) - 0.42).abs() < 1e-9
        );
        assert!((estimate_cost_usd("openai", "mystery", &u) - 4.0).abs() < 1e-9);
        assert_eq!(estimate_cost_usd("ollama", "llama3", &u), 0.0);
    }
}
