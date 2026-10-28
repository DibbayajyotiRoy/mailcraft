//! From addresses and per-send routing. Nothing is stored for a "sender": the list is derived from
//! what is connected, i.e. every mailbox-relay login plus its aliases (`transports.config_enc`:
//! `{username, mailbox_sender, aliases?, display_names?}`), with the workspace `default_from` marked.
//!
//! Routing (`Routing::route`), first match wins:
//! 1. the request's explicit `transport_id`;
//! 2. a mailbox-sender relay whose login or alias is the From address;
//! 3. the transport bound to the From domain (`domains.transport_id`);
//! 4. the workspace default transport.
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::extract::State;
use mailcraft_core::{address, auth::Scope};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    auth::Auth,
    error::{envelope_list, invalid, ApiError, ApiResult},
    state::AppState,
};

/// A connected mailbox: sends as `login`, and as each alias ("Send mail as" on the provider).
#[derive(Clone)]
pub(crate) struct Relay {
    pub id: Uuid,
    pub login: String,
    pub aliases: Vec<String>,
    pub names: BTreeMap<String, String>,
}

impl Relay {
    pub fn addresses(&self) -> impl Iterator<Item = &String> {
        std::iter::once(&self.login).chain(&self.aliases)
    }
    fn covers(&self, addr: &str) -> bool {
        self.addresses().any(|a| a.eq_ignore_ascii_case(addr))
    }
}

type Cache = Mutex<HashMap<Uuid, (Instant, Option<Relay>)>>;

/// Decrypted relay configs, kept for a short while (per process; `forget` on edit).
fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(Default::default)
}

pub(crate) fn forget(id: Uuid) {
    cache().lock().unwrap().remove(&id);
}

fn parse(st: &AppState, id: Uuid, enc: &[u8]) -> Option<Relay> {
    let c: Value = serde_json::from_slice(&st.secrets.open(enc, id.as_bytes()).ok()?).ok()?;
    c["mailbox_sender"].as_bool().filter(|b| *b)?;
    let low = |v: &Value| v.as_str().map(|s| s.to_ascii_lowercase());
    Some(Relay {
        id,
        login: low(&c["username"])?,
        aliases: c["aliases"]
            .as_array()
            .map(|a| a.iter().filter_map(low).collect())
            .unwrap_or_default(),
        names: c["display_names"]
            .as_object()
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| Some((k.to_ascii_lowercase(), v.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Every mailbox-sender relay of the workspace, default transport first.
pub(crate) async fn relays(st: &AppState, ws: Uuid) -> ApiResult<Vec<Relay>> {
    let rows: Vec<(Uuid, Vec<u8>)> = sqlx::query_as(
        "SELECT id, config_enc FROM transports WHERE workspace_id = $1 AND kind = 'smtp-relay' \
         ORDER BY is_default DESC, created_at, id",
    )
    .bind(ws)
    .fetch_all(&st.db)
    .await?;
    let mut out = Vec::new();
    for (id, enc) in rows {
        let hit = cache()
            .lock()
            .unwrap()
            .get(&id)
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(30))
            .map(|(_, r)| r.clone());
        let r = hit.unwrap_or_else(|| {
            let r = parse(st, id, &enc);
            cache()
                .lock()
                .unwrap()
                .insert(id, (Instant::now(), r.clone()));
            r
        });
        out.extend(r);
    }
    Ok(out)
}

pub(crate) struct Dom {
    pub id: Uuid,
    pub name: String,
    pub verified: bool,
    pub transport_id: Option<Uuid>,
}

pub(crate) struct Route {
    /// The verified mailcraft domain of the From address, if any.
    pub domain_id: Option<Uuid>,
    /// A mailbox relay covers the address (its login is proof of ownership).
    pub via_relay: bool,
    pub transport: Option<(Uuid, String)>,
    /// `explicit` | `mailbox_relay` | `domain` | `default`
    pub why: &'static str,
}

impl Route {
    /// May a live key send from this address at all?
    pub fn allowed(&self) -> bool {
        self.domain_id.is_some() || self.via_relay
    }
}

/// A workspace's routing inputs, loaded once per request.
pub(crate) struct Routing {
    pub relays: Vec<Relay>,
    pub domains: Vec<Dom>,
    /// `(id, name)`, default first.
    pub transports: Vec<(Uuid, String)>,
}

impl Routing {
    pub async fn load(st: &AppState, ws: Uuid) -> ApiResult<Self> {
        let domains: Vec<(Uuid, String, bool, Option<Uuid>)> = sqlx::query_as(
            "SELECT id, lower(name), status = 'verified', transport_id FROM domains WHERE workspace_id = $1",
        )
        .bind(ws)
        .fetch_all(&st.db)
        .await?;
        let transports = sqlx::query_as(
            "SELECT id, name FROM transports WHERE workspace_id = $1 ORDER BY is_default DESC, created_at, id",
        )
        .bind(ws)
        .fetch_all(&st.db)
        .await?;
        Ok(Self {
            relays: relays(st, ws).await?,
            domains: domains
                .into_iter()
                .map(|(id, name, verified, transport_id)| Dom {
                    id,
                    name,
                    verified,
                    transport_id,
                })
                .collect(),
            transports,
        })
    }

    pub fn has_transport(&self, id: Uuid) -> bool {
        self.transports.iter().any(|t| t.0 == id)
    }

    pub fn route(&self, addr: &str, explicit: Option<Uuid>) -> Route {
        let domain = address::domain_of(addr).to_ascii_lowercase();
        let dom = self.domains.iter().find(|d| d.name == domain);
        let relay = self.relays.iter().find(|r| r.covers(addr));
        let pick = |id: Uuid| self.transports.iter().find(|t| t.0 == id).cloned();
        let (transport, why) = if let Some(t) = explicit.and_then(pick) {
            (Some(t), "explicit")
        } else if let Some(t) = relay.and_then(|r| pick(r.id)) {
            (Some(t), "mailbox_relay")
        } else if let Some(t) = dom.and_then(|d| d.transport_id).and_then(pick) {
            (Some(t), "domain")
        } else {
            (self.transports.first().cloned(), "default")
        };
        Route {
            domain_id: dom.filter(|d| d.verified).map(|d| d.id),
            via_relay: relay.is_some(),
            transport,
            why,
        }
    }

    pub fn name_of(&self, addr: &str) -> Option<&str> {
        name_of(&self.relays, addr)
    }
}

/// The display name configured for a connected address.
pub(crate) fn name_of<'a>(relays: &'a [Relay], addr: &str) -> Option<&'a str> {
    relays
        .iter()
        .find_map(|r| r.names.get(&addr.to_ascii_lowercase()))
        .map(String::as_str)
        .filter(|n| !n.is_empty())
}

/// `From` for a bare address: `"Display Name" <addr>` when one is configured.
pub(crate) fn labelled(relays: &[Relay], addr: &str) -> String {
    match name_of(relays, addr) {
        Some(n) => format!("\"{n}\" <{addr}>"),
        None => addr.to_string(),
    }
}

/// `GET /v1/senders`: the From addresses you can pick (read-only, derived).
pub async fn list(State(st): State<AppState>, auth: Auth) -> ApiResult {
    auth.require(Scope::Read)?;
    let ws = auth.0.workspace_id;
    let rt = Routing::load(&st, ws).await?;
    let default: Option<String> =
        sqlx::query_scalar("SELECT settings ->> 'default_from' FROM workspaces WHERE id = $1")
            .bind(ws)
            .fetch_one(&st.db)
            .await?;
    let default = default
        .and_then(|f| address::parse_mailbox(&f))
        .map(|(_, a)| a.to_ascii_lowercase());
    let mut addrs: Vec<(String, &str)> = rt
        .relays
        .iter()
        .flat_map(|r| {
            r.addresses()
                .enumerate()
                .map(|(i, a)| (a.clone(), if i == 0 { "login" } else { "alias" }))
        })
        .collect();
    // A default that is not a connected mailbox (an address on a verified domain) is listed too.
    if let Some(d) = default
        .as_ref()
        .filter(|d| !addrs.iter().any(|a| &a.0 == *d))
    {
        addrs.push((d.clone(), "domain"));
    }
    let out: Vec<Value> = addrs
        .into_iter()
        .map(|(a, kind)| {
            let r = rt.route(&a, None);
            let status = if !r.allowed() {
                "needs_domain"
            } else if r.transport.is_none() {
                "transport_missing"
            } else {
                "ready"
            };
            json!({
                "address": a, "display_name": rt.name_of(&a), "kind": kind,
                "transport_id": r.transport.as_ref().map(|t| t.0),
                "transport": r.transport.as_ref().map(|t| &t.1),
                "is_default": default.as_deref() == Some(a.as_str()), "status": status,
            })
        })
        .collect();
    Ok(envelope_list(out, None))
}

/// Lets the automations engine route its sends the same way (`mailcraft_automations::SendRouter`).
#[async_trait::async_trait]
impl mailcraft_automations::SendRouter for AppState {
    async fn route(
        &self,
        ws: Uuid,
        from: &str,
        explicit: Option<Uuid>,
    ) -> mailcraft_automations::Result<(String, Option<Uuid>)> {
        let bad =
            |ApiError(e): ApiError| mailcraft_automations::AutomationError::invalid(e.message);
        let rt = Routing::load(self, ws).await.map_err(bad)?;
        if explicit.is_some_and(|t| !rt.has_transport(t)) {
            return Err(mailcraft_automations::AutomationError::invalid(
                "send step `transport_id` is not a transport of this workspace",
            ));
        }
        let parsed = address::parse_mailbox(from);
        let addr = parsed.as_ref().map_or(from, |m| m.1.as_str());
        let t = rt.route(addr, explicit).transport.map(|t| t.0);
        let from = match &parsed {
            Some((None, a)) => labelled(&rt.relays, a),
            _ => from.to_string(), // already has a display name (or is malformed): as written
        };
        Ok((from, t))
    }
}

/// Used by `transports.rs` to validate `aliases` / `display_names`.
pub(crate) fn clean_name(addr: &str, n: &str) -> Result<String, ApiError> {
    let n = n.trim();
    if n.chars().count() > 100 || n.chars().any(|c| c.is_control() || "\"<>\\".contains(c)) {
        return Err(invalid(format!(
            "display name for {addr} is over 100 characters or has a quote, angle bracket or control character"
        ))
        .field("config.display_names"));
    }
    Ok(n.to_string())
}
