//! Service traits the API calls into. Work packages implement them (domains: WP3,
//! contacts / segments / events: WP4). The API layer only holds `Arc<dyn ...>` and ships
//! `Stub*` implementations that answer `501 not_implemented`.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{transport::DnsRecord, Error, Result, Stream};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddDomain {
    pub domain: String,
    #[serde(default)]
    pub stream: Option<Stream>,
    #[serde(default)]
    pub tracking: Option<Tracking>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Tracking {
    #[serde(default)]
    pub clicks: bool,
    #[serde(default)]
    pub opens: bool,
}

/// `status`: not_started | pending | verified | failed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainView {
    pub id: Uuid,
    pub name: String,
    pub stream: String,
    pub status: String,
    pub records: Vec<DnsRecord>,
}

#[async_trait]
pub trait DomainService: Send + Sync {
    async fn add(&self, workspace: Uuid, req: AddDomain) -> Result<DomainView>;
    async fn list(&self, workspace: Uuid) -> Result<Vec<DomainView>>;
    async fn get(&self, workspace: Uuid, id: Uuid) -> Result<DomainView>;
    /// Re-check DNS now and return the updated view.
    async fn verify(&self, workspace: Uuid, id: Uuid) -> Result<DomainView>;
    async fn rotate_dkim(&self, workspace: Uuid, id: Uuid) -> Result<DomainView>;
    async fn delete(&self, workspace: Uuid, id: Uuid) -> Result<()>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertContact {
    pub email: String,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub properties: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub items: Vec<Value>,
    pub next_cursor: Option<String>,
}

#[async_trait]
pub trait ContactService: Send + Sync {
    async fn upsert(&self, workspace: Uuid, req: UpsertContact) -> Result<Value>;
    async fn get(&self, workspace: Uuid, id_or_email: &str) -> Result<Value>;
    async fn list(&self, workspace: Uuid, limit: u32, cursor: Option<String>) -> Result<Page>;
    async fn delete(&self, workspace: Uuid, id_or_email: &str) -> Result<()>;
    async fn suppress(&self, workspace: Uuid, id_or_email: &str, reason: &str) -> Result<()>;
}

#[async_trait]
pub trait SegmentService: Send + Sync {
    async fn create(&self, workspace: Uuid, name: &str, filter: Option<Value>) -> Result<Value>;
    async fn list(&self, workspace: Uuid) -> Result<Vec<Value>>;
    async fn add_members(
        &self,
        workspace: Uuid,
        segment: Uuid,
        emails: Vec<String>,
    ) -> Result<Value>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackEvent {
    pub name: String,
    pub contact: ContactRef,
    #[serde(default)]
    pub properties: Option<Value>,
    #[serde(default)]
    pub contact_properties: Option<Value>,
    #[serde(default)]
    pub dry_run: bool,
    /// Filled by the API from the `Idempotency-Key` header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactRef {
    pub email: String,
}

#[async_trait]
pub trait EventService: Send + Sync {
    async fn track(&self, workspace: Uuid, req: TrackEvent) -> Result<Value>;
}

macro_rules! stub {
    ($what:expr) => {
        Err(Error::not_implemented($what))
    };
}

pub struct StubDomainService;
#[async_trait]
impl DomainService for StubDomainService {
    async fn add(&self, _: Uuid, _: AddDomain) -> Result<DomainView> {
        stub!("domains")
    }
    async fn list(&self, _: Uuid) -> Result<Vec<DomainView>> {
        stub!("domains")
    }
    async fn get(&self, _: Uuid, _: Uuid) -> Result<DomainView> {
        stub!("domains")
    }
    async fn verify(&self, _: Uuid, _: Uuid) -> Result<DomainView> {
        stub!("domains")
    }
    async fn rotate_dkim(&self, _: Uuid, _: Uuid) -> Result<DomainView> {
        stub!("domains")
    }
    async fn delete(&self, _: Uuid, _: Uuid) -> Result<()> {
        stub!("domains")
    }
}

pub struct StubContactService;
#[async_trait]
impl ContactService for StubContactService {
    async fn upsert(&self, _: Uuid, _: UpsertContact) -> Result<Value> {
        stub!("contacts")
    }
    async fn get(&self, _: Uuid, _: &str) -> Result<Value> {
        stub!("contacts")
    }
    async fn list(&self, _: Uuid, _: u32, _: Option<String>) -> Result<Page> {
        stub!("contacts")
    }
    async fn delete(&self, _: Uuid, _: &str) -> Result<()> {
        stub!("contacts")
    }
    async fn suppress(&self, _: Uuid, _: &str, _: &str) -> Result<()> {
        stub!("contacts")
    }
}

pub struct StubSegmentService;
#[async_trait]
impl SegmentService for StubSegmentService {
    async fn create(&self, _: Uuid, _: &str, _: Option<Value>) -> Result<Value> {
        stub!("segments")
    }
    async fn list(&self, _: Uuid) -> Result<Vec<Value>> {
        stub!("segments")
    }
    async fn add_members(&self, _: Uuid, _: Uuid, _: Vec<String>) -> Result<Value> {
        stub!("segments")
    }
}

pub struct StubEventService;
#[async_trait]
impl EventService for StubEventService {
    async fn track(&self, _: Uuid, _: TrackEvent) -> Result<Value> {
        stub!("events")
    }
}
