//! Retry schedule for 4xx/timeout (deliverability.md 3.4, rust-stack.md 4).
use std::time::Duration;

const MIN: u64 = 60;
/// +5m, 15m, 30m, 1h, 2h, 4h, 8h, 16h, then every 24h.
const STEPS: [u64; 8] = [
    5 * MIN,
    15 * MIN,
    30 * MIN,
    60 * MIN,
    120 * MIN,
    240 * MIN,
    480 * MIN,
    960 * MIN,
];

/// Delay before attempt number `attempt` (1-based = first retry). `jitter` in 0.0..1.0
/// adds up to 20% so a burst of deferrals does not retry in lockstep.
pub fn backoff(attempt: u32, jitter: f64) -> Duration {
    let base = STEPS
        .get(attempt.saturating_sub(1) as usize)
        .copied()
        .unwrap_or(24 * 60 * MIN);
    Duration::from_secs_f64(base as f64 * (1.0 + 0.2 * jitter.clamp(0.0, 1.0)))
}

/// 4xx and connection errors defer; 5xx is permanent (never retried).
pub fn is_permanent(smtp_code: u16) -> bool {
    (500..600).contains(&smtp_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_grows_then_caps_at_a_day() {
        assert_eq!(backoff(1, 0.0), Duration::from_secs(300));
        assert_eq!(backoff(8, 0.0), Duration::from_secs(16 * 3600));
        assert_eq!(backoff(9, 0.0), Duration::from_secs(24 * 3600));
        assert_eq!(backoff(50, 0.0), Duration::from_secs(24 * 3600));
    }

    #[test]
    fn five_hundreds_are_permanent() {
        assert!(is_permanent(550));
        assert!(!is_permanent(451));
    }
}
