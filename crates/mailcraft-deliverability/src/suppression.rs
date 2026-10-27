//! Suppression policy: turns bounce / complaint events into actions. Pure decisions; the caller
//! persists suppressions and applies pauses (see `warmup::Pacer::apply`).
//!
//! Rules (research/deliverability.md 4.1): hard -> suppress; 3 soft in 7 days -> suppress;
//! complaint -> suppress all marketing; block -> pause (sender, provider) and flag the sender,
//! NEVER suppress the recipient; auto-reply / delayed -> ignore.
use crate::bounce::BounceClass;
use crate::complaint::FeedbackKind;
use crate::provider::Provider;
use std::collections::HashMap;
use std::sync::Mutex;

const DAY: u64 = 86_400;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Every stream, including transactional (address is dead).
    All,
    /// Every marketing/lifecycle category; transactional still allowed.
    Marketing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    HardBounce,
    SoftBounceLimit,
    Complaint,
    Sunset,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suppression {
    pub tenant: String,
    pub address: String,
    pub scope: Scope,
    pub reason: Reason,
    pub at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Suppress(Suppression),
    /// Stop sending from `sender` (domain or IP) to `provider` until `until`.
    PauseSending {
        sender: String,
        provider: Provider,
        until: u64,
    },
    /// Operator alert: our reputation / config is the problem, not the recipient.
    FlagSender {
        sender: String,
        provider: Provider,
        detail: String,
    },
    Ignore,
}

/// Who sent what to whom. `sender` is the sending domain or IP the pacer keys on.
#[derive(Clone, Debug)]
pub struct EventCtx {
    pub tenant: String,
    pub recipient: String,
    pub sender: String,
    pub now: u64,
}

pub trait SoftBounceLog {
    /// Record a soft bounce; returns how many (including this one) fall at or after `since`.
    fn record_and_count(&self, tenant: &str, address: &str, at: u64, since: u64) -> usize;
}

#[derive(Default)]
pub struct MemorySoftLog(Mutex<HashMap<(String, String), Vec<u64>>>);

impl SoftBounceLog for MemorySoftLog {
    fn record_and_count(&self, tenant: &str, address: &str, at: u64, since: u64) -> usize {
        let mut m = self.0.lock().unwrap();
        let v = m
            .entry((tenant.into(), address.to_ascii_lowercase()))
            .or_default();
        v.push(at);
        v.retain(|t| *t >= since);
        v.len()
    }
}

/// Hook for engagement-based sunsetting; plug a smarter rule in later.
pub struct ContactActivity {
    pub tenant: String,
    pub address: String,
    pub last_engaged: u64,
    pub emails_since_engaged: u32,
}

pub trait SunsetRule {
    fn should_sunset(&self, c: &ContactActivity, now: u64) -> bool;
}

/// Default: no engagement for `days` and at least `min_sends` sent since.
pub struct InactivityRule {
    pub days: u64,
    pub min_sends: u32,
}

impl SunsetRule for InactivityRule {
    fn should_sunset(&self, c: &ContactActivity, now: u64) -> bool {
        now.saturating_sub(c.last_engaged) >= self.days * DAY
            && c.emails_since_engaged >= self.min_sends
    }
}

pub struct Policy {
    pub soft_limit: usize,
    pub soft_window_secs: u64,
    /// How long a block pauses (sender, provider). HEURISTIC default 6h; operator can lift.
    pub block_pause_secs: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            soft_limit: 3,
            soft_window_secs: 7 * DAY,
            block_pause_secs: 6 * 3600,
        }
    }
}

impl Policy {
    pub fn on_bounce(
        &self,
        log: &dyn SoftBounceLog,
        ctx: &EventCtx,
        class: BounceClass,
        detail: &str,
    ) -> Vec<Action> {
        let supp = |scope, reason| {
            Action::Suppress(Suppression {
                tenant: ctx.tenant.clone(),
                address: ctx.recipient.to_ascii_lowercase(),
                scope,
                reason,
                at: ctx.now,
            })
        };
        match class {
            BounceClass::Hard => vec![supp(Scope::All, Reason::HardBounce)],
            BounceClass::Soft => {
                let since = ctx.now.saturating_sub(self.soft_window_secs);
                let n = log.record_and_count(&ctx.tenant, &ctx.recipient, ctx.now, since);
                if n >= self.soft_limit {
                    vec![supp(Scope::All, Reason::SoftBounceLimit)]
                } else {
                    vec![Action::Ignore]
                }
            }
            BounceClass::Block => {
                let provider = Provider::from_address(&ctx.recipient);
                vec![
                    Action::PauseSending {
                        sender: ctx.sender.clone(),
                        provider: provider.clone(),
                        until: ctx.now + self.block_pause_secs,
                    },
                    Action::FlagSender {
                        sender: ctx.sender.clone(),
                        provider,
                        detail: detail.to_string(),
                    },
                ]
            }
            BounceClass::AutoReply | BounceClass::Delayed => vec![Action::Ignore],
        }
    }

    pub fn on_complaint(&self, ctx: &EventCtx, kind: FeedbackKind) -> Vec<Action> {
        match kind {
            FeedbackKind::NotSpam => vec![Action::Ignore],
            // abuse / fraud / virus / other / opt-out: all mean "stop marketing to me"
            _ => vec![Action::Suppress(Suppression {
                tenant: ctx.tenant.clone(),
                address: ctx.recipient.to_ascii_lowercase(),
                scope: Scope::Marketing,
                reason: Reason::Complaint,
                at: ctx.now,
            })],
        }
    }

    pub fn on_sunset_check(&self, rule: &dyn SunsetRule, c: &ContactActivity, now: u64) -> Action {
        if rule.should_sunset(c, now) {
            Action::Suppress(Suppression {
                tenant: c.tenant.clone(),
                address: c.address.to_ascii_lowercase(),
                scope: Scope::Marketing,
                reason: Reason::Sunset,
                at: now,
            })
        } else {
            Action::Ignore
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ctx(now: u64) -> EventCtx {
        EventCtx {
            tenant: "t".into(),
            recipient: "Bob@gmail.com".into(),
            sender: "203.0.113.5".into(),
            now,
        }
    }

    #[test]
    fn hard_suppresses_all() {
        let a =
            Policy::default().on_bounce(&MemorySoftLog::default(), &ctx(5), BounceClass::Hard, "");
        assert!(
            matches!(&a[0], Action::Suppress(s) if s.scope == Scope::All && s.reason == Reason::HardBounce && s.address == "bob@gmail.com")
        );
    }

    #[test]
    fn three_soft_in_seven_days() {
        let (p, log) = (Policy::default(), MemorySoftLog::default());
        let t = 100 * DAY;
        assert_eq!(
            p.on_bounce(&log, &ctx(t), BounceClass::Soft, ""),
            vec![Action::Ignore]
        );
        assert_eq!(
            p.on_bounce(&log, &ctx(t + 3 * DAY), BounceClass::Soft, ""),
            vec![Action::Ignore]
        );
        let a = p.on_bounce(&log, &ctx(t + 6 * DAY), BounceClass::Soft, "");
        assert!(matches!(&a[0], Action::Suppress(s) if s.reason == Reason::SoftBounceLimit));
        // spread beyond the window never trips it
        let log2 = MemorySoftLog::default();
        for i in 0..5 {
            assert_eq!(
                p.on_bounce(&log2, &ctx(t + i * 8 * DAY), BounceClass::Soft, ""),
                vec![Action::Ignore]
            );
        }
    }

    #[test]
    fn block_pauses_and_never_suppresses() {
        let a = Policy::default().on_bounce(
            &MemorySoftLog::default(),
            &ctx(1000),
            BounceClass::Block,
            "5.7.1 Spamhaus",
        );
        assert!(a.iter().all(|x| !matches!(x, Action::Suppress(_))));
        assert!(a.contains(&Action::PauseSending {
            sender: "203.0.113.5".into(),
            provider: Provider::Gmail,
            until: 1000 + 6 * 3600
        }));
        assert!(a.iter().any(|x| matches!(x, Action::FlagSender { .. })));
    }

    #[test]
    fn complaint_and_ignores() {
        let p = Policy::default();
        let a = p.on_complaint(&ctx(1), FeedbackKind::Abuse);
        assert!(
            matches!(&a[0], Action::Suppress(s) if s.scope == Scope::Marketing && s.reason == Reason::Complaint)
        );
        assert_eq!(
            p.on_complaint(&ctx(1), FeedbackKind::NotSpam),
            vec![Action::Ignore]
        );
        let l = MemorySoftLog::default();
        assert_eq!(
            p.on_bounce(&l, &ctx(1), BounceClass::AutoReply, ""),
            vec![Action::Ignore]
        );
        assert_eq!(
            p.on_bounce(&l, &ctx(1), BounceClass::Delayed, ""),
            vec![Action::Ignore]
        );
    }

    #[test]
    fn sunset_hook() {
        let rule = InactivityRule {
            days: 180,
            min_sends: 10,
        };
        let c = ContactActivity {
            tenant: "t".into(),
            address: "a@b.c".into(),
            last_engaged: 0,
            emails_since_engaged: 12,
        };
        let p = Policy::default();
        assert!(
            matches!(p.on_sunset_check(&rule, &c, 181 * DAY), Action::Suppress(s) if s.reason == Reason::Sunset)
        );
        assert_eq!(p.on_sunset_check(&rule, &c, 100 * DAY), Action::Ignore);
    }
}
