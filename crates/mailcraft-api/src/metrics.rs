use prometheus::{Encoder, HistogramVec, IntCounterVec, IntGaugeVec, Opts, Registry, TextEncoder};

pub struct Metrics {
    pub registry: Registry,
    pub http_requests: IntCounterVec,
    pub http_duration: HistogramVec,
    pub policy_decisions: IntCounterVec,
    pub emails: IntCounterVec,
    pub webhook_deliveries: IntCounterVec,
    pub approvals_pending: IntGaugeVec,
    pub kill_switch: IntGaugeVec,
    pub queue_depth: IntGaugeVec,
}

impl Metrics {
    pub fn new() -> Self {
        let r = Registry::new();
        let c = |n: &str, h: &str, l: &[&str]| {
            let m = IntCounterVec::new(Opts::new(n, h), l).unwrap();
            r.register(Box::new(m.clone())).unwrap();
            m
        };
        let g = |n: &str, h: &str, l: &[&str]| {
            let m = IntGaugeVec::new(Opts::new(n, h), l).unwrap();
            r.register(Box::new(m.clone())).unwrap();
            m
        };
        let http_duration = HistogramVec::new(
            prometheus::HistogramOpts::new(
                "mailcraft_http_request_duration_seconds",
                "HTTP latency",
            ),
            &["route"],
        )
        .unwrap();
        r.register(Box::new(http_duration.clone())).unwrap();
        Self {
            http_requests: c(
                "mailcraft_http_requests_total",
                "HTTP requests",
                &["route", "status"],
            ),
            policy_decisions: c(
                "mailcraft_policy_decisions_total",
                "Policy decisions",
                &["decision", "action"],
            ),
            emails: c(
                "mailcraft_emails_total",
                "Emails accepted by the API",
                &["stream", "status", "transport", "env"],
            ),
            webhook_deliveries: c(
                "mailcraft_webhook_deliveries_total",
                "Webhook delivery attempts",
                &["status", "attempt"],
            ),
            approvals_pending: g(
                "mailcraft_approvals_pending",
                "Pending approvals",
                &["kind"],
            ),
            kill_switch: g(
                "mailcraft_kill_switch",
                "1 = a workspace kill switch is engaged",
                &[],
            ),
            queue_depth: g(
                "mailcraft_queue_depth",
                "Queued emails",
                &["status", "stream"],
            ),
            http_duration,
            registry: r,
        }
    }

    pub fn render(&self) -> String {
        let mut buf = Vec::new();
        TextEncoder::new()
            .encode(&self.registry.gather(), &mut buf)
            .ok();
        String::from_utf8(buf).unwrap_or_default()
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}
