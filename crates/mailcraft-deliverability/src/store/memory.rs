//! In-memory stores for tests and `--dry-run` tooling. Keys are sealed through the same
//! [`SecretBox`] as the Postgres store so tests exercise the encrypt/decrypt path.
use super::*;
use crate::crypto::SecretBox;
use std::{collections::HashMap, sync::Mutex};

type DomainEntry = (DomainRow, Plan, HashMap<String, crate::dns::verify::Status>);

#[derive(Default)]
pub struct MemoryDomains {
    inner: Mutex<HashMap<Uuid, DomainEntry>>,
}

#[async_trait]
impl DomainStore for MemoryDomains {
    async fn create(
        &self,
        id: Uuid,
        workspace_id: Uuid,
        stream: Stream,
        plan: &Plan,
    ) -> Result<DomainRow> {
        let mut m = self.inner.lock().unwrap();
        if m.values()
            .any(|(d, _, _)| d.workspace_id == workspace_id && d.name == plan.sending_domain)
        {
            return Err(Error::new(
                "domain_exists",
                409,
                format!("{} already exists", plan.sending_domain),
            ));
        }
        let row = DomainRow {
            id,
            workspace_id,
            name: plan.sending_domain.clone(),
            stream,
            status: DomainStatus::NotStarted,
            return_path_host: plan.bounce_domain.clone(),
            dns_provider: None,
            verified_at: None,
        };
        m.insert(id, (row.clone(), plan.clone(), HashMap::new()));
        Ok(row)
    }
    async fn get(&self, id: Uuid) -> Result<Option<DomainRow>> {
        Ok(self.inner.lock().unwrap().get(&id).map(|x| x.0.clone()))
    }
    async fn find_by_name(&self, workspace_id: Uuid, name: &str) -> Result<Option<DomainRow>> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .values()
            .find(|x| x.0.workspace_id == workspace_id && x.0.name == name)
            .map(|x| x.0.clone()))
    }
    async fn list(&self, workspace_id: Uuid) -> Result<Vec<DomainRow>> {
        let mut v: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .values()
            .filter(|x| x.0.workspace_id == workspace_id)
            .map(|x| x.0.clone())
            .collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(v)
    }
    async fn load_plan(&self, id: Uuid) -> Result<Option<Plan>> {
        Ok(self.inner.lock().unwrap().get(&id).map(|x| x.1.clone()))
    }
    async fn save_plan(&self, id: Uuid, plan: &Plan) -> Result<()> {
        let mut m = self.inner.lock().unwrap();
        let e = m
            .get_mut(&id)
            .ok_or_else(|| err_not_found("domain", "domain_not_found"))?;
        e.1 = plan.clone();
        e.2.clear();
        Ok(())
    }
    async fn save_checks(&self, id: Uuid, checks: &[Check], now_unix: i64) -> Result<DomainStatus> {
        let mut m = self.inner.lock().unwrap();
        let e = m
            .get_mut(&id)
            .ok_or_else(|| err_not_found("domain", "domain_not_found"))?;
        for c in checks {
            e.2.insert(format!("{}:{}", c.name, c.rtype.as_str()), c.status);
        }
        let st = domain_status(checks);
        e.0.status = st;
        if st == DomainStatus::Verified && e.0.verified_at.is_none() {
            e.0.verified_at = Some(now_unix);
        }
        Ok(st)
    }
    async fn set_dns_provider(&self, id: Uuid, provider: Option<&str>) -> Result<()> {
        let mut m = self.inner.lock().unwrap();
        let e = m
            .get_mut(&id)
            .ok_or_else(|| err_not_found("domain", "domain_not_found"))?;
        e.0.dns_provider = provider.map(Into::into);
        Ok(())
    }
    async fn delete(&self, id: Uuid) -> Result<bool> {
        Ok(self.inner.lock().unwrap().remove(&id).is_some())
    }
}

pub struct MemoryKeys {
    secret: SecretBox,
    rows: Mutex<Vec<(Uuid, KeyMeta, Vec<u8>)>>,
    names: Mutex<HashMap<Uuid, String>>,
}

impl MemoryKeys {
    pub fn new(secret: SecretBox) -> Self {
        Self {
            secret,
            rows: Mutex::default(),
            names: Mutex::default(),
        }
    }
    /// The memory store needs the sending-domain name for `public_txt`; Postgres joins `domains`.
    pub fn name_domain(&self, id: Uuid, name: &str) {
        self.names.lock().unwrap().insert(id, name.into());
    }
    /// Sealed bytes of a row, for at-rest assertions.
    pub fn sealed(&self, domain_id: Uuid, selector: &str) -> Option<Vec<u8>> {
        self.rows
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.0 == domain_id && r.1.selector == selector)
            .map(|r| r.2.clone())
    }
}

fn aad(domain_id: Uuid, selector: &str) -> Vec<u8> {
    format!("{domain_id}:{selector}").into_bytes()
}

#[async_trait]
impl KeyStore for MemoryKeys {
    async fn insert(
        &self,
        domain_id: Uuid,
        key: &DkimKey,
        state: KeyState,
        now_unix: i64,
    ) -> Result<()> {
        let mut rows = self.rows.lock().unwrap();
        if rows
            .iter()
            .any(|r| r.0 == domain_id && r.1.selector == key.selector)
        {
            return Err(Error::new(
                "selector_reused",
                409,
                format!("selector {} was already used on this domain", key.selector),
            ));
        }
        let sealed = self
            .secret
            .seal(key.private_pem.as_bytes(), &aad(domain_id, &key.selector));
        rows.push((
            domain_id,
            KeyMeta {
                selector: key.selector.clone(),
                algo: key.algo,
                public_b64: key.public_b64.clone(),
                state,
                created_at: now_unix,
                retired_at: None,
            },
            sealed,
        ));
        Ok(())
    }
    async fn list(&self, domain_id: Uuid) -> Result<Vec<KeyMeta>> {
        let mut v: Vec<_> = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.0 == domain_id)
            .map(|r| r.1.clone())
            .collect();
        v.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then(b.selector.cmp(&a.selector))
        });
        Ok(v)
    }
    async fn load(&self, domain_id: Uuid, state: KeyState) -> Result<Vec<DkimKey>> {
        let rows = self.rows.lock().unwrap();
        rows.iter()
            .filter(|r| r.0 == domain_id && r.1.state == state)
            .map(|r| {
                let pem = self
                    .secret
                    .open(&r.2, &aad(domain_id, &r.1.selector))
                    .map_err(|e| Error::new("secret_key_mismatch", 500, e.to_string()))?;
                Ok(DkimKey {
                    selector: r.1.selector.clone(),
                    algo: r.1.algo,
                    private_pem: String::from_utf8_lossy(&pem).into_owned(),
                    public_b64: r.1.public_b64.clone(),
                })
            })
            .collect()
    }
    async fn activate(&self, domain_id: Uuid, selector: &str, now_unix: i64) -> Result<()> {
        let mut rows = self.rows.lock().unwrap();
        let algo = rows
            .iter()
            .find(|r| r.0 == domain_id && r.1.selector == selector)
            .map(|r| r.1.algo)
            .ok_or_else(|| err_not_found("dkim key", "dkim_key_not_found"))?;
        for r in rows
            .iter_mut()
            .filter(|r| r.0 == domain_id && r.1.algo == algo)
        {
            if r.1.selector == selector {
                r.1.state = KeyState::Active;
                r.1.retired_at = None;
            } else if r.1.state == KeyState::Active {
                r.1.state = KeyState::Retired;
                r.1.retired_at = Some(now_unix);
            }
        }
        Ok(())
    }
    async fn purge_retired(&self, domain_id: Uuid, before_unix: i64) -> Result<Vec<String>> {
        let mut rows = self.rows.lock().unwrap();
        let mut gone = Vec::new();
        rows.retain(|r| {
            let purge = r.0 == domain_id
                && r.1.state == KeyState::Retired
                && r.1.retired_at.is_some_and(|t| t < before_unix);
            if purge {
                gone.push(r.1.selector.clone());
            }
            !purge
        });
        Ok(gone)
    }
    async fn public_txt(&self, sending_domain: &str, selector: &str) -> Result<Option<String>> {
        let names = self.names.lock().unwrap();
        let rows = self.rows.lock().unwrap();
        Ok(rows
            .iter()
            .find(|r| {
                r.1.selector == selector && names.get(&r.0).is_some_and(|n| n == sending_domain)
            })
            .map(|r| crate::keys::txt_value(r.1.algo, &r.1.public_b64)))
    }
}
