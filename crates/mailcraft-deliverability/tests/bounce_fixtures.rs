mod common;
use common::*;
use mailcraft_deliverability::{
    Provider,
    bounce::{self, BounceClass::*},
};

// (fixture, class, enhanced status, recipient, carries verified VERP)
const CASES: &[(&str, bounce::BounceClass, Option<&str>, Option<&str>)] = &[
    (
        "postfix_user_unknown",
        Hard,
        Some("5.1.1"),
        Some("ghost@corp.example.org"),
    ),
    (
        "gmail_no_such_user",
        Hard,
        Some("5.1.1"),
        Some("nobody.here@gmail.com"),
    ),
    (
        "gmail_block_5_7_26",
        Block,
        Some("5.7.26"),
        Some("someone@gmail.com"),
    ),
    (
        "gmail_content_spam",
        Block,
        Some("5.7.1"),
        Some("other@gmail.com"),
    ),
    (
        "outlook_recipient_not_found",
        Hard,
        Some("5.1.10"),
        Some("gone@contoso-example.test"),
    ),
    (
        "outlook_block_spamhaus",
        Block,
        Some("5.7.1"),
        Some("person@hotmail.com"),
    ),
    (
        "outlook_5_7_515",
        Block,
        Some("5.7.515"),
        Some("auth@outlook.com"),
    ),
    (
        "yahoo_block_bl21",
        Block,
        Some("5.7.1"),
        Some("fan@yahoo.com"),
    ),
    (
        "postfix_mailbox_full",
        Soft,
        Some("5.2.2"),
        Some("full@corp.example.org"),
    ),
    (
        "postfix_timeout",
        Soft,
        Some("4.4.1"),
        Some("slow@slow-example.org"),
    ),
    (
        "postfix_delayed",
        Delayed,
        Some("4.4.1"),
        Some("slow@slow-example.org"),
    ),
    // non-standard (no delivery-status part)
    (
        "exchange_legacy_ndr",
        Hard,
        Some("5.1.1"),
        Some("former.employee@legacy-exchange.test"),
    ),
    (
        "yahoo_plain_nonexistent",
        Hard,
        None,
        Some("closed.account@yahoo.com"),
    ),
    (
        "gmail_plain_legacy",
        Hard,
        Some("5.1.1"),
        Some("typo.name@gmail.com"),
    ),
    ("outofoffice_autoreply", AutoReply, None, None),
];

#[test]
fn every_fixture_classifies_and_maps_to_the_message() {
    for (name, class, status, rcpt) in CASES {
        let b =
            bounce::parse(&fixture(name), &verp()).unwrap_or_else(|| panic!("{name}: not parsed"));
        assert_eq!(b.class, *class, "{name}: {b:?}");
        assert_eq!(b.status.as_deref(), *status, "{name}");
        assert_eq!(b.recipient.as_deref(), *rcpt, "{name}");
        assert_eq!(b.msg_id.as_deref(), Some(MSG_ID), "{name}: VERP -> message");
        assert!(b.verp_verified, "{name}");
    }
}

#[test]
fn successful_dsn_is_not_a_bounce() {
    assert!(bounce::parse(&fixture("delivered_success"), &verp()).is_none());
}

#[test]
fn block_never_looks_like_a_recipient_problem() {
    for n in [
        "gmail_block_5_7_26",
        "gmail_content_spam",
        "outlook_block_spamhaus",
        "yahoo_block_bl21",
        "outlook_5_7_515",
    ] {
        assert_eq!(
            bounce::parse(&fixture(n), &verp()).unwrap().class,
            Block,
            "{n}"
        );
    }
}

#[test]
fn provider_is_derived_from_recipient() {
    let b = bounce::parse(&fixture("outlook_block_spamhaus"), &verp()).unwrap();
    assert_eq!(b.provider, Some(Provider::Microsoft));
}

#[test]
fn forged_verp_token_is_not_trusted() {
    let raw = String::from_utf8(fixture("postfix_user_unknown")).unwrap();
    let forged = raw.replace(&verp().encode(MSG_ID), "0123456789abcdef01234567.AAAAAAAA");
    let b = bounce::parse(forged.as_bytes(), &verp()).unwrap();
    // The returned Message-ID still maps, but unauthenticated: callers must not suppress on it.
    assert!(!b.verp_verified);
}

#[test]
fn unrelated_mail_is_ignored() {
    let m = b"From: a@b.test\r\nTo: bounces@x.test\r\nSubject: hello\r\n\r\nhi\r\n";
    assert!(bounce::parse(m, &verp()).is_none());
}
