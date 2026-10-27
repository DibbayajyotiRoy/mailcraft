//! Contacts, segments, event ingestion and the journey engine (SPEC 6.7, 13).
//!
//! * [`contacts`]: contacts, topics (unsubscribe categories), segments (filters evaluated in SQL).
//! * [`def`]: automation definitions (`trigger`, `condition`, `delay`, `wait_for_event`,
//!   `send_email`, `update_contact`, `add_to_segment`, `exit`), validation and `install`.
//! * [`engine`]: [`Engine`] ingests events, enrolls, and advances runs on durable timers.
//! * [`personalize`]: the [`Personalizer`] trait WP5 implements.
//! * [`policy`]: quiet hours and frequency-cap math.

pub mod contacts;
pub mod def;
pub mod engine;
pub mod error;
#[cfg(feature = "llm")]
pub mod llm_adapter;
pub mod personalize;
pub mod policy;
pub mod rules;

pub use contacts::{Contact, ContactInput};
pub use def::{install, Definition, EntryRule, Goal, Next, SendCfg, SendMode, Step, StepKind};
pub use engine::{Engine, EngineConfig, FrequencyCaps, TickStats, TrackInput, Tracked};
pub use error::{AutomationError, Result};
#[cfg(feature = "llm")]
pub use llm_adapter::{personalizer_from_env, LlmAdapter};
pub use personalize::{
    NoopPersonalizer, PersonalizeError, PersonalizeRequest, Personalized, Personalizer, SlotSpec,
};
pub use policy::QuietHours;
pub use rules::{Op, Rule};
