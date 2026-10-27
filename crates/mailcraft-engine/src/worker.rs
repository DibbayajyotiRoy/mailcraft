use crate::{
    limits::Limits,
    metrics::Metrics,
    mime::{self, MimeParts},
    traits::{
        db_err, FinalizeCtx, Finalizer, NoopFinalizer, PgSuppressions, ResolvedTransport,
        SuppressionCheck, TransportResolver,
    },
    verp_mail_from,
};
use chrono::{DateTime, Datelike, Timelike, Utc};
use mailcraft_core::{retry, Result, Stream};
use mailcraft_transport::{
    CapStore, ErrorClass, Outbound, Sandbox, SandboxOutcome, SendReceipt, TransportError,
};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};
use tokio::sync::watch;
use uuid::Uuid;

/// Claim due rows. Fairness: at most `$4` rows per destination domain per pass, so one slow
/// domain cannot take the whole batch. Gated rows are pushed, not retried (`attempts` refunded).
/// ponytail: the ranking scans the whole due set; add a LIMIT'd candidate window if backlogs reach millions.
pub const CLAIM_SQL: &str = "\
WITH claimed AS (
  UPDATE emails SET status = 'sending', locked_by = $1,
         locked_until = now() + make_interval(secs => $3), attempts = attempts + 1
  WHERE id IN (
    SELECT id FROM emails
    WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY rcpt_domain ORDER BY next_attempt_at) AS rn
        FROM emails WHERE status IN ('queued','deferred') AND next_attempt_at <= now()) ranked
      WHERE rn <= $4)
    AND status IN ('queued','deferred') AND next_attempt_at <= now()
    ORDER BY next_attempt_at
    FOR UPDATE SKIP LOCKED
    LIMIT $2)
  RETURNING *)
SELECT e.id, e.workspace_id, e.api_key_id, e.domain_id, e.transport_id, e.stream, e.env,
       e.from_addr, e.to_addr, e.cc, e.reply_to, e.subject, e.headers, e.attempts, e.max_age_at,
       e.created_at, e.rcpt_domain, e.message_id,
       b.html, b.text, w.kill_switch, k.daily_send_cap, k.minute_send_cap,
       d.return_path_host
FROM claimed e
JOIN workspaces w ON w.id = e.workspace_id
LEFT JOIN email_bodies b ON b.email_id = e.id
LEFT JOIN api_keys k ON k.id = e.api_key_id
LEFT JOIN domains d ON d.id = e.domain_id";

#[derive(sqlx::FromRow, Debug)]
struct Job {
    id: Uuid,
    workspace_id: Uuid,
    api_key_id: Option<Uuid>,
    domain_id: Option<Uuid>,
    transport_id: Option<Uuid>,
    stream: String,
    env: String,
    from_addr: String,
    to_addr: String,
    cc: Vec<String>,
    reply_to: Option<String>,
    subject: String,
    headers: serde_json::Value,
    attempts: i32,
    max_age_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    rcpt_domain: Option<String>,
    message_id: Option<String>,
    html: Option<String>,
    text: Option<String>,
    kill_switch: bool,
    daily_send_cap: Option<i32>,
    minute_send_cap: Option<i32>,
    return_path_host: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Concurrent claim loops.
    pub workers: usize,
    /// Rows claimed per pass per worker.
    pub batch: i64,
    /// Max rows of one destination domain in one claim pass.
    pub per_domain_batch: i64,
    pub lease: Duration,
    pub poll: Duration,
    pub reaper_interval: Duration,
    pub send_timeout: Duration,
    /// Messages per destination domain per minute per egress; 0 = unlimited.
    pub dest_per_minute: u32,
    /// Per sending-domain daily cap (workspace-wide default); `None` = unlimited.
    pub domain_daily_cap: Option<u32>,
    /// Give up after this when `emails.max_age_at` is NULL (SPEC: 72 h).
    pub default_max_age: Duration,
    /// How long an Auth failure pauses a transport.
    pub pause_ttl: Duration,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            workers: 4,
            batch: 10,
            per_domain_batch: 5,
            lease: Duration::from_secs(300),
            poll: Duration::from_secs(1),
            reaper_interval: Duration::from_secs(30),
            send_timeout: Duration::from_secs(120),
            dest_per_minute: 60,
            domain_daily_cap: None,
            default_max_age: Duration::from_secs(72 * 3600),
            pause_ttl: Duration::from_secs(900),
        }
    }
}

pub struct Engine {
    pool: PgPool,
    cfg: EngineConfig,
    resolver: Arc<dyn TransportResolver>,
    finalizer: Arc<dyn Finalizer>,
    suppress: Arc<dyn SuppressionCheck>,
    limits: Arc<Limits>,
    sandbox: Arc<Sandbox>,
    pub metrics: Arc<Metrics>,
}

struct Event {
    ty: &'static str,
    bounce_class: Option<&'static str>,
    enhanced: Option<String>,
    diagnostic: Option<String>,
}

impl Event {
    fn new(ty: &'static str) -> Self {
        Self {
            ty,
            bounce_class: None,
            enhanced: None,
            diagnostic: None,
        }
    }
}

#[derive(Default)]
struct Transition {
    status: &'static str,
    /// Seconds until the next attempt (deferrals).
    next_in: Option<f64>,
    /// Gates and non-failures do not consume an attempt.
    refund: bool,
    provider_message_id: Option<String>,
    message_id: Option<String>,
    transport_id: Option<Uuid>,
    last_error: Option<String>,
    mark_sent: bool,
    suppress_reason: Option<&'static str>,
    events: Vec<Event>,
}

enum Gate {
    Pass,
    Defer(f64, &'static str),
}

impl Engine {
    pub fn new(pool: PgPool, resolver: Arc<dyn TransportResolver>) -> Self {
        Self {
            suppress: Arc::new(PgSuppressions(pool.clone())),
            pool,
            cfg: EngineConfig::default(),
            resolver,
            finalizer: Arc::new(NoopFinalizer),
            limits: Arc::new(Limits::in_process()),
            sandbox: Arc::new(Sandbox::new()),
            metrics: Arc::new(Metrics::default()),
        }
    }
    pub fn config(mut self, cfg: EngineConfig) -> Self {
        self.cfg = cfg;
        self
    }
    pub fn finalizer(mut self, f: Arc<dyn Finalizer>) -> Self {
        self.finalizer = f;
        self
    }
    pub fn suppression(mut self, s: Arc<dyn SuppressionCheck>) -> Self {
        self.suppress = s;
        self
    }
    pub fn limits(mut self, l: Arc<Limits>) -> Self {
        self.limits = l;
        self
    }
    pub fn sandbox(&self) -> &Sandbox {
        &self.sandbox
    }

    /// Run workers and the reaper until `shutdown` flips to true. Workers finish the batch they
    /// hold (in-flight sends complete), then exit; this returns once all have.
    pub async fn run(self: Arc<Self>, shutdown: watch::Receiver<bool>) {
        let mut tasks = tokio::task::JoinSet::new();
        for i in 0..self.cfg.workers.max(1) {
            let (e, rx) = (self.clone(), shutdown.clone());
            let id = format!("w-{}-{i}", Uuid::new_v4().simple());
            tasks.spawn(async move { e.worker_loop(id, rx).await });
        }
        let (e, rx) = (self.clone(), shutdown);
        tasks.spawn(async move { e.reaper_loop(rx).await });
        while tasks.join_next().await.is_some() {}
    }

    async fn sleep_or_shutdown(rx: &mut watch::Receiver<bool>, d: Duration) {
        tokio::select! { _ = tokio::time::sleep(d) => {}, _ = rx.changed() => {} }
    }

    async fn worker_loop(&self, id: String, mut shutdown: watch::Receiver<bool>) {
        while !*shutdown.borrow() {
            match self.tick(&id).await {
                Ok(0) => Self::sleep_or_shutdown(&mut shutdown, self.cfg.poll).await,
                Ok(_) => {}
                Err(e) => {
                    tracing::error!(worker = %id, error = %e, "claim failed");
                    Self::sleep_or_shutdown(&mut shutdown, self.cfg.poll * 5).await;
                }
            }
        }
    }

    async fn reaper_loop(&self, mut shutdown: watch::Receiver<bool>) {
        while !*shutdown.borrow() {
            if self
                .limits
                .try_lock("lock:reaper", self.cfg.reaper_interval)
                .await
            {
                if let Err(e) = self.reap().await {
                    tracing::error!(error = %e, "reaper failed");
                }
                if let Err(e) = self.refresh_gauges().await {
                    tracing::warn!(error = %e, "gauge refresh failed");
                }
            }
            Self::sleep_or_shutdown(&mut shutdown, self.cfg.reaper_interval).await;
        }
    }

    /// Requeue rows whose lease expired (crashed worker). `attempts` stays incremented: a crash
    /// between the transport call and the `sent` write may duplicate (documented limit, SPEC 8.3).
    pub async fn reap(&self) -> Result<u64> {
        let n = sqlx::query(
            "UPDATE emails SET status = 'deferred', locked_by = NULL, locked_until = NULL, next_attempt_at = now(),
                    last_error = 'lease expired (worker crashed or stalled)'
             WHERE status = 'sending' AND locked_until < now()",
        )
        .execute(&self.pool)
        .await
        .map_err(db_err)?
        .rows_affected();
        if n > 0 {
            tracing::warn!(requeued = n, "reaper requeued stuck emails");
        }
        Ok(n)
    }

    async fn refresh_gauges(&self) -> Result<()> {
        let rows: Vec<(String, String, i64, f64)> = sqlx::query_as(
            "SELECT status, stream, count(*), coalesce(extract(epoch FROM now() - min(next_attempt_at)), 0)::float8
             FROM emails WHERE status IN ('queued','deferred','sending') GROUP BY status, stream",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        for (status, stream, n, age) in rows {
            self.metrics.set(
                "mailcraft_queue_depth",
                &[("status", &status), ("stream", &stream)],
                n as f64,
            );
            if status != "sending" {
                self.metrics.set(
                    "mailcraft_queue_oldest_age_seconds",
                    &[("stream", &stream)],
                    age.max(0.0),
                );
            }
        }
        Ok(())
    }

    /// One claim pass; returns how many rows were claimed. Public for tests and embedding.
    pub async fn tick(&self, worker_id: &str) -> Result<usize> {
        let jobs: Vec<Job> = sqlx::query_as(CLAIM_SQL)
            .bind(worker_id)
            .bind(self.cfg.batch)
            .bind(self.cfg.lease.as_secs_f64())
            .bind(self.cfg.per_domain_batch)
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let n = jobs.len();
        for job in jobs {
            if let Err(e) = self.process(worker_id, &job).await {
                // DB trouble: leave the lease; the reaper requeues the row.
                tracing::error!(email = %job.id, error = %e, "processing failed");
            }
        }
        Ok(n)
    }

    async fn process(&self, wid: &str, job: &Job) -> Result<()> {
        let stream = if job.stream == "marketing" {
            Stream::Marketing
        } else {
            Stream::Transactional
        };
        let test = job.env == "test";
        let rcpt_domain = job.rcpt_domain.clone().unwrap_or_default();
        let sb_outcome = SandboxOutcome::for_rcpt(&job.to_addr);

        // 1. Gates that need no transport.
        self.metrics.set(
            "mailcraft_kill_switch",
            &[],
            f64::from(u8::from(job.kill_switch)),
        );
        if job.kill_switch {
            return self.defer(wid, job, 30.0, "kill switch engaged").await;
        }
        let suppressed = if test && sb_outcome == SandboxOutcome::Suppressed {
            true
        } else {
            match self
                .suppress
                .is_suppressed(job.workspace_id, &job.to_addr)
                .await
            {
                Ok(s) => s,
                Err(e) => {
                    return self
                        .defer(wid, job, 60.0, &format!("suppression check failed: {e}"))
                        .await
                }
            }
        };
        if suppressed {
            let t = Transition {
                status: "suppressed",
                events: vec![Event::new("suppressed")],
                ..Default::default()
            };
            return self.finish(wid, job, "none", t).await;
        }
        // Cc recipients share this row's transaction; suppression is applied per recipient and a
        // suppressed Cc is dropped from both the envelope and the header.
        let mut cc: Vec<String> = Vec::new();
        for c in &job.cc {
            let addr = mime::parse_mailbox(c).1;
            match self.suppress.is_suppressed(job.workspace_id, &addr).await {
                Ok(false) => cc.push(c.clone()),
                Ok(true) => {
                    tracing::info!(email = %job.id, rcpt = %addr, "cc recipient suppressed, dropped")
                }
                Err(e) => {
                    return self
                        .defer(wid, job, 60.0, &format!("suppression check failed: {e}"))
                        .await
                }
            }
        }
        let mut rcpts = vec![job.to_addr.clone()];
        rcpts.extend(cc.iter().map(|c| mime::parse_mailbox(c).1));
        let max_age = job
            .max_age_at
            .unwrap_or(job.created_at + self.cfg.default_max_age);
        if Utc::now() > max_age {
            return self
                .fail(
                    wid,
                    job,
                    "none",
                    "gave up: max age reached before delivery".into(),
                )
                .await;
        }

        // 2. Transport.
        let resolved: Option<ResolvedTransport> = if test {
            None
        } else {
            match self
                .resolver
                .resolve(job.workspace_id, job.transport_id)
                .await
            {
                Ok(Some(r)) => Some(r),
                Ok(None) => return self.defer(wid, job, 300.0, "no transport configured").await,
                Err(e) => {
                    return self
                        .defer(wid, job, 60.0, &format!("transport lookup failed: {e}"))
                        .await
                }
            }
        };
        let egress = resolved
            .as_ref()
            .map_or("sandbox", |r| r.name.as_str())
            .to_string();
        if self.limits.flag(&format!("paused:{egress}")).await {
            return self
                .defer(
                    wid,
                    job,
                    120.0,
                    &format!("transport {egress} is paused (auth failure); reconnect it"),
                )
                .await;
        }

        // 3. Caps and throttle (reservations, released unless the send is accepted).
        let mut reserved = Vec::new();
        match self
            .reserve(job, &egress, &rcpt_domain, test, &mut reserved)
            .await
        {
            Gate::Pass => {}
            Gate::Defer(secs, why) => {
                self.release(&reserved).await;
                if why == "throttle" {
                    self.metrics.inc(
                        "mailcraft_throttle_delays_total",
                        &[("rcpt_provider", provider_of(&rcpt_domain))],
                    );
                }
                return self.defer(wid, job, secs, why).await;
            }
        }

        // 4. MIME + finalize.
        let from_domain = mime::addr_domain(&mime::parse_mailbox(&job.from_addr).1).to_string();
        let message_id = job
            .message_id
            .as_deref()
            .map(|m| m.trim_matches(['<', '>']).to_string())
            .unwrap_or_else(|| format!("{}@{from_domain}", job.id.simple()));
        let raw = match mime::build(&MimeParts {
            from: &job.from_addr,
            to: &job.to_addr,
            cc: &cc,
            reply_to: job.reply_to.as_deref(),
            subject: &job.subject,
            text: job.text.as_deref(),
            html: job.html.as_deref(),
            headers: &job.headers,
            message_id: &message_id,
        }) {
            Ok(r) => r,
            Err(e) => {
                self.release(&reserved).await;
                return self.fail(wid, job, &egress, e).await;
            }
        };
        let ctx = FinalizeCtx {
            email_id: job.id,
            workspace_id: job.workspace_id,
            domain_id: job.domain_id,
            stream,
            from_domain,
        };
        let raw = match self.finalizer.finalize(&ctx, raw).await {
            Ok(r) => r,
            Err(e) => {
                self.release(&reserved).await;
                let err = TransportError::Temporary(format!("finalize: {e}"));
                return self
                    .on_error(wid, job, &egress, &rcpt_domain, max_age, err)
                    .await;
            }
        };
        let mail_from = match &job.return_path_host {
            Some(h) => verp_mail_from(job.id, h),
            None => mime::parse_mailbox(&job.from_addr).1,
        };
        let out = Outbound {
            email_id: job.id,
            stream,
            mail_from,
            rcpt_to: job.to_addr.clone(),
            raw,
        };

        // 5. Deliver.
        let result: std::result::Result<SendReceipt, TransportError> = if test {
            if sb_outcome == SandboxOutcome::Deferred && job.attempts <= 1 {
                Err(TransportError::Temporary(
                    "451 4.2.0 sandbox: try again later".into(),
                ))
            } else if sb_outcome == SandboxOutcome::Bounced {
                Err(TransportError::Permanent(
                    "550 5.1.1 sandbox: no such user".into(),
                ))
            } else {
                Ok(self.sandbox.accept(&out))
            }
        } else {
            let t = &resolved.as_ref().unwrap().transport;
            match tokio::time::timeout(self.cfg.send_timeout, t.submit_all(&out, &rcpts)).await {
                Ok(r) => r,
                Err(_) => Err(TransportError::Temporary("send timed out".into())),
            }
        };
        let tlabel = [
            ("transport", egress.as_str()),
            ("rcpt_provider", provider_of(&rcpt_domain)),
        ];
        match result {
            Ok(rc) => {
                self.metrics.inc(
                    "mailcraft_delivery_attempts_total",
                    &[tlabel[0], ("result", "accepted"), tlabel[1]],
                );
                let mut t = Transition {
                    status: "sent",
                    provider_message_id: rc.provider_message_id,
                    message_id: Some(message_id),
                    transport_id: resolved.as_ref().and_then(|r| r.id),
                    mark_sent: true,
                    events: vec![Event::new("sent")],
                    ..Default::default()
                };
                if test {
                    // Nothing leaves the box: the sandbox "delivers" immediately.
                    t.status = "delivered";
                    t.events.push(Event::new("delivered"));
                    if sb_outcome == SandboxOutcome::Complained {
                        t.events.push(Event::new("complained"));
                        t.suppress_reason = Some("complaint");
                    }
                }
                self.finish(wid, job, &egress, t).await
            }
            Err(err) => {
                self.release(&reserved).await;
                let r = match err.class() {
                    ErrorClass::Permanent => "rejected",
                    _ => "deferred",
                };
                self.metrics.inc(
                    "mailcraft_delivery_attempts_total",
                    &[tlabel[0], ("result", r), tlabel[1]],
                );
                self.on_error(wid, job, &egress, &rcpt_domain, max_age, err)
                    .await
            }
        }
    }

    /// Error-class policy: Permanent -> failed/bounced, Temporary -> backoff, RateLimited ->
    /// retry_after (not an attempt), Auth -> pause the transport + alert job (not an attempt).
    async fn on_error(
        &self,
        wid: &str,
        job: &Job,
        egress: &str,
        rcpt_domain: &str,
        max_age: DateTime<Utc>,
        err: TransportError,
    ) -> Result<()> {
        let reason = err.to_string();
        let code = err.smtp_code();
        if matches!(code, Some(421 | 451 | 452)) {
            // Adaptive throttle: slow this destination down for a while.
            self.limits
                .set_flag(&format!("pen:{egress}:{rcpt_domain}"), 600)
                .await;
        }
        match &err {
            TransportError::Permanent(_) => {
                let diag = Some(reason.clone());
                if code.is_some_and(|c| (500..600).contains(&c)) {
                    let enhanced = err.enhanced_code();
                    let (class, suppress) = match enhanced.as_deref() {
                        Some(e) if e.starts_with("5.7") => ("block", None), // our problem, not the recipient's
                        Some(e)
                            if e.starts_with("5.2")
                                || e.starts_with("5.3")
                                || e.starts_with("5.4") =>
                        {
                            ("soft", None)
                        }
                        _ => ("hard", Some("hard_bounce")),
                    };
                    let ev = Event {
                        ty: "bounced",
                        bounce_class: Some(class),
                        enhanced,
                        diagnostic: diag,
                    };
                    let t = Transition {
                        status: "bounced",
                        last_error: Some(reason),
                        suppress_reason: suppress,
                        events: vec![ev],
                        ..Default::default()
                    };
                    self.finish(wid, job, egress, t).await
                } else {
                    self.fail(wid, job, egress, reason).await
                }
            }
            TransportError::Temporary(_) => {
                let delay = retry::backoff(job.attempts.max(1) as u32, rand::random::<f64>());
                if Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default() > max_age {
                    return self
                        .fail(
                            wid,
                            job,
                            egress,
                            format!("gave up after {} attempts: {reason}", job.attempts),
                        )
                        .await;
                }
                let mut events = vec![];
                if job.attempts <= 1 {
                    events.push(Event {
                        diagnostic: Some(reason.clone()),
                        ..Event::new("delivery_delayed")
                    });
                }
                let t = Transition {
                    status: "deferred",
                    next_in: Some(delay.as_secs_f64()),
                    last_error: Some(reason),
                    events,
                    ..Default::default()
                };
                self.finish(wid, job, egress, t).await
            }
            TransportError::RateLimited { retry_after, .. } => {
                let secs = retry_after.map_or(300.0, |d| d.as_secs_f64().max(30.0))
                    + rand::random::<f64>() * 10.0;
                let t = Transition {
                    status: "deferred",
                    next_in: Some(secs),
                    refund: true,
                    last_error: Some(reason),
                    ..Default::default()
                };
                self.finish(wid, job, egress, t).await
            }
            TransportError::Auth(_) => {
                let key = format!("paused:{egress}");
                if !self.limits.flag(&key).await {
                    self.limits
                        .set_flag(&key, self.cfg.pause_ttl.as_secs())
                        .await;
                    self.metrics
                        .inc("mailcraft_transport_paused_total", &[("transport", egress)]);
                    tracing::error!(transport = egress, %reason, "transport paused after auth failure");
                    let _ = sqlx::query("INSERT INTO jobs (queue, payload) VALUES ('alerts', $1)")
                        .bind(serde_json::json!({
                            "kind": "transport_paused", "workspace_id": job.workspace_id,
                            "transport": egress, "transport_id": job.transport_id, "reason": reason,
                        }))
                        .execute(&self.pool)
                        .await;
                }
                let t = Transition {
                    status: "deferred",
                    next_in: Some(self.cfg.pause_ttl.as_secs_f64()),
                    refund: true,
                    last_error: Some(reason),
                    ..Default::default()
                };
                self.finish(wid, job, egress, t).await
            }
        }
    }

    async fn fail(&self, wid: &str, job: &Job, egress: &str, reason: String) -> Result<()> {
        let ev = Event {
            diagnostic: Some(reason.clone()),
            ..Event::new("failed")
        };
        let t = Transition {
            status: "failed",
            last_error: Some(reason),
            events: vec![ev],
            ..Default::default()
        };
        self.finish(wid, job, egress, t).await
    }

    /// Gate deferral: push `next_attempt_at`, no retry count, no event.
    async fn defer(&self, wid: &str, job: &Job, secs: f64, why: &str) -> Result<()> {
        let t = Transition {
            status: "deferred",
            next_in: Some(secs),
            refund: true,
            last_error: Some(why.to_string()),
            ..Default::default()
        };
        self.finish(wid, job, "none", t).await
    }

    /// Apply a transition under the lease guard (`locked_by` + `status='sending'`): if the reaper
    /// already took the row, nothing is written. Events and suppression ride the same transaction.
    async fn finish(&self, wid: &str, job: &Job, egress: &str, t: Transition) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db_err)?;
        let n = sqlx::query(
            "UPDATE emails SET status = $3,
                    next_attempt_at = CASE WHEN $4::float8 IS NULL THEN next_attempt_at ELSE now() + make_interval(secs => $4) END,
                    attempts = attempts - $5::int,
                    provider_message_id = COALESCE($6, provider_message_id),
                    message_id = COALESCE($7, message_id),
                    transport_id = COALESCE(transport_id, $8),
                    last_error = $9,
                    sent_at = CASE WHEN $10 THEN now() ELSE sent_at END,
                    locked_by = NULL, locked_until = NULL
             WHERE id = $1 AND locked_by = $2 AND status = 'sending'",
        )
        .bind(job.id)
        .bind(wid)
        .bind(t.status)
        .bind(t.next_in)
        .bind(i32::from(t.refund))
        .bind(&t.provider_message_id)
        .bind(&t.message_id)
        .bind(t.transport_id)
        .bind(&t.last_error)
        .bind(t.mark_sent)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?
        .rows_affected();
        if n == 0 {
            tracing::warn!(email = %job.id, "lease lost before the outcome was recorded; leaving it to the reaper");
            return Ok(());
        }
        for e in &t.events {
            sqlx::query(
                "INSERT INTO email_events (workspace_id, email_id, type, bounce_class, enhanced_code, diagnostic)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(job.workspace_id)
            .bind(job.id)
            .bind(e.ty)
            .bind(e.bounce_class)
            .bind(&e.enhanced)
            .bind(&e.diagnostic)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        }
        if let Some(reason) = t.suppress_reason {
            sqlx::query(
                "INSERT INTO suppressions (workspace_id, email, reason, source, email_id) VALUES ($1, lower($2), $3, 'engine', $4)
                 ON CONFLICT DO NOTHING",
            )
            .bind(job.workspace_id)
            .bind(&job.to_addr)
            .bind(reason)
            .bind(job.id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        }
        tx.commit().await.map_err(db_err)?;
        if !matches!(t.status, "deferred") {
            self.metrics.inc(
                "mailcraft_emails_total",
                &[
                    ("stream", &job.stream),
                    ("status", t.status),
                    ("transport", egress),
                    ("env", &job.env),
                ],
            );
            if t.status == "bounced" {
                let class = t
                    .events
                    .first()
                    .and_then(|e| e.bounce_class)
                    .unwrap_or("hard");
                self.metrics.inc(
                    "mailcraft_bounces_total",
                    &[("class", class), ("stream", &job.stream)],
                );
            }
            if t.suppress_reason == Some("complaint") {
                self.metrics
                    .inc("mailcraft_complaints_total", &[("stream", &job.stream)]);
            }
        }
        Ok(())
    }

    async fn release(&self, keys: &[String]) {
        for k in keys {
            self.limits.decr(k).await;
        }
    }

    /// Key / domain caps and the per-destination throttle. Redis counters are reservations,
    /// released by the caller when the send is not accepted.
    async fn reserve(
        &self,
        job: &Job,
        egress: &str,
        rcpt_domain: &str,
        test: bool,
        res: &mut Vec<String>,
    ) -> Gate {
        let now = Utc::now();
        let day = format!("{:04}{:02}{:02}", now.year(), now.month(), now.day());
        let to_midnight = f64::from(86_400 - now.num_seconds_from_midnight()) + 5.0;
        let to_minute = f64::from(61 - now.second());
        let redis = self.limits.has_redis();

        // (scope key, ttl, cap, defer secs, PG column + id + window for the no-Redis fallback)
        let mut caps: Vec<(String, u64, i64, f64, &str, Uuid, &str)> = vec![];
        if let (Some(k), Some(c)) = (job.api_key_id, job.daily_send_cap) {
            caps.push((
                format!("cap:{k}:{day}"),
                172_800,
                c.into(),
                to_midnight,
                "api_key_id",
                k,
                "24 hours",
            ));
        }
        if let (Some(k), Some(c)) = (job.api_key_id, job.minute_send_cap) {
            caps.push((
                format!("capm:{k}:{}", now.timestamp() / 60),
                70,
                c.into(),
                to_minute,
                "api_key_id",
                k,
                "1 minute",
            ));
        }
        if let (Some(d), Some(c)) = (job.domain_id, self.cfg.domain_daily_cap) {
            caps.push((
                format!("capd:{d}:{day}"),
                172_800,
                c.into(),
                to_midnight,
                "domain_id",
                d,
                "24 hours",
            ));
        }
        for (key, ttl, cap, secs, col, id, window) in caps {
            let over = if redis {
                let n = self.limits.incr(&key, ttl).await;
                res.push(key);
                n > cap
            } else {
                // Redis absent: count in Postgres (includes this row, which is 'sending').
                let q = format!("SELECT count(*) FROM emails WHERE {col} = $1 AND (status = 'sending' OR sent_at > now() - interval '{window}')");
                match sqlx::query_scalar::<_, i64>(&q)
                    .bind(id)
                    .fetch_one(&self.pool)
                    .await
                {
                    Ok(n) => n > cap,
                    Err(e) => {
                        tracing::warn!(error = %e, "cap count failed");
                        false
                    }
                }
            };
            if over {
                return Gate::Defer(secs, "send cap reached");
            }
        }

        if !test && self.cfg.dest_per_minute > 0 && !rcpt_domain.is_empty() {
            let mut limit = i64::from(self.cfg.dest_per_minute);
            if self
                .limits
                .flag(&format!("pen:{egress}:{rcpt_domain}"))
                .await
            {
                limit = (limit / 4).max(1);
            }
            let key = format!("thr:{egress}:{rcpt_domain}:{}", now.timestamp() / 60);
            let n = self.limits.incr(&key, 70).await;
            res.push(key);
            if n > limit {
                return Gate::Defer(to_minute + rand::random::<f64>() * 5.0, "throttle");
            }
        }
        Gate::Pass
    }
}

/// Coarse destination grouping for metrics / warm-up (SPEC 15).
fn provider_of(domain: &str) -> &'static str {
    match domain {
        "gmail.com" | "googlemail.com" => "gmail",
        d if d.starts_with("yahoo.") || d == "ymail.com" => "yahoo",
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" => "outlook",
        _ => "other",
    }
}

/// Gmail daily-cap persistence over Postgres: usage is derived from `emails.sent_at` for this
/// transport, so it survives restarts. ponytail: concurrent in-flight sends can overshoot by the
/// worker count; Gmail's own limit is the backstop.
pub struct CapStorePg {
    pub pool: PgPool,
    pub transport_id: Uuid,
}

#[async_trait::async_trait]
impl CapStore for CapStorePg {
    async fn usage(&self, window: Duration) -> (usize, Option<Duration>) {
        let r: std::result::Result<(i64, Option<f64>), sqlx::Error> = sqlx::query_as(
            "SELECT count(*), extract(epoch FROM now() - min(sent_at))::float8 FROM emails
             WHERE transport_id = $1 AND sent_at > now() - make_interval(secs => $2)",
        )
        .bind(self.transport_id)
        .bind(window.as_secs_f64())
        .fetch_one(&self.pool)
        .await;
        match r {
            Ok((n, age)) => (n as usize, age.map(Duration::from_secs_f64)),
            Err(e) => {
                tracing::warn!(error = %e, "cap usage query failed");
                (0, None)
            }
        }
    }
    async fn record(&self) {} // the engine writes sent_at when it records the outcome
}
