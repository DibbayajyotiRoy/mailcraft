//! mailcraft-llm: guarded LLM slot generation for lifecycle emails (SPEC section 10).
//! Flow: provider -> slots JSON -> validator (+ spam on the final message) -> one repair -> static fallback.
//! Call `Personalizer::personalize` from automations; the provider trait lives in `mailcraft-core`.
pub mod budget;
pub mod config;
pub mod contract;
pub mod personalize;
pub mod pipeline;
pub mod pricing;
pub mod provider;
pub mod spam;
pub mod validator;

pub use mailcraft_core::llm::{GenerateRequest, GenerateResult, LlmError, LlmProvider};

pub use budget::{BudgetExceeded, BudgetGuard, BudgetLimits, InMemoryBudget, NoBudget, PgBudget};
pub use config::LlmSettings;
pub use contract::{EmailTemplate, Slots};
pub use personalize::{
    Guardrails, LlmPersonalizer, PersonalizeRequest, Personalizer, EXAMPLE_SENTENCES,
    NO_REPLY_LINE, PROMPT_VERSION, REPLY_LINE, SYSTEM_PROMPT,
};
pub use pipeline::{
    clean_custom_instructions, context_hash, merge_custom_instructions, AttemptReport, GenerateJob,
    Generator, MessageRenderer, Outcome, Report, CUSTOM_MAX_CHARS,
};
pub use provider::{OpenAiCompat, OpenAiCompatConfig};
pub use spam::{NoopSpamChecker, RspamdChecker, SpamChecker, SpamConfig, SpamVerdict};
pub use validator::{Validator, ValidatorConfig, Violation};
