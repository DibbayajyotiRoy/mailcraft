//! Inbound event -> policy -> actions -> pacer, using the fixtures end to end.
mod common;
use common::*;
use mailcraft_deliverability::{
    Provider,
    bounce::{self, MessageLookup, SentMessage},
    complaint,
    suppression::{Action, EventCtx, MemorySoftLog, Policy, Reason, Scope},
    warmup::{Decision, MemoryCounters, Pacer, RampProfile, WarmupPlan},
};
use std::collections::HashMap;

const NOW: u64 = 20_000 * 86_400 + 100;

fn store() -> HashMap<String, SentMessage> {
    HashMap::from([(
        MSG_ID.to_string(),
        SentMessage {
            tenant: "t1".into(),
            recipient: "x@gmail.com".into(),
            sender: "203.0.113.5".into(),
        },
    )])
}

fn ctx(m: &SentMessage, recipient: Option<String>) -> EventCtx {
    EventCtx {
        tenant: m.tenant.clone(),
        recipient: recipient.unwrap_or_else(|| m.recipient.clone()),
        sender: m.sender.clone(),
        now: NOW,
    }
}

#[test]
fn hard_bounce_suppresses_recipient() {
    let b = bounce::parse(&fixture("gmail_no_such_user"), &verp()).unwrap();
    let m = store().find(b.msg_id.as_deref().unwrap()).unwrap();
    let a = Policy::default().on_bounce(
        &MemorySoftLog::default(),
        &ctx(&m, b.recipient),
        b.class,
        &b.diagnostic,
    );
    assert!(
        matches!(&a[0], Action::Suppress(s) if s.reason == Reason::HardBounce && s.address == "nobody.here@gmail.com")
    );
}

#[tokio::test]
async fn block_bounce_pauses_the_pair_and_the_pacer_honours_it() {
    let b = bounce::parse(&fixture("outlook_block_spamhaus"), &verp()).unwrap();
    let m = store().find(b.msg_id.as_deref().unwrap()).unwrap();
    let a = Policy::default().on_bounce(
        &MemorySoftLog::default(),
        &ctx(&m, b.recipient),
        b.class,
        &b.diagnostic,
    );
    assert!(
        a.iter().all(|x| !matches!(x, Action::Suppress(_))),
        "recipient must NOT be suppressed"
    );

    let pacer = Pacer::new(MemoryCounters::default());
    let plan = WarmupPlan {
        start: NOW,
        profile: RampProfile::Ip,
        target_daily: 1_000_000,
        first_week_cap: None,
    };
    for x in &a {
        pacer.apply(x).await;
    }
    assert!(matches!(
        pacer
            .try_acquire("203.0.113.5", &Provider::Microsoft, &plan, NOW + 60)
            .await,
        Decision::Paused { .. }
    ));
    assert!(matches!(
        pacer
            .try_acquire("203.0.113.5", &Provider::Gmail, &plan, NOW + 60)
            .await,
        Decision::Send { .. }
    ));
}

#[test]
fn soft_bounces_accumulate_to_suppression() {
    let p = Policy::default();
    let log = MemorySoftLog::default();
    let b = bounce::parse(&fixture("postfix_mailbox_full"), &verp()).unwrap();
    let m = store().find(b.msg_id.as_deref().unwrap()).unwrap();
    let mut last = vec![];
    for i in 0..3 {
        let mut c = ctx(&m, b.recipient.clone());
        c.now += i * 86_400;
        last = p.on_bounce(&log, &c, b.class, "");
    }
    assert!(matches!(&last[0], Action::Suppress(s) if s.reason == Reason::SoftBounceLimit));
}

#[test]
fn complaint_suppresses_marketing_only() {
    let c = complaint::parse(&fixture("arf_yahoo_cfl"), &verp()).unwrap();
    let m = store().find(c.msg_id.as_deref().unwrap()).unwrap();
    let a = Policy::default().on_complaint(&ctx(&m, c.recipient), c.kind);
    assert!(
        matches!(&a[0], Action::Suppress(s) if s.scope == Scope::Marketing && s.reason == Reason::Complaint && s.address == "complainer@yahoo.com")
    );
}

#[test]
fn autoreply_and_delayed_do_nothing() {
    for n in ["outofoffice_autoreply", "postfix_delayed"] {
        let b = bounce::parse(&fixture(n), &verp()).unwrap();
        let m = store().find(b.msg_id.as_deref().unwrap()).unwrap();
        assert_eq!(
            Policy::default().on_bounce(
                &MemorySoftLog::default(),
                &ctx(&m, b.recipient),
                b.class,
                ""
            ),
            vec![Action::Ignore]
        );
    }
}
