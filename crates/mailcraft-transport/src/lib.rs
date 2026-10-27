//! Transport implementations. Trait lives in `mailcraft-core`.
pub mod smtp_relay;

pub use mailcraft_core::transport::{DeliveryResult, Outbound, Transport};
