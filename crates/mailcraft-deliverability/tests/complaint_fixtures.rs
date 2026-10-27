mod common;
use common::*;
use mailcraft_deliverability::{
    Provider,
    complaint::{self, FeedbackKind},
};

#[test]
fn yahoo_cfl_maps_via_verp_and_returned_to() {
    let c = complaint::parse(&fixture("arf_yahoo_cfl"), &verp()).unwrap();
    assert_eq!(c.kind, FeedbackKind::Abuse);
    assert_eq!(c.msg_id.as_deref(), Some(MSG_ID));
    assert!(c.verp_verified);
    assert_eq!(
        c.recipient.as_deref(),
        Some("complainer@yahoo.com"),
        "Original-Rcpt-To redacted -> returned To:"
    );
    assert_eq!(c.provider, Some(Provider::Yahoo));
    assert_eq!(c.source_ip.as_deref(), Some("203.0.113.5"));
}

#[test]
fn microsoft_jmrp() {
    let c = complaint::parse(&fixture("arf_microsoft_jmrp"), &verp()).unwrap();
    assert_eq!(c.kind, FeedbackKind::Abuse);
    assert_eq!(c.recipient.as_deref(), Some("angry.reader@hotmail.com"));
    assert_eq!(c.provider, Some(Provider::Microsoft));
    assert_eq!(c.msg_id.as_deref(), Some(MSG_ID));
}

#[test]
fn not_spam_and_optout_kinds() {
    assert_eq!(
        complaint::parse(&fixture("arf_not_spam"), &verp())
            .unwrap()
            .kind,
        FeedbackKind::NotSpam
    );
    assert_eq!(
        complaint::parse(&fixture("arf_optout"), &verp())
            .unwrap()
            .kind,
        FeedbackKind::OptOut
    );
}

#[test]
fn a_dsn_is_not_an_arf() {
    assert!(complaint::parse(&fixture("postfix_user_unknown"), &verp()).is_none());
}
