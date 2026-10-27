//! mailcraft-deliverability: DKIM keys, DNS plan/verify, outbound finalizer, unsubscribe,
//! bounce/complaint parsing, suppression policy, warm-up pacing and `doctor`. See SPEC.md section 12.
pub mod bounce;
pub mod complaint;
pub mod crypto;
pub mod dns;
pub mod doctor;
pub mod finalize;
pub mod keys;
pub mod provider;
pub mod service;
pub mod store;
pub mod suppression;
pub mod token;
pub mod unsubscribe;
pub mod warmup;

pub use provider::Provider;
pub use unsubscribe::Category;
