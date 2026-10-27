//! Finalize a mail-builder message and check the DKIM signatures with mail-auth's verifier.
mod common;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use common::verp;
use mail_auth::{
    AuthenticatedMessage, DkimResult, MessageAuthenticator,
    dkim::DomainKey,
    dns::{Parameters, ResolverCache, TxtRecord, TxtRecordParser},
};
use mail_builder::MessageBuilder;
use mailcraft_deliverability::{
    Category,
    finalize::{FinalizeError, Finalized, Job, Stream, TenantConfig},
    keys::{Algo, DkimKey},
    unsubscribe as unsub,
};
use std::{collections::HashMap, sync::Mutex, time::Instant};

const DOMAIN: &str = "mail.example.test";
const NOW: u64 = 1_793_000_000; // 2026-10
const SECRET: &[u8] = b"unsub-test-secret";

/// In-memory TXT cache standing in for DNS.
#[derive(Default)]
struct Txt(Mutex<HashMap<Box<str>, TxtRecord>>);
impl ResolverCache<Box<str>, TxtRecord> for Txt {
    fn get<Q>(&self, k: &Q) -> Option<TxtRecord>
    where
        Box<str>: std::borrow::Borrow<Q>,
        Q: std::hash::Hash + Eq + ?Sized,
    {
        self.0.lock().unwrap().get(k).cloned()
    }
    fn remove<Q>(&self, k: &Q) -> Option<TxtRecord>
    where
        Box<str>: std::borrow::Borrow<Q>,
        Q: std::hash::Hash + Eq + ?Sized,
    {
        self.0.lock().unwrap().remove(k)
    }
    fn insert(&self, k: Box<str>, v: TxtRecord, _: Instant) {
        self.0.lock().unwrap().insert(k, v);
    }
}
struct Dns(Txt);
impl mail_auth::dns::DnsCache for Dns {
    type Txt = Txt;
    type Mx = mail_auth::dns::NoCache;
    type Ipv4 = mail_auth::dns::NoCache;
    type Ipv6 = mail_auth::dns::NoCache;
    type Ptr = mail_auth::dns::NoCache;
    fn txt(&self) -> Option<&Txt> {
        Some(&self.0)
    }
    fn mx(&self) -> Option<&Self::Mx> {
        None
    }
    fn ipv4(&self) -> Option<&Self::Ipv4> {
        None
    }
    fn ipv6(&self) -> Option<&Self::Ipv6> {
        None
    }
    fn ptr(&self) -> Option<&Self::Ptr> {
        None
    }
}

fn publish(dns: &Dns, selector: &str, k: &str, public: &[u8]) {
    let rec = format!("v=DKIM1; k={k}; p={}", B64.encode(public));
    let key = DomainKey::parse(rec.as_bytes()).expect("dkim record parses");
    dns.0.insert(
        format!("{selector}._domainkey.{DOMAIN}.").into(),
        TxtRecord::from(key),
        Instant::now() + std::time::Duration::from_secs(3600),
    );
}

fn finalize(msg: Vec<u8>, cfg: &TenantConfig, job: &Job) -> Result<Finalized, FinalizeError> {
    mailcraft_deliverability::finalize::finalize(&msg, cfg, job)
}

fn setup(transactional_unsubscribe: bool) -> (TenantConfig, Dns) {
    let rsa = DkimKey::generate(Algo::Rsa2048, "rsa1").unwrap();
    let ed = DkimKey::generate(Algo::Ed25519, "ed1").unwrap();
    let dns = Dns(Txt::default());
    // Publish exactly what the planner publishes (SPKI base64 for RSA, raw 32 bytes for Ed25519).
    publish(&dns, "rsa1", "rsa", &B64.decode(&rsa.public_b64).unwrap());
    publish(&dns, "ed1", "ed25519", &B64.decode(&ed.public_b64).unwrap());
    let rsa_key = rsa.rsa_signing_key().unwrap();
    let ed_key = ed.ed25519_signing_key().unwrap();
    let cfg = TenantConfig {
        tenant_id: "tenant1".into(),
        sending_domain: DOMAIN.into(),
        verp: verp(),
        unsub_base_url: "https://mail.example.test".into(),
        unsub_mailto: Some("unsub@mail.example.test".into()),
        unsub_secret: SECRET.to_vec(),
        unsub_ttl_secs: 90 * 86_400,
        feedback_sender_id: "mailcraft".into(),
        transactional_unsubscribe,
        dkim_rsa: Some(TenantConfig::rsa_signer(rsa_key, DOMAIN, "rsa1")),
        dkim_ed25519: Some(TenantConfig::ed25519_signer(ed_key, DOMAIN, "ed1")),
    };
    (cfg, dns)
}

fn msg_from(from: &str) -> Vec<u8> {
    MessageBuilder::new()
        .from(from.to_string())
        .to("reader@gmail.com".to_string())
        .subject("Your October update")
        .text_body("Hello there.")
        .html_body("<p>Hello there.</p>")
        .write_to_vec()
        .unwrap()
}

fn msg() -> Vec<u8> {
    msg_from("hello@mail.example.test")
}

fn job(stream: Stream, category: Category) -> Job {
    Job {
        email_id: uuid::Uuid::from_u128(0x0123456789abcdef0123456789abcdef),
        stream,
        category,
        contact_id: "c42".into(),
        campaign_id: "oct-news".into(),
        now: NOW,
    }
}

async fn verify(raw: &[u8], dns: &Dns) -> Vec<(String, DkimResult, Vec<String>)> {
    let auth = MessageAuthenticator::new_cloudflare().unwrap();
    let m = AuthenticatedMessage::parse(raw).unwrap();
    auth.verify_dkim(Parameters::new(&m).with_cache(dns))
        .await
        .iter()
        .map(|o| {
            let s = o.signature().unwrap();
            (
                format!("{:?}", s.a).to_lowercase(),
                o.result().clone(),
                s.h.clone(),
            )
        })
        .collect()
}

/// Headers only, minus DKIM-Signature fields (their `h=` names the signed headers).
fn header_block(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    let mut out = String::new();
    let mut in_sig = false;
    for l in s.split("\r\n\r\n").next().unwrap().split("\r\n") {
        if l.starts_with([' ', '\t']) {
            if in_sig {
                continue;
            }
        } else {
            in_sig = l.starts_with("DKIM-Signature:")
        }
        if !in_sig {
            out.push_str(l);
            out.push_str("\r\n");
        }
    }
    out
}

#[tokio::test(flavor = "current_thread")]
async fn marketing_message_has_all_headers_and_dual_signatures_verify() {
    let (cfg, dns) = setup(false);
    let f = finalize(msg(), &cfg, &job(Stream::Marketing, Category::Product)).unwrap();
    let h = header_block(&f.raw);

    // headers
    assert!(
        h.contains(&format!("Message-ID: <{}>", f.message_id)),
        "{h}"
    );
    assert!(h.contains("\r\nDate: "));
    assert!(
        h.contains("Feedback-ID: oct-news:tenant1:marketing:mailcraft"),
        "{h}"
    );
    assert!(h.contains("X-Mail-Stream: marketing"));
    assert!(h.contains("List-Unsubscribe-Post: List-Unsubscribe=One-Click"));
    assert!(h.contains("List-Id: <product.mail.example.test>"));
    assert!(
        f.return_path.starts_with("bounces+")
            && f.return_path.ends_with("@bounces.mail.example.test")
    );
    assert_eq!(
        verp()
            .decode(
                f.return_path
                    .trim_start_matches("bounces+")
                    .split('@')
                    .next()
                    .unwrap()
            )
            .as_deref(),
        Some(f.msg_id.as_str())
    );

    // List-Unsubscribe: https first, token verifies, mailto second
    let unfolded = h.replace("\r\n ", " ");
    let lu = unfolded
        .lines()
        .find(|l| l.starts_with("List-Unsubscribe:"))
        .unwrap();
    let url = lu.split('<').nth(1).unwrap().split('>').next().unwrap();
    let token = url.strip_prefix("https://mail.example.test/u/").expect(lu);
    let t = unsub::verify(SECRET, token, NOW).unwrap();
    assert_eq!(
        (t.tenant.as_str(), t.contact.as_str(), t.category),
        ("tenant1", "c42", Category::Product)
    );
    assert!(lu.contains("<mailto:unsub+"), "{lu}");

    // two signatures, both verify, headers covered
    let r = verify(&f.raw, &dns).await;
    assert_eq!(r.len(), 2, "{r:?}");
    for (alg, res, signed) in &r {
        assert_eq!(*res, DkimResult::Pass, "{alg}");
        for want in [
            "from",
            "to",
            "subject",
            "date",
            "message-id",
            "list-unsubscribe",
            "list-unsubscribe-post",
            "feedback-id",
        ] {
            assert!(
                signed.iter().any(|s| s.eq_ignore_ascii_case(want)),
                "{alg} missing {want}: {signed:?}"
            );
        }
    }
    let algs: Vec<_> = r.iter().map(|x| x.0.as_str()).collect();
    assert!(
        algs.iter().any(|a| a.contains("ed25519")) && algs.iter().any(|a| a.contains("rsa")),
        "{algs:?}"
    );
    assert!(String::from_utf8_lossy(&f.raw).contains("c=relaxed/relaxed"));
}

#[tokio::test(flavor = "current_thread")]
async fn tampering_breaks_the_signature() {
    let (cfg, dns) = setup(false);
    let f = finalize(msg(), &cfg, &job(Stream::Marketing, Category::Digest)).unwrap();
    let evil = String::from_utf8(f.raw.clone()).unwrap().replacen(
        "Subject: Your October update",
        "Subject: Free money",
        1,
    );
    assert!(
        verify(&f.raw, &dns)
            .await
            .iter()
            .all(|r| r.1 == DkimResult::Pass)
    );
    assert!(
        verify(evil.as_bytes(), &dns)
            .await
            .iter()
            .all(|r| r.1 != DkimResult::Pass)
    );
    // List-Unsubscribe is signed: swapping the URL must fail too.
    let evil2 = String::from_utf8(f.raw).unwrap().replacen(
        "https://mail.example.test/u/",
        "https://evil.test/u/",
        1,
    );
    assert!(
        verify(evil2.as_bytes(), &dns)
            .await
            .iter()
            .all(|r| r.1 != DkimResult::Pass)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn transactional_has_no_unsubscribe_headers_and_adding_one_breaks_dkim() {
    let (cfg, dns) = setup(false);
    let f = finalize(
        msg(),
        &cfg,
        &job(Stream::Transactional, Category::Transactional),
    )
    .unwrap();
    let h = header_block(&f.raw);
    assert!(
        !h.contains("List-Unsubscribe") && !h.contains("List-Id"),
        "{h}"
    );
    assert!(h.contains("Feedback-ID: oct-news:tenant1:transactional:mailcraft"));
    assert!(
        verify(&f.raw, &dns)
            .await
            .iter()
            .all(|r| r.1 == DkimResult::Pass)
    );
    // h= lists List-Unsubscribe even though absent -> injecting one in transit invalidates the signature
    let injected = format!(
        "List-Unsubscribe: <https://evil.test/u/x>\r\n{}",
        String::from_utf8(f.raw).unwrap()
    );
    assert!(
        verify(injected.as_bytes(), &dns)
            .await
            .iter()
            .all(|r| r.1 != DkimResult::Pass)
    );
}

#[test]
fn transactional_unsubscribe_only_when_configured_and_category_allows() {
    let (cfg, _) = setup(true);
    let f = finalize(msg(), &cfg, &job(Stream::Transactional, Category::Digest)).unwrap();
    assert!(header_block(&f.raw).contains("List-Unsubscribe-Post"));
    // configured, but a true transactional category still gets none
    let f = finalize(
        msg(),
        &cfg,
        &job(Stream::Transactional, Category::Transactional),
    )
    .unwrap();
    assert!(!header_block(&f.raw).contains("List-Unsubscribe"));
}

#[test]
fn refusals() {
    let (cfg, _) = setup(false);
    assert!(
        finalize(
            msg(),
            &cfg,
            &job(Stream::Marketing, Category::Transactional)
        )
        .is_err(),
        "marketing needs unsubscribable category"
    );
    let j = job(Stream::Marketing, Category::Product);
    assert!(
        matches!(
            finalize(msg_from("x@other.test"), &cfg, &j),
            Err(FinalizeError::Unaligned)
        ),
        "unaligned From"
    );
    let mut cfg2 = setup(false).0;
    cfg2.dkim_rsa = None;
    cfg2.dkim_ed25519 = None;
    assert!(finalize(msg(), &cfg2, &job(Stream::Marketing, Category::Product)).is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn rsa_only_and_ed25519_only_work() {
    let (mut cfg, dns) = setup(false);
    cfg.dkim_ed25519 = None;
    let f = finalize(msg(), &cfg, &job(Stream::Marketing, Category::Product)).unwrap();
    let r = verify(&f.raw, &dns).await;
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].1, DkimResult::Pass);
}

#[tokio::test(flavor = "current_thread")]
async fn from_is_oversigned_and_finalizer_trait_matches() {
    use mailcraft_deliverability::finalize::{DefaultFinalizer, Finalizer};
    let (cfg, dns) = setup(false);
    let j = job(Stream::Marketing, Category::Product);
    // the trait path yields the same bytes shape and a deterministic VERP return path
    let raw = DefaultFinalizer.finalize(&msg(), &cfg, &j).unwrap();
    let rp = DefaultFinalizer.return_path(&cfg, &j);
    assert_eq!(
        verp().decode(rp.trim_start_matches("bounces+").split('@').next().unwrap()),
        Some(j.msg_id())
    );
    let r = verify(&raw, &dns).await;
    assert!(r.iter().all(|x| x.1 == DkimResult::Pass));
    for (_, _, h) in &r {
        assert_eq!(
            h.iter().filter(|s| s.eq_ignore_ascii_case("from")).count(),
            2,
            "From listed twice in h=: {h:?}"
        );
    }
    // a second From header added in transit (display-name spoof) must break every signature
    let spoofed = format!(
        "From: ceo@mail.example.test\r\n{}",
        String::from_utf8(raw).unwrap()
    );
    assert!(
        verify(spoofed.as_bytes(), &dns)
            .await
            .iter()
            .all(|x| x.1 != DkimResult::Pass)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn caller_supplied_managed_headers_are_replaced() {
    let (cfg, dns) = setup(false);
    let b = MessageBuilder::new()
        .from("hello@mail.example.test".to_string())
        .to("reader@gmail.com".to_string())
        .subject("x")
        .message_id("attacker@evil.test".to_string())
        .header(
            "List-Unsubscribe",
            mail_builder::headers::raw::Raw::new("<https://evil.test/u>"),
        )
        .text_body("hi")
        .write_to_vec()
        .unwrap();
    let f = finalize(
        b,
        &cfg,
        &job(Stream::Transactional, Category::Transactional),
    )
    .unwrap();
    let s = String::from_utf8_lossy(&f.raw).to_string();
    assert!(
        !s.contains("evil.test") && !s.contains("List-Unsubscribe:"),
        "{s}"
    );
    assert_eq!(
        s.matches("\r\nMessage-ID:").count() + s.starts_with("Message-ID:") as usize,
        1
    );
    assert!(
        verify(&f.raw, &dns)
            .await
            .iter()
            .all(|x| x.1 == DkimResult::Pass)
    );
}
