//! The journey engine: event matching, enrollment, durable timers and step execution.
//!
//! Every method takes `now` so tests (and `simulate`) can drive a virtual clock. All state is in
//! Postgres; a run is advanced under `FOR UPDATE` and each step commits atomically with its
//! side effects, so a crashed worker re-runs at most the step it died in (emails carry the
//! idempotency key `run_id:step_key:1`).
use crate::contacts::{self, Contact, ContactInput};
use crate::def::*;
use crate::error::{AutomationError, Result};
use crate::personalize::{PersonalizeRequest, Personalizer, SlotSpec};
use crate::policy::{cap_free_at, parse_duration, QuietHours};
use crate::rules::Rule;
use chrono::{DateTime, Duration, Utc};
use mailcraft_core::Stream;
use mailcraft_templates::{Block, Template};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::types::Json;
use sqlx::{PgConnection, PgPool};
use std::sync::Arc;
use uuid::Uuid;

/// Engine-wide lifecycle frequency caps (SPEC 13 gate 3). Per-automation `caps.frequency` overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyCaps {
    pub min_gap: Duration,
    pub max_per_7d: usize,
    /// A send held back by the cap is dropped after waiting this long.
    pub max_defer: Duration,
}

impl Default for FrequencyCaps {
    fn default() -> Self {
        Self {
            min_gap: Duration::hours(48),
            max_per_7d: 3,
            max_defer: Duration::days(3),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub frequency: FrequencyCaps,
    pub quiet: QuietHours,
    /// How long a claimed run is invisible to other workers.
    pub lease: Duration,
    /// Failed step attempts before the run is marked `failed`.
    pub max_attempts: u32,
    pub max_steps_per_wake: usize,
    /// Re-check interval while the kill switch is on or the automation is paused.
    pub gate_retry: Duration,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            frequency: FrequencyCaps::default(),
            quiet: QuietHours::default(),
            lease: Duration::minutes(5),
            max_attempts: 5,
            max_steps_per_wake: 50,
            gate_retry: Duration::minutes(15),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TrackInput {
    pub name: String,
    pub contact: ContactInput,
    pub properties: Value,
    /// Same key twice = same event (`track_events_idem_idx`).
    pub idempotency_key: Option<String>,
    /// Record the event but never match it to automations (backfill of history).
    pub suppress_entry: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Tracked {
    pub event_id: Uuid,
    pub contact_id: Uuid,
    pub duplicate: bool,
}

#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct TickStats {
    pub events_matched: usize,
    pub segment_entries: usize,
    pub runs_advanced: usize,
}

#[derive(Clone)]
pub struct Engine {
    pool: PgPool,
    personalizer: Arc<dyn Personalizer>,
    cfg: Arc<EngineConfig>,
}

#[derive(sqlx::FromRow, Clone)]
struct AutoRow {
    id: Uuid,
    workspace_id: Uuid,
    status: String,
    entry_rule: String,
    entry_days: Option<i32>,
    approval: String,
    caps: Json<Caps>,
    current_version: i32,
}

const AUTO_COLS: &str =
    "id, workspace_id, status, entry_rule, entry_days, approval, caps, current_version";

#[derive(sqlx::FromRow)]
struct RunRow {
    id: Uuid,
    automation_id: Uuid,
    version: i32,
    contact_id: Uuid,
    state: String,
    current_step: Option<String>,
    context: Value,
}

/// What a step decided.
enum Out {
    /// Continue at `next` (None = the run is complete).
    Goto(Option<String>, Value),
    /// Resume at `next` after `wake_at`.
    Sleep {
        wake_at: DateTime<Utc>,
        next: Option<String>,
        result: Value,
    },
    Wait {
        wake_at: DateTime<Utc>,
        event: String,
        filter: Option<Rule>,
        result: Value,
    },
    /// Stay on this step and retry at `until`.
    Defer {
        until: DateTime<Utc>,
        result: Value,
    },
    Exit {
        reason: String,
        result: Value,
    },
}

fn ctx_get<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(v, |c, p| c.get(p))
}

fn rule_ctx(run_ctx: &Value, contact: &Contact, extra: Map<String, Value>) -> Value {
    let mut m = extra;
    m.insert(
        "event".into(),
        run_ctx
            .pointer("/event/properties")
            .cloned()
            .unwrap_or(json!({})),
    );
    m.insert(
        "event_name".into(),
        run_ctx
            .pointer("/event/name")
            .cloned()
            .unwrap_or(Value::Null),
    );
    m.insert("contact".into(), contact.to_json());
    m.insert(
        "wait_events".into(),
        run_ctx.get("wait_events").cloned().unwrap_or(json!({})),
    );
    Value::Object(m)
}

fn resolve_dollar(v: &Value, ctx: &Value) -> Value {
    match v.as_str().and_then(|s| s.strip_prefix('$')) {
        Some(path) => ctx_get(ctx, path).cloned().unwrap_or(Value::Null),
        None => v.clone(),
    }
}

impl Engine {
    pub fn new(pool: PgPool, personalizer: Arc<dyn Personalizer>, cfg: EngineConfig) -> Self {
        Self {
            pool,
            personalizer,
            cfg: Arc::new(cfg),
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // ---------------------------------------------------------------- events

    /// Store an event (and upsert its contact). Idempotent by `idempotency_key`.
    pub async fn track(
        &self,
        workspace_id: Uuid,
        input: TrackInput,
        now: DateTime<Utc>,
    ) -> Result<Tracked> {
        if input.name.trim().is_empty() {
            return Err(AutomationError::invalid("event name is empty"));
        }
        let mut tx = self.pool.begin().await?;
        let contact = contacts::upsert_contact(&mut *tx, workspace_id, &input.contact, now).await?;
        let id = Uuid::new_v4();
        let props = if input.properties.is_null() {
            json!({})
        } else {
            input.properties.clone()
        };
        let inserted: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO track_events (id, workspace_id, contact_id, name, properties, idempotency_key, received_at, matched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(contact.id)
        .bind(&input.name)
        .bind(&props)
        .bind(&input.idempotency_key)
        .bind(now)
        .bind(input.suppress_entry.then_some(now))
        .fetch_optional(&mut *tx)
        .await?;
        let (event_id, duplicate) = match inserted {
            Some(id) => (id, false),
            None => (
                sqlx::query_scalar(
                    "SELECT id FROM track_events WHERE workspace_id = $1 AND idempotency_key = $2",
                )
                .bind(workspace_id)
                .bind(&input.idempotency_key)
                .fetch_one(&mut *tx)
                .await?,
                true,
            ),
        };
        tx.commit().await?;
        Ok(Tracked {
            event_id,
            contact_id: contact.id,
            duplicate,
        })
    }

    /// `track` + match immediately (what `POST /v1/events` does when no worker is lagging).
    pub async fn ingest(
        &self,
        workspace_id: Uuid,
        input: TrackInput,
        now: DateTime<Utc>,
    ) -> Result<Tracked> {
        let t = self.track(workspace_id, input, now).await?;
        if !t.duplicate {
            self.match_event(t.event_id, now).await?;
        }
        Ok(t)
    }

    /// Match events nobody matched yet (the matcher job). Returns how many were processed.
    pub async fn match_pending(&self, now: DateTime<Utc>, limit: i64) -> Result<usize> {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM track_events WHERE matched_at IS NULL ORDER BY received_at LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let mut n = 0;
        for id in ids {
            n += self.match_event(id, now).await? as usize;
        }
        Ok(n)
    }

    /// Goal exits, then `wait_for_event` wake-ups, then new enrollments, in one transaction.
    #[allow(clippy::type_complexity)]
    pub async fn match_event(&self, event_id: Uuid, now: DateTime<Utc>) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let ev: Option<(Uuid, Uuid, String, Value)> = sqlx::query_as(
            "SELECT workspace_id, contact_id, name, properties FROM track_events
             WHERE id = $1 AND matched_at IS NULL FOR UPDATE SKIP LOCKED",
        )
        .bind(event_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((ws, contact_id, name, props)) = ev else {
            return Ok(false);
        };
        let contact = contacts::get_contact(&mut *tx, contact_id).await?;
        let rctx = json!({"event": props, "event_name": name, "contact": contact.to_json()});

        // 1. goals
        let goal_runs: Vec<(Uuid, Json<Goal>)> = sqlx::query_as(
            "SELECT r.id, a.goal FROM automation_runs r JOIN automations a ON a.id = r.automation_id
             WHERE r.contact_id = $1 AND r.state IN ('active','waiting') AND a.goal IS NOT NULL FOR UPDATE OF r",
        )
        .bind(contact_id)
        .fetch_all(&mut *tx)
        .await?;
        for (run_id, Json(goal)) in goal_runs {
            if goal.matches(&name, &rctx) {
                exit_run(&mut tx, run_id, "goal", json!({"event": name}), now).await?;
            }
        }

        // 2. wake runs waiting for this event
        let waiting: Vec<(Uuid, Uuid, i32, Option<String>, Value, Option<Json<Rule>>)> = sqlx::query_as(
            "SELECT id, automation_id, version, current_step, context, wait_filter FROM automation_runs
             WHERE contact_id = $1 AND state = 'waiting' AND wait_event = $2 FOR UPDATE",
        )
        .bind(contact_id)
        .bind(&name)
        .fetch_all(&mut *tx)
        .await?;
        for (run_id, auto_id, version, cur, mut ctx, filter) in waiting {
            let mut extra = Map::new();
            extra.insert(
                "wait_events".into(),
                ctx.get("wait_events").cloned().unwrap_or(json!({})),
            );
            let wctx = rule_ctx(&ctx, &contact, extra);
            let wctx = {
                let mut w = wctx;
                w["event"] = props.clone(); // the waited-for event, not the entry event
                w["event_name"] = json!(name);
                w
            };
            if filter.is_some_and(|Json(f)| !f.eval(&wctx)) {
                continue;
            }
            let steps = load_steps(&mut tx, auto_id, version).await?;
            let next = cur
                .as_deref()
                .and_then(|k| steps.iter().find(|s| s.key == k))
                .and_then(|s| s.edge("event"))
                .map(str::to_owned);
            ctx["wait_events"][&name] = props.clone();
            ctx.as_object_mut().map(|m| m.remove("_deadline"));
            let (state, ended) = if next.is_some() {
                ("active", None)
            } else {
                ("completed", Some(now))
            };
            sqlx::query(
                "UPDATE automation_runs SET state=$2, current_step=$3, context=$4, wait_event=NULL, wait_filter=NULL,
                 next_wake_at=$5, ended_at=$6 WHERE id=$1",
            )
            .bind(run_id)
            .bind(state)
            .bind(&next)
            .bind(&ctx)
            .bind(ended.is_none().then_some(now))
            .bind(ended)
            .execute(&mut *tx)
            .await?;
            log_step(
                &mut tx,
                run_id,
                cur.as_deref().unwrap_or("_wait"),
                json!({"outcome":"event","event":name}),
                now,
            )
            .await?;
        }

        // 3. enrollments
        let autos: Vec<AutoRow> = sqlx::query_as(&format!(
            "SELECT {AUTO_COLS} FROM automations WHERE workspace_id = $1 AND status = 'active'"
        ))
        .bind(ws)
        .fetch_all(&mut *tx)
        .await?;
        let event_json = json!({"id": event_id, "name": name, "properties": props});
        for a in autos {
            let steps = load_steps(&mut tx, a.id, a.current_version).await?;
            let Some((_, trig)) = trigger_of(&steps) else {
                continue;
            };
            if !trig.event_names().contains(&name.as_str()) {
                continue;
            }
            if trig.filter.as_ref().is_some_and(|f| !f.eval(&rctx)) {
                continue;
            }
            enroll(
                &mut tx,
                &a,
                &steps,
                contact_id,
                &event_id.to_string(),
                event_json.clone(),
                now,
            )
            .await?;
        }
        sqlx::query("UPDATE track_events SET matched_at = $2 WHERE id = $1")
            .bind(event_id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    // ---------------------------------------------------------- segment triggers

    /// Enroll contacts that entered a segment an active automation triggers on.
    /// ponytail: rescans every tick; add a per-automation watermark if segments get large.
    pub async fn poll_segment_triggers(&self, now: DateTime<Utc>) -> Result<usize> {
        let autos: Vec<AutoRow> = sqlx::query_as(&format!(
            "SELECT {AUTO_COLS} FROM automations WHERE status = 'active' AND trigger_event = 'segment.entered'"
        ))
        .fetch_all(&self.pool)
        .await?;
        let mut n = 0;
        for a in autos {
            let mut tx = self.pool.begin().await?;
            let steps = load_steps(&mut tx, a.id, a.current_version).await?;
            let Some((_, trig)) = trigger_of(&steps) else {
                continue;
            };
            let Some(seg) = &trig.segment else { continue };
            let seg_id = contacts::resolve_segment(&mut *tx, a.workspace_id, seg).await?;
            tx.commit().await?;
            contacts::materialize_segment(&self.pool, seg_id, now).await?;
            let members: Vec<(Uuid, DateTime<Utc>)> = sqlx::query_as(
                "SELECT contact_id, added_at FROM segment_members WHERE segment_id = $1 ORDER BY added_at",
            )
            .bind(seg_id)
            .fetch_all(&self.pool)
            .await?;
            for (contact_id, added_at) in members {
                let key = format!("segment:{seg_id}:{}", added_at.timestamp_micros());
                let mut tx = self.pool.begin().await?;
                let contact = contacts::get_contact(&mut *tx, contact_id).await?;
                let ev = json!({"id": null, "name": "segment.entered", "properties": {"segment_id": seg_id}});
                let rctx = json!({"event": ev["properties"], "event_name": "segment.entered", "contact": contact.to_json()});
                if trig.filter.as_ref().is_some_and(|f| !f.eval(&rctx)) {
                    continue;
                }
                if enroll(&mut tx, &a, &steps, contact_id, &key, ev, now)
                    .await?
                    .is_some()
                {
                    n += 1;
                }
                tx.commit().await?;
            }
        }
        Ok(n)
    }

    // ------------------------------------------------------- lifecycle control

    /// Activate an automation. With `backfill_suppress`, contacts that already match the trigger
    /// are marked as entered-and-exited first so existing users are not blasted.
    pub async fn activate(
        &self,
        automation_id: Uuid,
        backfill_suppress: bool,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if backfill_suppress {
            self.backfill_suppress(automation_id, now).await?;
        }
        sqlx::query("UPDATE automations SET status = 'active' WHERE id = $1")
            .bind(automation_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// `--backfill` suppression: pending trigger events are marked matched, and every contact
    /// that ever had a trigger event (or is in the trigger segment) gets an `exited` run with
    /// `entry_key = 'backfill'`, which blocks `once`/`if_no_active_run`/`after_days` re-entry.
    /// Returns the number of contacts suppressed.
    pub async fn backfill_suppress(&self, automation_id: Uuid, now: DateTime<Utc>) -> Result<u64> {
        let a: AutoRow = sqlx::query_as(&format!(
            "SELECT {AUTO_COLS} FROM automations WHERE id = $1"
        ))
        .bind(automation_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AutomationError::not_found(format!("automation {automation_id}")))?;
        let mut tx = self.pool.begin().await?;
        let steps = load_steps(&mut tx, a.id, a.current_version).await?;
        let (_, trig) = trigger_of(&steps)
            .ok_or_else(|| AutomationError::invalid("automation has no trigger"))?;
        let names: Vec<String> = trig.event_names().iter().map(|s| s.to_string()).collect();
        sqlx::query("UPDATE track_events SET matched_at = $3 WHERE workspace_id = $1 AND name = ANY($2) AND matched_at IS NULL")
            .bind(a.workspace_id)
            .bind(&names)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        let mut contacts_to_mark: Vec<Uuid> = sqlx::query_scalar(
            "SELECT DISTINCT contact_id FROM track_events WHERE workspace_id = $1 AND name = ANY($2)",
        )
        .bind(a.workspace_id)
        .bind(&names)
        .fetch_all(&mut *tx)
        .await?;
        if let Some(seg) = &trig.segment {
            let seg_id = contacts::resolve_segment(&mut *tx, a.workspace_id, seg).await?;
            contacts_to_mark.extend(
                sqlx::query_scalar::<_, Uuid>(
                    "SELECT contact_id FROM segment_members WHERE segment_id = $1",
                )
                .bind(seg_id)
                .fetch_all(&mut *tx)
                .await?,
            );
        }
        let n = sqlx::query(
            "INSERT INTO automation_runs (automation_id, version, contact_id, entry_key, state, context, started_at, ended_at)
             SELECT $1, $2, c, 'backfill', 'exited', '{\"exit_reason\":\"backfill\"}'::jsonb, $4, $4 FROM unnest($3::uuid[]) c
             ON CONFLICT DO NOTHING",
        )
        .bind(a.id)
        .bind(a.current_version)
        .bind(&contacts_to_mark)
        .bind(now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        Ok(n)
    }

    // --------------------------------------------------------------- run loop

    /// One worker pass: match events, poll segment triggers, advance due runs.
    pub async fn tick(&self, now: DateTime<Utc>) -> Result<TickStats> {
        Ok(TickStats {
            events_matched: self.match_pending(now, 500).await?,
            segment_entries: self.poll_segment_triggers(now).await?,
            runs_advanced: self.run_due(now, 200).await?,
        })
    }

    /// Claim runs whose timer is due (`FOR UPDATE SKIP LOCKED`, leased) and advance them.
    pub async fn run_due(&self, now: DateTime<Utc>, limit: i64) -> Result<usize> {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "UPDATE automation_runs SET next_wake_at = $2 WHERE id IN (
               SELECT id FROM automation_runs WHERE state IN ('active','waiting') AND next_wake_at <= $1
               ORDER BY next_wake_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING id",
        )
        .bind(now)
        .bind(now + self.cfg.lease)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let n = ids.len();
        for id in ids {
            self.advance(id, now).await?;
        }
        Ok(n)
    }

    /// Execute steps of one run until it waits, defers or ends.
    pub async fn advance(&self, run_id: Uuid, now: DateTime<Utc>) -> Result<()> {
        for _ in 0..self.cfg.max_steps_per_wake {
            match self.advance_one(run_id, now).await {
                Ok(true) => continue,
                Ok(false) => break,
                Err(e) => {
                    tracing::warn!(%run_id, error = %e, "automation step failed");
                    self.record_failure(run_id, now, &e).await?;
                    break;
                }
            }
        }
        Ok(())
    }

    async fn record_failure(
        &self,
        run_id: Uuid,
        now: DateTime<Utc>,
        err: &AutomationError,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let row: Option<(Value, Option<String>)> = sqlx::query_as(
            "SELECT context, current_step FROM automation_runs WHERE id = $1 FOR UPDATE",
        )
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((mut ctx, step)) = row else {
            return Ok(());
        };
        let attempts = ctx.get("_attempts").and_then(Value::as_u64).unwrap_or(0) as u32 + 1;
        ctx["_attempts"] = json!(attempts);
        let failed = attempts >= self.cfg.max_attempts;
        let wake = now + Duration::minutes(1 << attempts.min(10));
        sqlx::query(
            "UPDATE automation_runs SET context = $2, state = CASE WHEN $3 THEN 'failed' ELSE state END,
             ended_at = CASE WHEN $3 THEN $4 ELSE NULL END, next_wake_at = CASE WHEN $3 THEN NULL ELSE $5 END WHERE id = $1",
        )
        .bind(run_id)
        .bind(&ctx)
        .bind(failed)
        .bind(now)
        .bind(wake)
        .execute(&mut *tx)
        .await?;
        log_step(
            &mut tx,
            run_id,
            step.as_deref().unwrap_or("_"),
            json!({"decision":"error","error":err.to_string(),"attempt":attempts,"failed":failed}),
            now,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Returns true when the run should keep going in this wake.
    async fn advance_one(&self, run_id: Uuid, now: DateTime<Utc>) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let Some(run) = sqlx::query_as::<_, RunRow>(
            "SELECT id, automation_id, version, contact_id, state, current_step, context
             FROM automation_runs WHERE id = $1 AND state IN ('active','waiting') FOR UPDATE",
        )
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await?
        else {
            return Ok(false);
        };
        let auto: AutoRow = sqlx::query_as(&format!(
            "SELECT {AUTO_COLS} FROM automations WHERE id = $1"
        ))
        .bind(run.automation_id)
        .fetch_one(&mut *tx)
        .await?;
        let steps = load_steps(&mut tx, run.automation_id, run.version).await?;
        let Some(cur) = run.current_step.clone() else {
            apply(
                &mut tx,
                &run,
                run.context.clone(),
                "_end",
                Out::Goto(None, json!({})),
                now,
            )
            .await?;
            tx.commit().await?;
            return Ok(false);
        };
        let step = steps.iter().find(|s| s.key == cur).ok_or_else(|| {
            AutomationError::invalid(format!("step `{cur}` missing from version {}", run.version))
        })?;
        let mut ctx = run.context.clone();

        let out = if run.state == "waiting" {
            let deadline = ctx
                .get("_deadline")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<DateTime<Utc>>().ok())
                .unwrap_or(now);
            if deadline > now {
                // woken early by an expired lease, not by the timeout: put the timer back
                sqlx::query("UPDATE automation_runs SET next_wake_at = $2 WHERE id = $1")
                    .bind(run.id)
                    .bind(deadline)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                return Ok(false);
            }
            Out::Goto(
                step.edge("timeout").map(str::to_owned),
                json!({"outcome":"timeout"}),
            )
        } else {
            let contact = contacts::get_contact(&mut *tx, run.contact_id).await?;
            self.exec_step(&mut tx, &run, &auto, step, &contact, &mut ctx, now)
                .await?
        };
        let cont = matches!(out, Out::Goto(Some(_), _));
        apply(&mut tx, &run, ctx, &step.key, out, now).await?;
        tx.commit().await?;
        Ok(cont)
    }

    #[allow(clippy::too_many_arguments)]
    async fn exec_step(
        &self,
        tx: &mut PgConnection,
        run: &RunRow,
        auto: &AutoRow,
        step: &Step,
        contact: &Contact,
        ctx: &mut Value,
        now: DateTime<Utc>,
    ) -> Result<Out> {
        let next = |name: &str| step.edge(name).map(str::to_owned);
        match &step.kind {
            StepKind::Trigger(_) => Ok(Out::Goto(next("next"), json!({}))),
            StepKind::Condition(c) => {
                let mut fields = vec![];
                c.rule.fields(&mut fields);
                let extra = self.prefetch(tx, run, contact.id, now, &fields).await?;
                let ok = c.rule.eval(&rule_ctx(ctx, contact, extra));
                Ok(Out::Goto(
                    next(if ok { "true" } else { "false" }),
                    json!({"outcome": ok}),
                ))
            }
            StepKind::Delay(d) => {
                let wake_at = now + parse_duration_max(&d.duration, &step.key)?;
                Ok(Out::Sleep {
                    wake_at,
                    next: next("next"),
                    result: json!({"wake_at": wake_at}),
                })
            }
            StepKind::WaitForEvent(w) => {
                let wake_at = now + parse_duration_max(&w.timeout, &step.key)?;
                ctx["_deadline"] = json!(wake_at);
                Ok(Out::Wait {
                    wake_at,
                    event: w.event.clone(),
                    filter: w.filter.clone(),
                    result: json!({"waiting_for": w.event, "until": wake_at}),
                })
            }
            StepKind::UpdateContact(u) => {
                let rctx = rule_ctx(ctx, contact, Map::new());
                let (mut props, mut first, mut last, mut tz) = (Map::new(), None, None, None);
                for (k, v) in &u.set {
                    let v = resolve_dollar(v, &rctx);
                    match k.as_str() {
                        "first_name" => first = v.as_str().map(str::to_owned),
                        "last_name" => last = v.as_str().map(str::to_owned),
                        "timezone" => tz = v.as_str().map(str::to_owned),
                        other => {
                            props.insert(
                                other
                                    .strip_prefix("properties.")
                                    .unwrap_or(other)
                                    .to_owned(),
                                v,
                            );
                        }
                    }
                }
                sqlx::query(
                    "UPDATE contacts SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
                     timezone = COALESCE($4, timezone), properties = properties || $5, updated_at = $6 WHERE id = $1",
                )
                .bind(contact.id)
                .bind(first)
                .bind(last)
                .bind(tz)
                .bind(Value::Object(props))
                .bind(now)
                .execute(&mut *tx)
                .await?;
                Ok(Out::Goto(
                    next("next"),
                    json!({"updated": u.set.keys().collect::<Vec<_>>()}),
                ))
            }
            StepKind::AddToSegment(s) => {
                let seg = match contacts::resolve_segment(&mut *tx, auto.workspace_id, &s.segment)
                    .await
                {
                    Ok(id) => id,
                    Err(AutomationError::NotFound(_)) if s.segment.parse::<Uuid>().is_err() => {
                        contacts::create_segment(&mut *tx, auto.workspace_id, &s.segment, None)
                            .await?
                    }
                    Err(e) => return Err(e),
                };
                let added = contacts::add_to_segment(&mut *tx, seg, contact.id, now).await?;
                Ok(Out::Goto(
                    next("next"),
                    json!({"segment_id": seg, "added": added}),
                ))
            }
            StepKind::Exit(e) => Ok(Out::Exit {
                reason: e.reason.clone().unwrap_or_else(|| "exit_step".into()),
                result: json!({}),
            }),
            StepKind::SendEmail(c) => {
                self.exec_send(tx, run, auto, step, c, contact, ctx, now)
                    .await
            }
        }
    }

    /// Resolve DB-backed rule fields: `clicked_step:<key>`, `event_count:<name>`, `sent_count:<duration>`.
    async fn prefetch(
        &self,
        tx: &mut PgConnection,
        run: &RunRow,
        contact_id: Uuid,
        now: DateTime<Utc>,
        fields: &[String],
    ) -> Result<Map<String, Value>> {
        let mut out = Map::new();
        for f in fields {
            if let Some(key) = f.strip_prefix("clicked_step:") {
                let b: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM email_events ev JOIN emails e ON e.id = ev.email_id
                     WHERE e.automation_run_id = $1 AND e.idempotency_key LIKE $2 AND ev.type = 'clicked' AND NOT ev.is_bot)",
                )
                .bind(run.id)
                .bind(format!("{}:{}:%", run.id, key))
                .fetch_one(&mut *tx)
                .await?;
                out.insert(f.clone(), json!(b));
            } else if let Some(name) = f.strip_prefix("event_count:") {
                let n: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM track_events WHERE contact_id = $1 AND name = $2",
                )
                .bind(contact_id)
                .bind(name)
                .fetch_one(&mut *tx)
                .await?;
                out.insert(f.clone(), json!(n));
            } else if let Some(d) = f.strip_prefix("sent_count:") {
                let d = parse_duration(d)
                    .ok_or_else(|| AutomationError::invalid(format!("`{f}`: bad duration")))?;
                let n: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM emails WHERE contact_id = $1 AND source = 'automation' AND created_at > $2
                     AND status NOT IN ('cancelled','failed','suppressed')",
                )
                .bind(contact_id)
                .bind(now - d)
                .fetch_one(&mut *tx)
                .await?;
                out.insert(f.clone(), json!(n));
            }
        }
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    async fn exec_send(
        &self,
        tx: &mut PgConnection,
        run: &RunRow,
        auto: &AutoRow,
        step: &Step,
        c: &SendCfg,
        contact: &Contact,
        ctx: &mut Value,
        now: DateTime<Utc>,
    ) -> Result<Out> {
        let next = step.edge("next").map(str::to_owned);
        let mut decisions: Vec<Value> = vec![];
        let defer = |until, gate: &str| Out::Defer {
            until,
            result: json!({"decision":"deferred","gate":gate,"until":until}),
        };

        // 1. kill switch / paused automation
        let kill: bool = sqlx::query_scalar("SELECT kill_switch FROM workspaces WHERE id = $1")
            .bind(auto.workspace_id)
            .fetch_one(&mut *tx)
            .await?;
        if kill {
            return Ok(defer(now + self.cfg.gate_retry, "kill_switch"));
        }
        if auto.status != "active" {
            return Ok(defer(now + self.cfg.gate_retry, "automation_paused"));
        }

        // 2. suppression (never bypassed) and topic opt-out (account topics bypass)
        let suppressed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2)",
        )
        .bind(auto.workspace_id)
        .bind(&contact.email)
        .fetch_one(&mut *tx)
        .await?;
        if suppressed {
            return Ok(Out::Exit {
                reason: "suppressed".into(),
                result: json!({"decision":"exit","gate":"suppression"}),
            });
        }
        if let Some(topic) = &c.topic {
            let row: Option<(bool, bool, Option<bool>)> = sqlx::query_as(
                "SELECT t.default_opt_in, t.can_unsubscribe, ct.opted_in FROM topics t
                 LEFT JOIN contact_topics ct ON ct.topic_id = t.id AND ct.contact_id = $3
                 WHERE t.workspace_id = $1 AND t.key = $2",
            )
            .bind(auto.workspace_id)
            .bind(topic)
            .bind(contact.id)
            .fetch_optional(&mut *tx)
            .await?;
            let (default_in, can_unsub, opted) = row.ok_or_else(|| {
                AutomationError::invalid(format!("step `{}`: unknown topic `{topic}`", step.key))
            })?;
            if can_unsub && !opted.unwrap_or(default_in) {
                return Ok(Out::Exit {
                    reason: "topic_opt_out".into(),
                    result: json!({"decision":"exit","gate":"topic","topic":topic}),
                });
            }
            decisions
                .push(json!({"gate":"topic","decision": if can_unsub {"pass"} else {"bypass"}}));
        }

        // template
        let (template_id, tpl_stream, doc): (Uuid, String, Value) = sqlx::query_as(
            "SELECT t.id, t.stream, v.doc FROM templates t JOIN template_versions v ON v.id = t.current_version_id
             WHERE t.workspace_id = $1 AND t.alias = $2",
        )
        .bind(auto.workspace_id)
        .bind(&c.template)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AutomationError::not_found(format!("template `{}` (or no published version)", c.template)))?;
        let template = Template::from_json(&doc.to_string())?;
        let stream = c.stream.unwrap_or(if tpl_stream == "marketing" {
            Stream::Marketing
        } else {
            Stream::Transactional
        });
        let stream_s = if stream == Stream::Marketing {
            "marketing"
        } else {
            "transactional"
        };

        // 3. frequency caps
        let defer_key = step.key.clone();
        if c.cap_exempt {
            decisions.push(json!({"gate":"frequency_cap","decision":"exempt"}));
        } else {
            let fo = auto.caps.0.frequency.clone().unwrap_or_default();
            let gap = fo
                .min_gap_hours
                .map(Duration::hours)
                .unwrap_or(self.cfg.frequency.min_gap);
            let max7 = fo.max_per_7d.unwrap_or(self.cfg.frequency.max_per_7d);
            let stamps: Vec<DateTime<Utc>> = sqlx::query_scalar(
                "SELECT created_at FROM emails WHERE contact_id = $1 AND source = 'automation' AND created_at > $2
                 AND status NOT IN ('cancelled','failed','suppressed') AND NOT (tags @> '[\"cap_exempt\"]'::jsonb)
                 ORDER BY created_at",
            )
            .bind(contact.id)
            .bind(now - Duration::days(7))
            .fetch_all(&mut *tx)
            .await?;
            let mut until = stamps.last().filter(|l| now - **l < gap).map(|l| *l + gap);
            if let Some(t) = cap_free_at(&stamps, max7, Duration::days(7), now) {
                until = Some(until.map_or(t, |u| u.max(t)));
            }
            if let Some(u) = until {
                let since = ctx
                    .pointer(&format!("/_defer/{defer_key}"))
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<DateTime<Utc>>().ok())
                    .unwrap_or(now);
                if now - since >= self.cfg.frequency.max_defer {
                    if let Some(m) = ctx.get_mut("_defer").and_then(Value::as_object_mut) {
                        m.remove(&defer_key);
                    }
                    return Ok(Out::Goto(
                        next,
                        json!({"decision":"dropped","gate":"frequency_cap","held_since":since}),
                    ));
                }
                if ctx.get("_defer").is_none() {
                    ctx["_defer"] = json!({});
                }
                ctx["_defer"][&defer_key] = json!(since);
                return Ok(defer(
                    u.min(since + self.cfg.frequency.max_defer),
                    "frequency_cap",
                ));
            }
            decisions.push(json!({"gate":"frequency_cap","decision":"pass"}));
        }
        if let Some(pc) = &auto.caps.0.per_contact {
            let n: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM emails e JOIN automation_runs r ON r.id = e.automation_run_id
                 WHERE r.automation_id = $1 AND e.contact_id = $2 AND e.created_at > $3 AND e.status NOT IN ('cancelled','failed','suppressed')",
            )
            .bind(auto.id)
            .bind(contact.id)
            .bind(now - Duration::days(pc.window_days))
            .fetch_one(&mut *tx)
            .await?;
            if n as usize >= pc.max {
                return Ok(Out::Goto(
                    next,
                    json!({"decision":"dropped","gate":"automation_cap","sent":n}),
                ));
            }
        }

        // 4. quiet hours
        if let Some(at) =
            self.cfg
                .quiet
                .next_send_time(contact.timezone.as_deref(), c.weekend_ok, now)
        {
            return Ok(defer(at, "quiet_hours"));
        }
        decisions.push(json!({"gate":"quiet_hours","decision":"pass"}));

        // 5. daily send cap for this automation
        if let Some(cap) = auto.caps.0.daily_sends {
            let n: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM emails e JOIN automation_runs r ON r.id = e.automation_run_id
                 WHERE r.automation_id = $1 AND e.created_at > $2 AND e.status NOT IN ('cancelled','failed','suppressed')",
            )
            .bind(auto.id)
            .bind(now - Duration::hours(24))
            .fetch_one(&mut *tx)
            .await?;
            if n >= cap {
                return Ok(defer(now + Duration::hours(1), "daily_send_cap"));
            }
        }

        // content: variables, optional LLM slots, subject
        let mut vars = Map::new();
        if let Some(p) = contact.properties.as_object() {
            vars.extend(p.clone());
        }
        let nonempty = |s: &Option<String>| s.clone().filter(|v| !v.trim().is_empty());
        vars.insert(
            "first_name".into(),
            json!(nonempty(&contact.first_name).unwrap_or_else(|| "there".into())),
        );
        vars.insert(
            "last_name".into(),
            json!(contact.last_name.clone().unwrap_or_default()),
        );
        vars.insert("email".into(), json!(contact.email));
        vars.insert(
            "event".into(),
            ctx.pointer("/event/properties")
                .cloned()
                .unwrap_or(json!({})),
        );
        let rctx = rule_ctx(ctx, contact, Map::new());
        for (k, v) in &c.vars {
            vars.insert(k.clone(), resolve_dollar(v, &rctx));
        }
        let mut generation_id = None;
        let mut subject_override = c.subject.clone();
        if c.mode == SendMode::Llm {
            let slots: Vec<SlotSpec> = template
                .slots()
                .into_iter()
                .filter_map(|b| match b {
                    Block::Slot {
                        name,
                        max_len,
                        instructions,
                        fallback,
                    } => Some(SlotSpec {
                        name: name.clone(),
                        max_len: *max_len,
                        instructions: instructions.clone(),
                        fallback: fallback.clone(),
                    }),
                    _ => None,
                })
                .collect();
            let req = PersonalizeRequest {
                workspace_id: auto.workspace_id,
                automation_id: auto.id,
                run_id: run.id,
                step_key: step.key.clone(),
                template_alias: c.template.clone(),
                subject_template: template.subject.clone(),
                slots: slots.clone(),
                context: Value::Object(vars.clone()),
                instructions: c.instructions.clone(),
            };
            // ponytail: called under the run's row lock; move before the tx if LLM latency hurts
            let got = match self.personalizer.personalize(req).await {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!(error = %e, "personalizer failed; using fallback copy");
                    Default::default()
                }
            };
            let mut filled = Map::new();
            for s in &slots {
                let v = got
                    .slots
                    .get(&s.name)
                    .cloned()
                    .or_else(|| s.fallback.clone())
                    .ok_or_else(|| {
                        AutomationError::invalid(format!(
                            "slot `{}` has no generated text and no fallback",
                            s.name
                        ))
                    })?;
                filled.insert(s.name.clone(), json!(v));
            }
            vars.insert("slots".into(), Value::Object(filled));
            generation_id = got.generation_id;
            if subject_override.is_none() {
                subject_override = got.subject;
            }
            if let Some(p) = got.preheader {
                vars.insert("preheader".into(), json!(p));
            }
            decisions.push(json!({"gate":"llm","decision": if got.used_fallback {"fallback"} else {"generated"}}));
        }
        let vars = Value::Object(vars);
        let subject = match subject_override {
            Some(s) => s,
            None => mailcraft_templates::render_subject(&template, &vars)?,
        };

        // 6. approval policy
        let pending_approval = match parse_approval(&auto.approval)? {
            None => false,
            Some(n) => {
                let sent: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM emails e JOIN automation_runs r ON r.id = e.automation_run_id
                     WHERE r.automation_id = $1 AND e.status <> 'cancelled'",
                )
                .bind(auto.id)
                .fetch_one(&mut *tx)
                .await?;
                sent < n
            }
        };
        decisions.push(json!({"gate":"approval","decision": if pending_approval {"needs_approval"} else {"auto"}}));

        // sender
        let domain: Option<(Uuid, String)> = sqlx::query_as(
            "SELECT id, name FROM domains WHERE workspace_id = $1 AND stream = $2 AND status = 'verified' ORDER BY created_at LIMIT 1",
        )
        .bind(auto.workspace_id)
        .bind(stream_s)
        .fetch_optional(&mut *tx)
        .await?;
        let from = match (&c.from, &domain) {
            (Some(f), _) => f.clone(),
            (None, Some((_, d))) => format!("hello@{d}"),
            (None, None) => {
                return Err(AutomationError::invalid(format!(
                    "step `{}`: no `from` and no verified {stream_s} domain to send from",
                    step.key
                )))
            }
        };

        // enqueue
        let mut tags = vec![json!("lifecycle"), json!(format!("automation:{}", auto.id))];
        if c.cap_exempt {
            tags.push(json!("cap_exempt"));
        }
        let email_id = Uuid::new_v4();
        let status = if pending_approval {
            "pending_approval"
        } else {
            "queued"
        };
        let key = format!("{}:{}:1", run.id, step.key);
        let inserted: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO emails (id, workspace_id, domain_id, stream, source, from_addr, to_addr, reply_to, subject,
               template_id, template_vars, tags, contact_id, automation_run_id, generation_id, idempotency_key, status,
               policy_decisions, next_attempt_at, max_age_at, created_at)
             VALUES ($1,$2,$3,$4,'automation',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$18)
             ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id",
        )
        .bind(email_id)
        .bind(auto.workspace_id)
        .bind(domain.as_ref().map(|d| d.0))
        .bind(stream_s)
        .bind(&from)
        .bind(&contact.email)
        .bind(&c.reply_to)
        .bind(&subject)
        .bind(template_id)
        .bind(&vars)
        .bind(Value::Array(tags))
        .bind(contact.id)
        .bind(run.id)
        .bind(generation_id)
        .bind(&key)
        .bind(status)
        .bind(Value::Array(decisions))
        .bind(now)
        .bind(now + Duration::hours(72))
        .fetch_optional(&mut *tx)
        .await?;
        let Some(email_id) = inserted else {
            return Ok(Out::Goto(
                next,
                json!({"decision":"already_enqueued","idempotency_key":key}),
            ));
        };
        if pending_approval {
            sqlx::query("INSERT INTO approvals (workspace_id, kind, subject_id, payload, created_at) VALUES ($1,'automation_first_send',$2,$3,$4)")
                .bind(auto.workspace_id)
                .bind(email_id)
                .bind(json!({"automation_id": auto.id, "run_id": run.id, "step": step.key, "subject": subject, "to": contact.email}))
                .bind(now)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(m) = ctx.get_mut("_defer").and_then(Value::as_object_mut) {
            m.remove(&defer_key);
        }
        Ok(Out::Goto(
            next,
            json!({"decision":"enqueued","email_id":email_id,"status":status,"subject":subject}),
        ))
    }
}

fn trigger_of(steps: &[Step]) -> Option<(&Step, &TriggerCfg)> {
    steps.iter().find_map(|s| match &s.kind {
        StepKind::Trigger(t) => Some((s, t)),
        _ => None,
    })
}

async fn load_steps(tx: &mut PgConnection, automation_id: Uuid, version: i32) -> Result<Vec<Step>> {
    let steps: Json<Vec<Step>> = sqlx::query_scalar(
        "SELECT steps FROM automation_versions WHERE automation_id = $1 AND version = $2",
    )
    .bind(automation_id)
    .bind(version)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AutomationError::not_found(format!("automation {automation_id} version {version}"))
    })?;
    Ok(steps.0)
}

async fn log_step(
    tx: &mut PgConnection,
    run_id: Uuid,
    key: &str,
    result: Value,
    now: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO automation_run_steps (run_id, step_key, result, at) VALUES ($1,$2,$3,$4)",
    )
    .bind(run_id)
    .bind(key)
    .bind(result)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// End a run and cancel its unsent mail.
async fn exit_run(
    tx: &mut PgConnection,
    run_id: Uuid,
    reason: &str,
    detail: Value,
    now: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "UPDATE automation_runs SET state = 'exited', ended_at = $2, next_wake_at = NULL, wait_event = NULL, wait_filter = NULL,
         context = context || jsonb_build_object('exit_reason', $3::text) WHERE id = $1",
    )
    .bind(run_id)
    .bind(now)
    .bind(reason)
    .execute(&mut *tx)
    .await?;
    let cancelled = sqlx::query(
        "UPDATE emails SET status = 'cancelled' WHERE automation_run_id = $1 AND status IN ('queued','pending_approval','deferred')",
    )
    .bind(run_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    log_step(
        tx,
        run_id,
        &format!("_{reason}"),
        json!({"decision":"exit","reason":reason,"detail":detail,"cancelled_emails":cancelled}),
        now,
    )
    .await
}

/// Persist a step outcome on the run row (the single place run state changes).
#[allow(clippy::type_complexity)]
async fn apply(
    tx: &mut PgConnection,
    run: &RunRow,
    mut ctx: Value,
    step_key: &str,
    out: Out,
    now: DateTime<Utc>,
) -> Result<()> {
    if !matches!(out, Out::Defer { .. }) {
        ctx.as_object_mut().map(|m| m.remove("_attempts"));
    }
    let (state, current, wake, wait_ev, wait_f, ended, result): (
        &str,
        Option<String>,
        Option<DateTime<Utc>>,
        Option<String>,
        Option<Rule>,
        Option<DateTime<Utc>>,
        Value,
    ) = match out {
        Out::Goto(Some(n), r) => ("active", Some(n), Some(now), None, None, None, r),
        Out::Goto(None, r) => ("completed", None, None, None, None, Some(now), r),
        Out::Sleep {
            wake_at,
            next: Some(n),
            result,
        } => ("active", Some(n), Some(wake_at), None, None, None, result),
        Out::Sleep {
            next: None, result, ..
        } => ("completed", None, None, None, None, Some(now), result),
        Out::Wait {
            wake_at,
            event,
            filter,
            result,
        } => (
            "waiting",
            Some(step_key.to_owned()),
            Some(wake_at),
            Some(event),
            filter,
            None,
            result,
        ),
        Out::Defer { until, result } => (
            "active",
            Some(step_key.to_owned()),
            Some(until),
            None,
            None,
            None,
            result,
        ),
        Out::Exit { reason, result } => {
            sqlx::query("UPDATE automation_runs SET context = $2 WHERE id = $1")
                .bind(run.id)
                .bind(&ctx)
                .execute(&mut *tx)
                .await?;
            log_step(tx, run.id, step_key, result.clone(), now).await?;
            return exit_run(tx, run.id, &reason, result, now).await;
        }
    };
    sqlx::query(
        "UPDATE automation_runs SET state=$2, current_step=$3, context=$4, wait_event=$5, wait_filter=$6, next_wake_at=$7, ended_at=$8 WHERE id=$1",
    )
    .bind(run.id)
    .bind(state)
    .bind(current)
    .bind(&ctx)
    .bind(wait_ev)
    .bind(wait_f.map(Json))
    .bind(wake)
    .bind(ended)
    .execute(&mut *tx)
    .await?;
    log_step(tx, run.id, step_key, result, now).await
}

/// Entry rules (SPEC 13), then insert the run. `entry_key` makes redelivery idempotent.
async fn enroll(
    tx: &mut PgConnection,
    a: &AutoRow,
    steps: &[Step],
    contact_id: Uuid,
    entry_key: &str,
    event: Value,
    now: DateTime<Utc>,
) -> Result<Option<Uuid>> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("{}:{contact_id}", a.id))
        .execute(&mut *tx)
        .await?;
    let blocked: bool = match EntryRule::parse(&a.entry_rule) {
        EntryRule::Always => false,
        EntryRule::Once => sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM automation_runs WHERE automation_id = $1 AND contact_id = $2)")
            .bind(a.id)
            .bind(contact_id)
            .fetch_one(&mut *tx)
            .await?,
        EntryRule::AfterDays => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE automation_id = $1 AND contact_id = $2 AND started_at > $3)",
        )
        .bind(a.id)
        .bind(contact_id)
        .bind(now - Duration::days(a.entry_days.unwrap_or(0) as i64))
        .fetch_one(&mut *tx)
        .await?,
        EntryRule::IfNoActiveRun => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE automation_id = $1 AND contact_id = $2 AND state IN ('active','waiting'))",
        )
        .bind(a.id)
        .bind(contact_id)
        .fetch_one(&mut *tx)
        .await?,
    };
    if blocked {
        return Ok(None);
    }
    let first = trigger_of(steps)
        .and_then(|(s, _)| s.edge("next"))
        .map(str::to_owned);
    let (state, wake, ended) = if first.is_some() {
        ("active", Some(now), None)
    } else {
        ("completed", None, Some(now))
    };
    Ok(sqlx::query_scalar(
        "INSERT INTO automation_runs (automation_id, version, contact_id, entry_key, state, current_step, context, next_wake_at, started_at, ended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (automation_id, contact_id, entry_key) DO NOTHING RETURNING id",
    )
    .bind(a.id)
    .bind(a.current_version)
    .bind(contact_id)
    .bind(entry_key)
    .bind(state)
    .bind(first)
    .bind(json!({"event": event, "wait_events": {}}))
    .bind(wake)
    .bind(now)
    .bind(ended)
    .fetch_optional(&mut *tx)
    .await?)
}
