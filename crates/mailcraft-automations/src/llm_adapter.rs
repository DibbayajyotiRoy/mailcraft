//! Glue: automations' [`Personalizer`] over the guarded `mailcraft-llm` pipeline.
//! Engine/server call [`personalizer_from_env`]; without a provider key it is [`NoopPersonalizer`].
use crate::personalize::{
    NoopPersonalizer, PersonalizeError, PersonalizeRequest, Personalized, Personalizer, SlotSpec,
};
use async_trait::async_trait;
use mailcraft_llm::{
    BudgetLimits, EmailTemplate, Guardrails, LlmPersonalizer, LlmSettings, NoopSpamChecker,
    Outcome, PersonalizeRequest as LlmReq, Personalizer as _, PgBudget, Report, Slots,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

pub struct LlmAdapter {
    pub inner: LlmPersonalizer,
    pub pool: PgPool,
    /// Extra banned-term regexes appended to the default pack.
    // ponytail: process-wide; per-workspace banned terms need a workspace settings column.
    pub extra_banned_terms: Vec<String>,
}

/// LLM pipeline when a provider is configured (OPENROUTER_API_KEY by default, see
/// `LlmSettings`), else [`NoopPersonalizer`] so the product runs without a key.
pub fn personalizer_from_env(pool: PgPool) -> Arc<dyn Personalizer> {
    personalizer_from_lookup(pool, |k| {
        std::env::var(k).ok().filter(|v| !v.trim().is_empty())
    })
}

pub fn personalizer_from_lookup(
    pool: PgPool,
    get: impl Fn(&str) -> Option<String>,
) -> Arc<dyn Personalizer> {
    let num = |k: &str, d: f64| get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let built = LlmSettings::from_lookup(&get)
        .map_err(|e| e.to_string())
        .and_then(|s| s.build().map_err(|e| e.to_string()));
    match built {
        Ok((provider, model)) => {
            let limits = BudgetLimits {
                max_tokens_per_day: num("MAILCRAFT_LLM_MAX_TOKENS_PER_DAY", 2_000_000.0) as u64,
                max_cost_usd_per_day: num("MAILCRAFT_LLM_MAX_COST_USD_PER_DAY", 5.0),
            };
            let inner = LlmPersonalizer::new(
                Arc::new(provider),
                model,
                Arc::new(NoopSpamChecker),
                Arc::new(PgBudget::new(pool.clone(), limits)),
            );
            Arc::new(LlmAdapter {
                inner,
                pool,
                extra_banned_terms: get("MAILCRAFT_LLM_BANNED_TERMS")
                    .map(|v| v.split(';').map(str::to_owned).collect())
                    .unwrap_or_default(),
            })
        }
        Err(e) => {
            tracing::info!(reason = %e, "no LLM provider configured; send_email llm steps use fallback copy");
            Arc::new(NoopPersonalizer)
        }
    }
}

/// Template slot declarations in the LLM crate's shape (the dynamic contract).
pub fn llm_specs(specs: &[SlotSpec]) -> Vec<mailcraft_llm::SlotSpec> {
    specs
        .iter()
        .map(|s| mailcraft_llm::SlotSpec {
            name: s.name.clone(),
            max_len: s.max_len,
            instructions: s.instructions.clone(),
            fallback: s.fallback.clone(),
        })
        .collect()
}

/// Map a pipeline report back to `Personalized` by slot name. `used_fallback` only when the
/// pipeline fell back; a declared slot absent from a non-fallback report counts as a fallback
/// too (the validator makes that unreachable, but a slot must never silently keep its fallback).
pub fn map_report(specs: &[SlotSpec], report: &Report) -> Personalized {
    let mut out = Personalized::default();
    let complete = specs.iter().all(|s| report.values.contains_key(&s.name));
    if report.outcome == Outcome::Fallback || !complete {
        // Engine renders the template subject and per-slot fallbacks.
        out.used_fallback = true;
        return out;
    }
    out.subject = report.values.get("subject").cloned();
    out.preheader = report.values.get("preheader").cloned();
    for s in specs {
        out.slots
            .insert(s.name.clone(), report.values[&s.name].clone());
    }
    out
}

#[async_trait]
impl Personalizer for LlmAdapter {
    async fn personalize(&self, req: PersonalizeRequest) -> Result<Personalized, PersonalizeError> {
        let err = |e: sqlx::Error| PersonalizeError(e.to_string());
        let specs = &req.slots;
        let mut guardrails = Guardrails::default();
        guardrails
            .banned_terms
            .extend(self.extra_banned_terms.iter().cloned());
        // Links may only point at the workspace's own sending / tracking hosts.
        let hosts: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT name, tracking_host FROM domains WHERE workspace_id = $1")
                .bind(req.workspace_id)
                .fetch_all(&self.pool)
                .await
                .map_err(err)?;
        guardrails.allowed_link_domains = hosts
            .into_iter()
            .flat_map(|(n, t)| [Some(n), t])
            .flatten()
            .collect();

        let settings: Value = sqlx::query_scalar("SELECT settings FROM workspaces WHERE id = $1")
            .bind(req.workspace_id)
            .fetch_one(&self.pool)
            .await
            .map_err(err)?;
        let custom_instructions = mailcraft_llm::merge_custom_instructions(
            settings["llm"]["custom_instructions"].as_str(),
            req.custom_instructions.as_deref(),
        );
        let instructions = req.instructions.clone().unwrap_or_default();
        // Unused by the dynamic contract (the engine applies per-slot fallbacks); required by the API.
        let fallback = Slots {
            subject: req.subject_template.clone(),
            preheader: String::new(),
            greeting: String::new(),
            body_paragraphs: vec![],
            cta_label: String::new(),
        };
        // Template-owned parts are only used to score the final message; the engine renders the real one.
        let template = EmailTemplate {
            cta_url: "https://example.com/".into(),
            signature: String::new(),
            footer: String::new(),
            unsubscribe_url: "https://example.com/unsubscribe".into(),
        };
        let report = self
            .inner
            .personalize(LlmReq {
                workspace_id: req.workspace_id.to_string(),
                step: req.step_key.clone(),
                instructions,
                context: req.context.clone(),
                guardrails,
                template,
                fallback,
                renderer: None,
                model: None,
                custom_instructions,
                slot_specs: llm_specs(specs),
            })
            .await;
        let generation_id = self.record(&req, &report).await.map_err(err)?;
        let mut out = map_report(specs, &report);
        out.generation_id = Some(generation_id);
        Ok(out)
    }
}

impl LlmAdapter {
    /// One `llm_generations` row per attempt (one synthetic row when no model was called).
    /// Returns the id of the last row: the one whose output (or fallback) was used.
    async fn record(&self, req: &PersonalizeRequest, r: &Report) -> Result<Uuid, sqlx::Error> {
        let fell_back = r.outcome == Outcome::Fallback;
        let mut tx = self.pool.begin().await?;
        let none = [Default::default()];
        let attempts = if r.attempts.is_empty() {
            &none[..]
        } else {
            &r.attempts[..]
        };
        let mut last = Uuid::nil();
        for (i, a) in attempts.iter().enumerate() {
            let is_last = i + 1 == attempts.len();
            let mut issues: Vec<Value> =
                a.violations.iter().map(|v| json!(v.to_string())).collect();
            issues.extend(a.error.iter().map(|e| json!(e)));
            if is_last {
                issues.extend(r.fallback_reason.iter().map(|e| json!(e)));
            }
            let passed = a.violations.is_empty() && a.error.is_none() && !(is_last && fell_back);
            let validator = json!({
                "passed": passed, "issues": issues,
                "spam_score": a.spam.as_ref().map(|s| s.score), "tokens": a.tokens,
            });
            let output = match (&a.raw, is_last && !fell_back) {
                (_, true) if !r.values.is_empty() => serde_json::to_value(&r.values).ok(),
                (_, true) => serde_json::to_value(&r.slots).ok(),
                (Some(raw), _) => Some(serde_json::from_str(raw).unwrap_or(json!(raw))),
                _ => None,
            };
            (last,) = sqlx::query_as(
                "INSERT INTO llm_generations (workspace_id, provider, model, automation_id, context_hash,
                   prompt_version, output, validator, attempt, used_fallback, cost_usd, request_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::float8,$12) RETURNING id",
            )
            .bind(req.workspace_id)
            .bind(&r.provider)
            .bind(&r.model)
            .bind(req.automation_id)
            .bind(&r.context_hash)
            .bind(&r.prompt_version)
            .bind(output)
            .bind(validator)
            .bind(i as i32 + 1)
            .bind(is_last && fell_back)
            .bind(a.cost_usd)
            .bind(&a.request_id)
            .fetch_one(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(last)
    }
}
