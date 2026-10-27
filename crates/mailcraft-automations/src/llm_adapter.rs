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

fn fb<'a>(specs: &'a [SlotSpec], name: &str) -> Option<&'a str> {
    specs
        .iter()
        .find(|s| s.name == name)
        .and_then(|s| s.fallback.as_deref())
}

// ponytail: mailcraft-llm has 5 fixed slots; templates declare named ones. Only slots named
// like the contract (`body` = body_paragraphs) are LLM-filled; any other name keeps its static
// fallback. Upgrade: a dynamic-slots contract (schema built from SlotSpec) in mailcraft-llm.
fn is_body(n: &str) -> bool {
    n == "body" || n == "body_paragraphs"
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

        let mut instructions = req.instructions.clone().unwrap_or_default();
        for s in specs {
            if let Some(i) = &s.instructions {
                instructions.push_str(&format!("\nSlot `{}`: {i}", s.name));
            }
        }
        let fallback = Slots {
            subject: fb(specs, "subject").unwrap_or(&req.subject_template).into(),
            preheader: fb(specs, "preheader").unwrap_or_default().into(),
            greeting: fb(specs, "greeting").unwrap_or_default().into(),
            body_paragraphs: specs
                .iter()
                .find(|s| is_body(&s.name))
                .and_then(|s| s.fallback.as_deref())
                .map(|b| b.split("\n\n").map(str::to_owned).collect())
                .unwrap_or_default(),
            cta_label: fb(specs, "cta_label").unwrap_or_default().into(),
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
                custom_instructions: None,
            })
            .await;
        let generation_id = self.record(&req, &report).await.map_err(err)?;
        let fell_back = report.outcome == Outcome::Fallback;
        let mut out = Personalized {
            generation_id: Some(generation_id),
            used_fallback: fell_back,
            ..Default::default()
        };
        if fell_back {
            // Engine renders the template subject and per-slot fallbacks.
            return Ok(out);
        }
        let s = report.slots;
        out.subject = Some(s.subject.clone());
        out.preheader = Some(s.preheader.clone());
        for spec in specs {
            let text = match spec.name.as_str() {
                "greeting" => s.greeting.clone(),
                "cta_label" => s.cta_label.clone(),
                "subject" => s.subject.clone(),
                "preheader" => s.preheader.clone(),
                n if is_body(n) => s.body_paragraphs.join("\n\n"),
                _ => continue,
            };
            // Over max_len: leave unset so the engine uses the slot's fallback.
            if spec.max_len.is_none_or(|m| text.chars().count() <= m) {
                out.slots.insert(spec.name.clone(), text);
            }
        }
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
