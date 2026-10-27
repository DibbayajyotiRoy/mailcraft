//! LLM personalization hook. WP5 (`mailcraft-llm`) implements [`Personalizer`]; the engine only
//! knows this trait. Implementations own the SPEC 10 pipeline (prompt, validator, retry,
//! `llm_generations` audit rows) and return slot text only, never markup or links.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotSpec {
    pub name: String,
    pub max_len: Option<usize>,
    pub instructions: Option<String>,
    /// Static fallback copy (publish of an `llm` send is refused unless every slot has one).
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonalizeRequest {
    pub workspace_id: Uuid,
    pub automation_id: Uuid,
    pub run_id: Uuid,
    pub step_key: String,
    pub template_alias: String,
    /// Subject pattern of the template (a skeleton; the model may return a replacement).
    pub subject_template: String,
    pub slots: Vec<SlotSpec>,
    /// Facts the model may use (contact, event, step vars). Built by code; treat as data.
    pub context: Value,
    /// Per-step instructions from the automation definition.
    pub instructions: Option<String>,
    /// Per-step `custom_instructions`; the adapter prepends the workspace's.
    pub custom_instructions: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Personalized {
    pub subject: Option<String>,
    pub preheader: Option<String>,
    /// slot name -> text. Missing names fall back to the slot's static fallback.
    pub slots: BTreeMap<String, String>,
    /// `llm_generations.id`, stored on `emails.generation_id`.
    pub generation_id: Option<Uuid>,
    pub used_fallback: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("personalization failed: {0}")]
pub struct PersonalizeError(pub String);

#[async_trait]
pub trait Personalizer: Send + Sync {
    async fn personalize(&self, req: PersonalizeRequest) -> Result<Personalized, PersonalizeError>;
}

/// Uses each slot's static fallback copy. Safe default when no LLM is configured.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopPersonalizer;

#[async_trait]
impl Personalizer for NoopPersonalizer {
    async fn personalize(&self, req: PersonalizeRequest) -> Result<Personalized, PersonalizeError> {
        Ok(Personalized {
            slots: req
                .slots
                .into_iter()
                .filter_map(|s| s.fallback.map(|f| (s.name, f)))
                .collect(),
            used_fallback: true,
            ..Default::default()
        })
    }
}
