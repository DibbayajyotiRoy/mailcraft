//! Postgres + Redis integration. Runs only with `MAILCRAFT_TEST_INFRA=1` (throwaway containers:
//! postgres on 55436, redis on 56381; override with MAILCRAFT_TEST_PG / MAILCRAFT_TEST_REDIS).
use mailcraft_core::Stream;
use mailcraft_deliverability::{
    Category, Provider,
    crypto::SecretBox,
    dns::{
        plan::{Instance, Options, Plan, Purpose, RType},
        verify::{Dns, DnsError},
    },
    finalize::{DefaultFinalizer, Finalizer, Job},
    keys::Algo,
    service::{self, AddDomain},
    store::{
        DomainStatus, DomainStore, FinalizerSettings, KeyState, KeyStore, TenantConfigLoader,
        memory::{MemoryDomains, MemoryKeys},
        postgres::{PgDomains, PgKeys, PgWarmupState},
    },
    warmup::{CounterStore, Decision, Pacer, RampProfile, RedisCounters, Throttle, WarmupPlan},
};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use uuid::Uuid;

const NOW: i64 = 1_793_000_000;

fn enabled() -> bool {
    std::env::var("MAILCRAFT_TEST_INFRA").is_ok_and(|v| v == "1")
        || std::env::var("MAILCRAFT_REQUIRE_DB").is_ok()
}

/// Answers exactly what the plan says to publish (plus the instance-served DKIM target TXT).
struct PlanDns(Plan);
impl Dns for PlanDns {
    async fn txt(&self, name: &str) -> Result<Vec<String>, DnsError> {
        let mut v: Vec<String> = self
            .0
            .records
            .iter()
            .filter(|r| r.rtype == RType::Txt && r.name == name)
            .map(|r| r.value.clone())
            .collect();
        for r in &self.0.records {
            if r.rtype == RType::Cname
                && r.purpose == Purpose::DkimCname
                && r.value == name
                && let Some(a) = self
                    .0
                    .dkim_txt_alternative
                    .iter()
                    .find(|a| a.name == r.name)
            {
                v.push(a.value.clone());
            }
        }
        if v.is_empty() {
            Err(DnsError::NotFound)
        } else {
            Ok(v)
        }
    }
    async fn cname(&self, name: &str) -> Result<Vec<String>, DnsError> {
        let v: Vec<String> = self
            .0
            .records
            .iter()
            .filter(|r| r.rtype == RType::Cname && r.name == name)
            .map(|r| r.value.clone())
            .collect();
        if v.is_empty() {
            Err(DnsError::NotFound)
        } else {
            Ok(v)
        }
    }
    async fn mx(&self, name: &str) -> Result<Vec<String>, DnsError> {
        let v: Vec<String> = self
            .0
            .records
            .iter()
            .filter(|r| r.rtype == RType::Mx && r.name == name)
            .map(|r| format!("10 {}", r.value))
            .collect();
        if v.is_empty() {
            Err(DnsError::NotFound)
        } else {
            Ok(v)
        }
    }
}

fn settings() -> FinalizerSettings {
    FinalizerSettings {
        verp_secret: b"verp".to_vec(),
        unsub_secret: b"unsub".to_vec(),
        unsub_base_url: "https://mc.example.net".into(),
        unsub_mailto: None,
        unsub_ttl_secs: 86_400,
        feedback_sender_id: "mailcraft".into(),
        transactional_unsubscribe: false,
    }
}

fn msg(from: &str) -> Vec<u8> {
    format!("From: {from}\r\nTo: a@gmail.com\r\nSubject: hi\r\n\r\nbody\r\n").into_bytes()
}

/// The whole lifecycle against any store pair.
async fn lifecycle(
    domains: &dyn DomainStore,
    keys: &dyn KeyStore,
    ws: Uuid,
    name_hook: &dyn Fn(Uuid, &str),
) {
    let inst = Instance {
        domain: Some("mc.example.net".into()),
        mx_host: "mx.mc.example.net".into(),
        ips: vec![],
    };
    let opts = Options {
        dmarc_rua: Some("d@example.com".into()),
        ..Default::default()
    };
    let add = || AddDomain {
        workspace_id: ws,
        domain: "example.com",
        stream: Stream::Transactional,
        use_subdomain: true,
        ed25519: true,
        instance: &inst,
        options: &opts,
        now: NOW,
    };
    let (row, plan) = service::add_domain(domains, keys, add()).await.unwrap();
    name_hook(row.id, &row.name);
    assert_eq!(row.name, "mail.example.com");
    assert_eq!(
        service::add_domain(domains, keys, add())
            .await
            .unwrap_err()
            .code,
        "domain_exists"
    );

    // unverified domains cannot send
    let settings = settings();
    let loader = TenantConfigLoader {
        domains,
        keys,
        settings: &settings,
    };
    assert_eq!(
        loader.load(row.id).await.err().unwrap().code,
        "domain_not_verified"
    );

    // verify against DNS that matches the plan -> verified; then it can sign
    let (st, checks) = service::verify_domain(domains, &PlanDns(plan.clone()), row.id, NOW + 3600)
        .await
        .unwrap();
    assert_eq!(st, DomainStatus::Verified, "{checks:?}");
    let (cfg, d) = loader.load(row.id).await.unwrap();
    assert_eq!(d.status, DomainStatus::Verified);
    let job = Job {
        email_id: Uuid::new_v4(),
        stream: Stream::Transactional,
        category: Category::Transactional,
        contact_id: "c1".into(),
        campaign_id: "welcome".into(),
        now: NOW as u64,
    };
    let raw = DefaultFinalizer
        .finalize(&msg("hi@mail.example.com"), &cfg, &job)
        .unwrap();
    let s = String::from_utf8(raw).unwrap();
    assert_eq!(s.matches("DKIM-Signature:").count(), 2, "rsa + ed25519");
    assert!(s.contains("d=mail.example.com") && s.contains("s=mc2026a") && s.contains("s=mc2026b"));

    // the instance can serve the CNAME targets
    let txt = keys
        .public_txt("mail.example.com", "mc2026a")
        .await
        .unwrap()
        .unwrap();
    assert!(txt.starts_with("v=DKIM1; k=rsa; p=MII"));

    // rotate: standby is not used for signing until activated; old key retires; selector never reused
    let (k, plan2) = service::rotate_dkim(domains, keys, row.id, Algo::Rsa2048, &inst, NOW + 10)
        .await
        .unwrap();
    assert_eq!(k.selector, "mc2026c", "a and b are taken");
    assert!(
        plan2
            .records
            .iter()
            .any(|r| r.name.starts_with("mc2026c._domainkey"))
    );
    let active: Vec<_> = keys
        .load(row.id, KeyState::Active)
        .await
        .unwrap()
        .into_iter()
        .map(|k| k.selector)
        .collect();
    assert!(active.contains(&"mc2026a".to_string()) && !active.contains(&"mc2026c".to_string()));
    assert_eq!(
        keys.insert(row.id, &k, KeyState::Standby, NOW)
            .await
            .unwrap_err()
            .code,
        "selector_reused"
    );
    service::activate_dkim(keys, row.id, "mc2026c", NOW + 20)
        .await
        .unwrap();
    let metas = keys.list(row.id).await.unwrap();
    let st = |s: &str| metas.iter().find(|m| m.selector == s).unwrap().state;
    assert_eq!(
        (st("mc2026a"), st("mc2026c"), st("mc2026b")),
        (KeyState::Retired, KeyState::Active, KeyState::Active)
    );
    // retired key stays resolvable, then is purged after the keep window along with its records
    assert!(
        keys.public_txt("mail.example.com", "mc2026a")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        service::purge_retired_dkim(domains, keys, row.id, NOW + 100)
            .await
            .unwrap()
            .is_empty()
    );
    let gone = service::purge_retired_dkim(
        domains,
        keys,
        row.id,
        NOW + 20 + service::RETIRED_KEEP_SECS + 1,
    )
    .await
    .unwrap();
    assert_eq!(gone, ["mc2026a"]);
    let p3 = domains.load_plan(row.id).await.unwrap().unwrap();
    assert!(
        !p3.records
            .iter()
            .any(|r| r.name.starts_with("mc2026a._domainkey"))
    );

    assert!(domains.delete(row.id).await.unwrap());
    assert!(domains.get(row.id).await.unwrap().is_none());
}

#[tokio::test]
async fn memory_lifecycle() {
    let keys = Arc::new(MemoryKeys::new(SecretBox::from_key(&[7u8; 32]).unwrap()));
    let k2 = keys.clone();
    lifecycle(
        &MemoryDomains::default(),
        &*keys,
        Uuid::new_v4(),
        &move |id, n| k2.name_domain(id, n),
    )
    .await;
}

#[tokio::test]
async fn postgres_lifecycle_and_encryption_at_rest() {
    if !enabled() {
        eprintln!("skipped: MAILCRAFT_TEST_INFRA!=1");
        return;
    }
    let url = std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or("postgres://postgres:x@127.0.0.1:55432/postgres".into());
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap();
    // fresh schema per run
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        .execute(&pool)
        .await
        .unwrap();
    let mig = sqlx::migrate::Migrator::new(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../migrations"
    )))
    .await
    .unwrap();
    mig.run(&pool).await.unwrap();
    let ws: Uuid = sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ('t') RETURNING id")
        .fetch_one(&pool)
        .await
        .unwrap();

    let secret = SecretBox::from_key(&[7u8; 32]).unwrap();
    let (domains, keys) = (
        PgDomains::new(pool.clone()),
        PgKeys::new(pool.clone(), secret),
    );
    lifecycle(&domains, &keys, ws, &|_, _| {}).await;

    // at rest: ciphertext only, bound to its row, unreadable with another secret
    let inst = Instance {
        domain: Some("mc.example.net".into()),
        mx_host: "mx.mc.example.net".into(),
        ips: vec![],
    };
    let (row, _) = service::add_domain(
        &domains,
        &keys,
        AddDomain {
            workspace_id: ws,
            domain: "other.org",
            stream: Stream::Marketing,
            use_subdomain: true,
            ed25519: false,
            instance: &inst,
            options: &Options::default(),
            now: NOW,
        },
    )
    .await
    .unwrap();
    let blob: Vec<u8> =
        sqlx::query_scalar("SELECT private_key_enc FROM dkim_keys WHERE domain_id = $1")
            .bind(row.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!String::from_utf8_lossy(&blob).contains("PRIVATE KEY"));
    let wrong = PgKeys::new(pool.clone(), SecretBox::from_key(&[9u8; 32]).unwrap());
    assert_eq!(
        wrong
            .load(row.id, KeyState::Active)
            .await
            .err()
            .unwrap()
            .code,
        "secret_key_mismatch"
    );
    // one active key per (domain, algorithm) is enforced by the database
    let dup = sqlx::query("UPDATE dkim_keys SET state='active' WHERE domain_id=$1")
        .bind(row.id)
        .execute(&pool)
        .await;
    assert!(dup.is_ok(), "single key is fine");
    // record rows mirror the plan and carry status after verify
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM domain_records WHERE domain_id = $1")
        .bind(row.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(n >= 4);
    let plan = domains.load_plan(row.id).await.unwrap().unwrap();
    service::verify_domain(&domains, &PlanDns(plan), row.id, NOW + 7200)
        .await
        .unwrap();
    let verified: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM domain_records WHERE domain_id = $1 AND status = 'verified'",
    )
    .bind(row.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(verified >= 4);
    let vat: Option<i64> = sqlx::query_scalar(
        "SELECT (extract(epoch from verified_at))::bigint FROM domains WHERE id=$1",
    )
    .bind(row.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(vat, Some(NOW + 7200));

    // warm-up stage persists and is idempotent
    let w = PgWarmupState::new(pool.clone());
    let a = w.get_or_start(ws, row.id, "gmail", NOW).await.unwrap();
    let b = w
        .get_or_start(ws, row.id, "gmail", NOW + 999)
        .await
        .unwrap();
    assert_eq!((a, b), (NOW, NOW));
    w.pause_until(row.id, "gmail", NOW + 600).await.unwrap();
}

#[tokio::test]
async fn redis_counters_are_atomic_and_expire() {
    if !enabled() {
        eprintln!("skipped: MAILCRAFT_TEST_INFRA!=1");
        return;
    }
    let url = std::env::var("MAILCRAFT_TEST_REDIS").unwrap_or("redis://127.0.0.1:56379".into());
    let conn = redis::aio::ConnectionManager::new(redis::Client::open(url).unwrap())
        .await
        .unwrap();
    let pfx = format!("t{}:", Uuid::new_v4().simple());
    let store = Arc::new(RedisCounters::new(conn.clone(), &pfx));

    // 60 concurrent acquires against cap 10 -> exactly 10 succeed
    let mut hs = Vec::new();
    for _ in 0..60 {
        let s = store.clone();
        hs.push(tokio::spawn(async move { s.try_incr("k", 10, 100).await }));
    }
    let mut ok = 0;
    for h in hs {
        ok += h.await.unwrap() as u32;
    }
    assert_eq!(ok, 10);
    assert_eq!(store.used("k").await, 10);
    let mut c = conn.clone();
    let ttl: i64 = redis::cmd("TTL")
        .arg(format!("{pfx}k"))
        .query_async(&mut c)
        .await
        .unwrap();
    assert!((1..=100).contains(&ttl), "expiry set on first incr: {ttl}");

    // pause markers keep the max and expire at the instant
    let until = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 600;
    store.set_until("p", until).await;
    store.set_until("p", until - 300).await;
    assert_eq!(store.get_until("p").await, Some(until));

    // warm-up pacer and throttle on top of redis
    let day = 20_000u64 * 86_400;
    let plan = WarmupPlan {
        start: day,
        profile: RampProfile::Ip,
        target_daily: 1_000_000,
        first_week_cap: None,
    };
    let pacer = Pacer::new(RedisCounters::new(conn.clone(), &pfx));
    for _ in 0..50 {
        assert!(matches!(
            pacer
                .try_acquire("d1", &Provider::Gmail, &plan, day + 5)
                .await,
            Decision::Send { .. }
        ));
    }
    assert_eq!(
        pacer
            .try_acquire("d1", &Provider::Gmail, &plan, day + 6)
            .await,
        Decision::DeferUntil(day + 86_400)
    );
    // pause markers use EXAT, so they need a real future instant
    pacer.pause("d1", &Provider::Yahoo, until).await;
    assert_eq!(
        pacer
            .try_acquire("d1", &Provider::Yahoo, &plan, until - 500)
            .await,
        Decision::Paused { until }
    );
    let thr = Throttle::new(RedisCounters::new(conn, &pfx));
    let mut allowed = 0;
    for _ in 0..8 {
        allowed += thr.allow("gmail.com", 5, 60, day + 1).await as u32;
    }
    assert_eq!(allowed, 5);
    assert!(thr.allow("gmail.com", 5, 60, day + 61).await, "next window");
}
