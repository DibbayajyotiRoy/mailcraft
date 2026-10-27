//! Orchestration the API/CLI call: add a domain (keys + plan + rows), verify it, rotate DKIM,
//! sync to Cloudflare. Thin glue over the stores; no HTTP here (WP1 mounts these).
use crate::{
    dns::{
        cloudflare::{Change, Cloudflare},
        plan::{self, Instance, Options, Plan},
        verify::{self, Check, Dns},
    },
    keys::{self, Algo, DkimKey},
    store::{DomainRow, DomainStatus, DomainStore, KeyState, KeyStore},
};
use mailcraft_core::{Error, Result, Stream};
use uuid::Uuid;

/// Retired DKIM keys stay published/served this long so in-flight mail still verifies (SPEC: ~7 days).
pub const RETIRED_KEEP_SECS: i64 = 7 * 86_400;

fn year(now: i64) -> u32 {
    keys::year_of(now.max(0) as u64)
}

fn core_err(e: String) -> Error {
    Error::new("domain_plan_failed", 422, e)
}

pub struct AddDomain<'a> {
    pub workspace_id: Uuid,
    pub domain: &'a str,
    pub stream: Stream,
    pub use_subdomain: bool,
    /// Also create an Ed25519 key (dual-sign).
    pub ed25519: bool,
    pub instance: &'a Instance,
    pub options: &'a Options,
    pub now: i64,
}

/// Generates keys (RSA-2048 active, optional Ed25519 active on the next selector), plans the records,
/// and stores domain + plan + records + sealed keys. Returns the row and the plan to show the user.
pub async fn add_domain(
    domains: &dyn DomainStore,
    keystore: &dyn KeyStore,
    a: AddDomain<'_>,
) -> Result<(DomainRow, Plan)> {
    let y = year(a.now);
    let mut ks = vec![DkimKey::generate(Algo::Rsa2048, keys::selector(y, 0)).map_err(core_err)?];
    if a.ed25519 {
        ks.push(DkimKey::generate(Algo::Ed25519, keys::selector(y, 1)).map_err(core_err)?);
    }
    let plan = plan::plan(
        a.domain,
        a.use_subdomain,
        a.instance,
        &ks,
        a.options,
        a.now.max(0) as u64,
    )
    .map_err(core_err)?;
    let id = Uuid::new_v4();
    let row = domains.create(id, a.workspace_id, a.stream, &plan).await?;
    for k in &ks {
        keystore.insert(id, k, KeyState::Active, a.now).await?;
    }
    Ok((row, plan))
}

/// Re-check a domain's records against live DNS, persist the result, return per-record checks.
pub async fn verify_domain<D: Dns>(
    domains: &dyn DomainStore,
    dns: &D,
    id: Uuid,
    now: i64,
) -> Result<(DomainStatus, Vec<Check>)> {
    let plan = domains
        .load_plan(id)
        .await?
        .ok_or_else(|| Error::new("domain_not_found", 404, "domain not found"))?;
    let checks = verify::verify(dns, &plan, now.max(0) as u64).await;
    let st = domains.save_checks(id, &checks, now).await?;
    Ok((st, checks))
}

/// Create the next selector as `standby` and add its records to the stored plan. With an instance
/// domain the CNAME target is served by the instance, so no tenant DNS edit is needed; otherwise the
/// returned plan lists the new TXT to publish. Follow with [`activate_dkim`] once it verifies.
pub async fn rotate_dkim(
    domains: &dyn DomainStore,
    keystore: &dyn KeyStore,
    id: Uuid,
    algo: Algo,
    inst: &Instance,
    now: i64,
) -> Result<(DkimKey, Plan)> {
    let mut plan = domains
        .load_plan(id)
        .await?
        .ok_or_else(|| Error::new("domain_not_found", 404, "domain not found"))?;
    let existing = keystore.list(id).await?;
    // never reuse a name: take the highest selector letter used this year by any key
    let prev = existing
        .iter()
        .map(|k| k.selector.as_str())
        .filter(|s| s.starts_with(&format!("mc{}", year(now))))
        .max();
    let key = DkimKey::generate(algo, keys::next_selector(prev, year(now))).map_err(core_err)?;
    keystore.insert(id, &key, KeyState::Standby, now).await?;
    let (recs, alts) = plan::dkim_records(inst, &plan.sending_domain, &key);
    plan.records.extend(recs);
    plan.dkim_txt_alternative.extend(alts);
    plan.created_unix = now.max(0) as u64;
    domains.save_plan(id, &plan).await?;
    Ok((key, plan))
}

/// Switch signing to `selector`; the previous key of that algorithm becomes `retired`.
pub async fn activate_dkim(
    keystore: &dyn KeyStore,
    id: Uuid,
    selector: &str,
    now: i64,
) -> Result<()> {
    keystore.activate(id, selector, now).await
}

/// Drop retired keys older than [`RETIRED_KEEP_SECS`] and their records from the stored plan.
pub async fn purge_retired_dkim(
    domains: &dyn DomainStore,
    keystore: &dyn KeyStore,
    id: Uuid,
    now: i64,
) -> Result<Vec<String>> {
    let gone = keystore.purge_retired(id, now - RETIRED_KEEP_SECS).await?;
    if !gone.is_empty()
        && let Some(mut plan) = domains.load_plan(id).await?
    {
        let dead = |name: &str| {
            gone.iter()
                .any(|s| name.starts_with(&format!("{s}._domainkey.")))
        };
        plan.records.retain(|r| !dead(&r.name));
        plan.dkim_txt_alternative.retain(|r| !dead(&r.name));
        domains.save_plan(id, &plan).await?;
    }
    Ok(gone)
}

/// Push the plan's records to Cloudflare (`dry_run` writes nothing) and remember the provider.
pub async fn sync_cloudflare(
    domains: &dyn DomainStore,
    cf: &Cloudflare,
    id: Uuid,
    dry_run: bool,
) -> Result<Vec<Change>> {
    let plan = domains
        .load_plan(id)
        .await?
        .ok_or_else(|| Error::new("domain_not_found", 404, "domain not found"))?;
    let zone = cf.find_zone(&plan.sending_domain).await.map_err(|e| {
        Error::new("dns_provider_error", 502, e)
            .hint("token needs Zone:Read and DNS:Edit on the zone")
    })?;
    let changes = cf
        .sync(&zone, &plan.records, dry_run)
        .await
        .map_err(|e| Error::new("dns_provider_error", 502, e).retryable())?;
    if !dry_run {
        domains.set_dns_provider(id, Some("cloudflare")).await?;
    }
    Ok(changes)
}
