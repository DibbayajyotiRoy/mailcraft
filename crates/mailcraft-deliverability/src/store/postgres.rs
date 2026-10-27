//! Postgres stores over the init schema (`domains`, `dkim_keys`, `domain_records`) plus
//! `domain_plans` from migration `20261028000004_deliverability.sql`.
//! Plain runtime queries (no compile-time macros), so the crate builds without a database.
use super::*;
use crate::{
    crypto::SecretBox,
    dns::{
        plan::{Purpose, RType},
        verify::Status,
    },
};
use sqlx::{PgPool, Row};

fn db(e: sqlx::Error) -> Error {
    Error::new("database_error", 500, e.to_string()).retryable()
}

fn stream_str(s: Stream) -> &'static str {
    match s {
        Stream::Transactional => "transactional",
        Stream::Marketing => "marketing",
    }
}

fn domain_row(r: &sqlx::postgres::PgRow) -> Result<DomainRow> {
    let stream: String = r.try_get("stream").map_err(db)?;
    let status: String = r.try_get("status").map_err(db)?;
    Ok(DomainRow {
        id: r.try_get("id").map_err(db)?,
        workspace_id: r.try_get("workspace_id").map_err(db)?,
        name: r.try_get("name").map_err(db)?,
        stream: if stream == "marketing" {
            Stream::Marketing
        } else {
            Stream::Transactional
        },
        status: DomainStatus::from_db(&status),
        return_path_host: r.try_get("return_path_host").map_err(db)?,
        dns_provider: r.try_get("dns_provider").map_err(db)?,
        verified_at: r.try_get("verified_at_unix").map_err(db)?,
    })
}

const DOMAIN_COLS: &str = "id, workspace_id, name, stream, status, return_path_host, dns_provider, \
     (extract(epoch from verified_at))::bigint AS verified_at_unix";

/// `domain_records.record` label for a planner purpose.
fn record_label(p: Purpose) -> &'static str {
    match p {
        Purpose::DkimCname | Purpose::DkimTxt => "DKIM",
        Purpose::ReturnPathMx => "ReturnPath",
        Purpose::ReturnPathSpf => "SPF",
        Purpose::Dmarc => "DMARC",
        Purpose::MtaStsTxt | Purpose::MtaStsHost => "MTASTS",
        Purpose::TlsRpt => "TLSRPT",
    }
}

fn purpose_str(p: Purpose) -> String {
    serde_json::to_value(p)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

fn record_status(s: Status) -> &'static str {
    match s {
        Status::Ok => "verified",
        Status::Missing | Status::Wrong => "failed",
        Status::Propagating | Status::Error => "pending",
    }
}

#[derive(Clone)]
pub struct PgDomains {
    pool: PgPool,
}

impl PgDomains {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    async fn write_records(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        id: Uuid,
        plan: &Plan,
    ) -> Result<()> {
        sqlx::query("DELETE FROM domain_records WHERE domain_id = $1")
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(db)?;
        for r in &plan.records {
            sqlx::query(
                "INSERT INTO domain_records (domain_id, record, type, name, value, priority, purpose) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7)",
            )
            .bind(id)
            .bind(record_label(r.purpose))
            .bind(r.rtype.as_str())
            .bind(&r.name)
            .bind(&r.value)
            .bind(r.priority.map(i32::from))
            .bind(purpose_str(r.purpose))
            .execute(&mut **tx)
            .await
            .map_err(db)?;
        }
        sqlx::query(
            "INSERT INTO domain_plans (domain_id, plan) VALUES ($1,$2) \
             ON CONFLICT (domain_id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = now()",
        )
        .bind(id)
        .bind(serde_json::to_value(plan).map_err(|e| Error::new("serialize", 500, e.to_string()))?)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
        Ok(())
    }
}

#[async_trait]
impl DomainStore for PgDomains {
    async fn create(
        &self,
        id: Uuid,
        workspace_id: Uuid,
        stream: Stream,
        plan: &Plan,
    ) -> Result<DomainRow> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let r = sqlx::query(&format!(
            "INSERT INTO domains (id, workspace_id, name, stream, return_path_host) VALUES ($1,$2,$3,$4,$5) \
             RETURNING {DOMAIN_COLS}"
        ))
        .bind(id)
        .bind(workspace_id)
        .bind(&plan.sending_domain)
        .bind(stream_str(stream))
        .bind(&plan.bounce_domain)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => {
                Error::new("domain_exists", 409, format!("{} already exists", plan.sending_domain))
            }
            _ => db(e),
        })?;
        let row = domain_row(&r)?;
        Self::write_records(&mut tx, id, plan).await?;
        tx.commit().await.map_err(db)?;
        Ok(row)
    }
    async fn get(&self, id: Uuid) -> Result<Option<DomainRow>> {
        sqlx::query(&format!("SELECT {DOMAIN_COLS} FROM domains WHERE id = $1"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .map(|r| domain_row(&r))
            .transpose()
    }
    async fn find_by_name(&self, workspace_id: Uuid, name: &str) -> Result<Option<DomainRow>> {
        sqlx::query(&format!(
            "SELECT {DOMAIN_COLS} FROM domains WHERE workspace_id = $1 AND name = $2"
        ))
        .bind(workspace_id)
        .bind(name)
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?
        .map(|r| domain_row(&r))
        .transpose()
    }
    async fn list(&self, workspace_id: Uuid) -> Result<Vec<DomainRow>> {
        sqlx::query(&format!(
            "SELECT {DOMAIN_COLS} FROM domains WHERE workspace_id = $1 ORDER BY name"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .map_err(db)?
        .iter()
        .map(domain_row)
        .collect()
    }
    async fn load_plan(&self, id: Uuid) -> Result<Option<Plan>> {
        let v: Option<serde_json::Value> =
            sqlx::query_scalar("SELECT plan FROM domain_plans WHERE domain_id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?;
        v.map(|v| {
            serde_json::from_value(v).map_err(|e| Error::new("plan_corrupt", 500, e.to_string()))
        })
        .transpose()
    }
    async fn save_plan(&self, id: Uuid, plan: &Plan) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        Self::write_records(&mut tx, id, plan).await?;
        tx.commit().await.map_err(db)
    }
    async fn save_checks(&self, id: Uuid, checks: &[Check], now_unix: i64) -> Result<DomainStatus> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        for c in checks {
            sqlx::query(
                "UPDATE domain_records SET status = $1, detail = $2, checked_at = now() \
                 WHERE domain_id = $3 AND name = $4 AND type = $5 AND purpose = $6",
            )
            .bind(record_status(c.status))
            .bind(&c.hint)
            .bind(id)
            .bind(&c.name)
            .bind(c.rtype.as_str())
            .bind(purpose_str(c.purpose))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        }
        let _ = RType::Txt; // RType::as_str gives the CHECK-constrained TXT/CNAME/MX spelling
        let st = domain_status(checks);
        let n = sqlx::query(
            "UPDATE domains SET status = $1, \
             verified_at = CASE WHEN $1 = 'verified' THEN COALESCE(verified_at, to_timestamp($2)) ELSE verified_at END \
             WHERE id = $3",
        )
        .bind(st.as_str())
        .bind(now_unix as f64)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if n == 0 {
            return Err(err_not_found("domain", "domain_not_found"));
        }
        tx.commit().await.map_err(db)?;
        Ok(st)
    }
    async fn set_dns_provider(&self, id: Uuid, provider: Option<&str>) -> Result<()> {
        sqlx::query("UPDATE domains SET dns_provider = $1 WHERE id = $2")
            .bind(provider)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
    async fn delete(&self, id: Uuid) -> Result<bool> {
        // dkim_keys, domain_records and domain_plans cascade.
        Ok(sqlx::query("DELETE FROM domains WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(db)?
            .rows_affected()
            > 0)
    }
}

#[derive(Clone)]
pub struct PgKeys {
    pool: PgPool,
    secret: SecretBox,
}

impl PgKeys {
    pub fn new(pool: PgPool, secret: SecretBox) -> Self {
        Self { pool, secret }
    }
}

fn aad(domain_id: Uuid, selector: &str) -> Vec<u8> {
    format!("{domain_id}:{selector}").into_bytes()
}

fn algo_of(s: &str) -> Result<Algo> {
    Algo::from_db(s)
        .ok_or_else(|| Error::new("dkim_key_corrupt", 500, format!("unknown algorithm {s}")))
}

fn meta(r: &sqlx::postgres::PgRow) -> Result<KeyMeta> {
    let algo: String = r.try_get("algorithm").map_err(db)?;
    let state: String = r.try_get("state").map_err(db)?;
    Ok(KeyMeta {
        selector: r.try_get("selector").map_err(db)?,
        algo: algo_of(&algo)?,
        public_b64: r.try_get("public_key").map_err(db)?,
        state: KeyState::from_db(&state),
        created_at: r.try_get("created_unix").map_err(db)?,
        retired_at: r.try_get("retired_unix").map_err(db)?,
    })
}

const KEY_COLS: &str = "selector, algorithm, public_key, state, (extract(epoch from created_at))::bigint AS created_unix, \
     (extract(epoch from retired_at))::bigint AS retired_unix";

#[async_trait]
impl KeyStore for PgKeys {
    async fn insert(
        &self,
        domain_id: Uuid,
        key: &DkimKey,
        state: KeyState,
        now_unix: i64,
    ) -> Result<()> {
        let sealed = self
            .secret
            .seal(key.private_pem.as_bytes(), &aad(domain_id, &key.selector));
        sqlx::query(
            "INSERT INTO dkim_keys (domain_id, selector, algorithm, public_key, private_key_enc, state, created_at) \
             VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7))",
        )
        .bind(domain_id)
        .bind(&key.selector)
        .bind(key.algo.db_str())
        .bind(&key.public_b64)
        .bind(sealed)
        .bind(state.as_str())
        .bind(now_unix as f64)
        .execute(&self.pool)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d)
                if d.is_unique_violation() && d.constraint() == Some("dkim_keys_domain_id_selector_key") =>
            {
                Error::new("selector_reused", 409, format!("selector {} was already used on this domain", key.selector))
            }
            _ => db(e),
        })?;
        Ok(())
    }
    async fn list(&self, domain_id: Uuid) -> Result<Vec<KeyMeta>> {
        sqlx::query(&format!(
            "SELECT {KEY_COLS} FROM dkim_keys WHERE domain_id = $1 ORDER BY created_at DESC, selector DESC"
        ))
        .bind(domain_id)
        .fetch_all(&self.pool)
        .await
        .map_err(db)?
        .iter()
        .map(meta)
        .collect()
    }
    async fn load(&self, domain_id: Uuid, state: KeyState) -> Result<Vec<DkimKey>> {
        let rows = sqlx::query(
            "SELECT selector, algorithm, public_key, private_key_enc FROM dkim_keys WHERE domain_id = $1 AND state = $2",
        )
        .bind(domain_id)
        .bind(state.as_str())
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        rows.iter()
            .map(|r| {
                let selector: String = r.try_get("selector").map_err(db)?;
                let algo: String = r.try_get("algorithm").map_err(db)?;
                let sealed: Vec<u8> = r.try_get("private_key_enc").map_err(db)?;
                let pem = self
                    .secret
                    .open(&sealed, &aad(domain_id, &selector))
                    .map_err(|e| {
                        Error::new(
                            "secret_key_mismatch",
                            500,
                            format!("cannot decrypt DKIM key {selector}: {e}"),
                        )
                        .hint("MAILCRAFT_SECRET_KEY differs from the one the key was created with")
                    })?;
                Ok(DkimKey {
                    selector,
                    algo: algo_of(&algo)?,
                    private_pem: String::from_utf8_lossy(&pem).into_owned(),
                    public_b64: r.try_get("public_key").map_err(db)?,
                })
            })
            .collect()
    }
    async fn activate(&self, domain_id: Uuid, selector: &str, now_unix: i64) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let algo: Option<String> = sqlx::query_scalar(
            "SELECT algorithm FROM dkim_keys WHERE domain_id = $1 AND selector = $2 FOR UPDATE",
        )
        .bind(domain_id)
        .bind(selector)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        let algo = algo.ok_or_else(|| err_not_found("dkim key", "dkim_key_not_found"))?;
        // retire first: the partial unique index allows one active key per (domain, algorithm)
        sqlx::query(
            "UPDATE dkim_keys SET state = 'retired', retired_at = to_timestamp($1) \
             WHERE domain_id = $2 AND algorithm = $3 AND state = 'active' AND selector <> $4",
        )
        .bind(now_unix as f64)
        .bind(domain_id)
        .bind(&algo)
        .bind(selector)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query("UPDATE dkim_keys SET state = 'active', retired_at = NULL WHERE domain_id = $1 AND selector = $2")
            .bind(domain_id)
            .bind(selector)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)
    }
    async fn purge_retired(&self, domain_id: Uuid, before_unix: i64) -> Result<Vec<String>> {
        sqlx::query_scalar(
            "DELETE FROM dkim_keys WHERE domain_id = $1 AND state = 'retired' \
             AND retired_at < to_timestamp($2) RETURNING selector",
        )
        .bind(domain_id)
        .bind(before_unix as f64)
        .fetch_all(&self.pool)
        .await
        .map_err(db)
    }
    async fn public_txt(&self, sending_domain: &str, selector: &str) -> Result<Option<String>> {
        let row = sqlx::query(
            "SELECT k.algorithm, k.public_key FROM dkim_keys k JOIN domains d ON d.id = k.domain_id \
             WHERE d.name = $1 AND k.selector = $2 LIMIT 1",
        )
        .bind(sending_domain)
        .bind(selector)
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?;
        row.map(|r| {
            let algo: String = r.try_get("algorithm").map_err(db)?;
            let p: String = r.try_get("public_key").map_err(db)?;
            Ok(crate::keys::txt_value(algo_of(&algo)?, &p))
        })
        .transpose()
    }
}

/// Warm-up stage lives in Postgres so it survives a Redis flush (SPEC section 8, `warmup_state`).
#[derive(Clone)]
pub struct PgWarmupState {
    pool: PgPool,
}

impl PgWarmupState {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
    /// Unix start of the ramp for `(domain, provider)`, creating the row (starting now) if absent.
    /// Feed it to [`crate::warmup::WarmupPlan::start`].
    pub async fn get_or_start(
        &self,
        workspace_id: Uuid,
        domain_id: Uuid,
        provider_key: &str,
        now_unix: i64,
    ) -> Result<i64> {
        sqlx::query_scalar(
            "INSERT INTO warmup_state (workspace_id, domain_id, rcpt_provider, started_at) \
             VALUES ($1,$2,$3,to_timestamp($4)) \
             ON CONFLICT (domain_id, rcpt_provider) DO UPDATE SET rcpt_provider = EXCLUDED.rcpt_provider \
             RETURNING (extract(epoch from started_at))::bigint",
        )
        .bind(workspace_id)
        .bind(domain_id)
        .bind(provider_key)
        .bind(now_unix as f64)
        .fetch_one(&self.pool)
        .await
        .map_err(db)
    }
    /// Persist a pause (e.g. after a block bounce) so it also survives a Redis flush.
    pub async fn pause_until(
        &self,
        domain_id: Uuid,
        provider_key: &str,
        until_unix: i64,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE warmup_state SET paused_until = GREATEST(COALESCE(paused_until, 'epoch'), to_timestamp($1)) \
             WHERE domain_id = $2 AND rcpt_provider = $3",
        )
        .bind(until_unix as f64)
        .bind(domain_id)
        .bind(provider_key)
        .execute(&self.pool)
        .await
        .map_err(db)?;
        Ok(())
    }
}
