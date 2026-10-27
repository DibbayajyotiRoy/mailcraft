//! Fixtures from journeys.md (J2, J5, J6, J7) with mocked model outputs.
use async_trait::async_trait;
use mailcraft_core::llm::{GenerateResult, Usage};
use mailcraft_llm::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// Scripted provider: pops queued raw outputs, records requests.
struct Mock {
    outputs: Mutex<Vec<String>>,
    seen: Mutex<Vec<GenerateRequest>>,
}
impl Mock {
    fn new(outs: Vec<String>) -> Arc<Self> {
        Arc::new(Self {
            outputs: Mutex::new(outs.into_iter().rev().collect()),
            seen: Mutex::default(),
        })
    }
    fn calls(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}
#[async_trait]
impl LlmProvider for Mock {
    fn id(&self) -> &'static str {
        "mock"
    }
    async fn generate(&self, r: GenerateRequest) -> Result<GenerateResult, LlmError> {
        self.seen.lock().unwrap().push(r);
        let text = self
            .outputs
            .lock()
            .unwrap()
            .pop()
            .ok_or_else(|| LlmError::Transient("empty".into()))?;
        // same contract as OpenAiCompat: parsed JSON, or the raw text as a string
        let json = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok(GenerateResult {
            json,
            model: "m".into(),
            request_id: None,
            cost_usd: Some(0.001),
            usage: Usage {
                prompt_tokens: 100,
                completion_tokens: 50,
            },
        })
    }
}

struct Journey {
    id: &'static str,
    context: Value,
    good: Slots,
    fallback: Slots,
}
fn s(subject: &str, pre: &str, greeting: &str, body: &[&str], cta: &str) -> Slots {
    Slots {
        subject: subject.into(),
        preheader: pre.into(),
        greeting: greeting.into(),
        body_paragraphs: body.iter().map(|x| x.to_string()).collect(),
        cta_label: cta.into(),
    }
}
fn fb(id: &str) -> Slots {
    s(
        &format!("Spicrawl: {id}"),
        "A note from Spicrawl",
        "Hi there,",
        &["Static fallback copy."],
        "Open the docs",
    )
}

fn journeys() -> Vec<Journey> {
    vec![
        Journey { id: "J2", fallback: fb("J2"),
            context: json!({"first_name":"Ana","role":"engineer","use_cases":["price monitoring"],"endpoints":["batch"],
                "has_default_key":true,"onboarding_completed":true,"hours_since_signup":24,"plan_credits":1000,
                "docs_url":"https://docs.spicrawl.com/batch"}),
            good: s("Your API key is ready", "A short path to your first request", "Hi Ana,",
                &["You signed up about 24 hours ago and your default key is ready.",
                  "You mentioned price monitoring, so the batch endpoint is a good first call. The free plan has 1,000 credits per month and failed requests cost 0."],
                "Open the batch docs") },
        Journey { id: "J5", fallback: fb("J5"),
            context: json!({"first_name":"Sam","requests_total":5,"active_days":2,"last_active":"2026-10-23",
                "top_hosts":["shop.example.com","news.example.org"],"success_pct_30d":0.9,"top_errors":[]}),
            good: s("What got in the way?", "You ran a few requests, then stopped", "Hi Sam,",
                &["You ran 5 requests against shop.example.com and news.example.org, then stopped on 2026-10-23.",
                  "What blocked you? Reply with one line and I will point you to the right docs page."],
                "Open the docs") },
        Journey { id: "J6", fallback: fb("J6"),
            context: json!({"first_name":"Ana","failures":[{"host":"example.com","error_code":"ERR::UPSTREAM::CHALLENGE","http_status":403,
                "count":4,"last_seen":"2026-10-26T14:03:00Z","sample_detail":"challenge page","charged_credits":0,"used_js_render":false,
                "allowed_advice":["js_render=true"],"doc_url":"https://docs.spicrawl.com/docs/errors#UPSTREAM_CHALLENGE"}],
                "requests_total":9,"success_pct_30d":0.44}),
            good: s("example.com returned a challenge page", "It cost 0 credits", "Hi Ana,",
                &["On 2026-10-26 example.com returned a challenge page (ERR::UPSTREAM::CHALLENGE, HTTP 403) 4 times. These requests cost 0 credits.",
                  "You can try js_render=true. The verdict is per exit, so a retry sometimes succeeds."],
                "Read the error docs") },
        Journey { id: "J7", fallback: fb("J7"),
            context: json!({"first_name":"Lee","threshold":80,"used":800,"limit":1000,"resets_at":"2026-11-01"}),
            good: s("You have used 80% of your credits", "800 of 1000 credits so far", "Hi Lee,",
                &["You have used 800 of 1000 credits this month. Your credits reset on 2026-11-01."],
                "See your usage") },
    ]
}

type Mutate = fn(&mut Slots);
fn mutations() -> Vec<(&'static str, Mutate, &'static str)> {
    vec![
        (
            "hallucinated link",
            |s| {
                s.body_paragraphs
                    .push("Details at https://docs.spicrawl-help.io/fix".into())
            },
            "url",
        ),
        (
            "invented feature",
            |s| s.body_paragraphs[0].push_str(" Our crawl endpoint follows links across the site."),
            "banned_term",
        ),
        (
            "leftover placeholder",
            |s| s.greeting = "Hi {{first_name}},".into(),
            "placeholder",
        ),
    ]
}

fn template() -> EmailTemplate {
    EmailTemplate {
        cta_url: "https://app.spicrawl.com/dashboard".into(),
        signature: "Roy, Spicrawl".into(),
        footer: "Spicrawl, 1 Example St".into(),
        unsubscribe_url: "https://app.spicrawl.com/unsub/abc".into(),
    }
}
fn generator(p: Arc<Mock>, budget: Arc<dyn BudgetGuard>, spam: Arc<dyn SpamChecker>) -> Generator {
    Generator {
        provider: p,
        validator: Validator::new(ValidatorConfig::spicrawl()).unwrap(),
        spam,
        spam_cfg: SpamConfig::default(),
        budget,
        temperature: 0.4,
        max_tokens: 400,
    }
}
fn job(j: &Journey) -> GenerateJob {
    GenerateJob {
        tenant: "t1".into(),
        journey: j.id.into(),
        model: "deepseek/deepseek-v4-flash".into(),
        system_prompt: "Use only facts present in context.".into(),
        prompt_version: "t1".into(),
        renderer: None,
        instructions: "Write the slots.".into(),
        context: j.context.clone(),
        template: template(),
        fallback: j.fallback.clone(),
        custom_instructions: None,
        slot_specs: vec![],
    }
}
fn raw(s: &Slots) -> String {
    serde_json::to_string(s).unwrap()
}

#[tokio::test]
async fn good_output_passes_first_try() {
    for j in journeys() {
        let m = Mock::new(vec![raw(&j.good)]);
        let r = generator(m.clone(), Arc::new(NoBudget), Arc::new(NoopSpamChecker))
            .run(&job(&j))
            .await;
        assert_eq!(
            r.outcome,
            Outcome::Passed,
            "{}: {:?}",
            j.id,
            r.attempts[0].violations
        );
        assert_eq!(r.slots, j.good);
        assert_eq!(m.calls(), 1);
        assert_eq!(r.total_tokens, 150);
    }
}

#[tokio::test]
async fn bad_then_good_is_repaired_with_errors_fed_back() {
    for j in journeys() {
        for (name, mutate, rule) in mutations() {
            let mut bad = j.good.clone();
            mutate(&mut bad);
            let m = Mock::new(vec![raw(&bad), raw(&j.good)]);
            let r = generator(m.clone(), Arc::new(NoBudget), Arc::new(NoopSpamChecker))
                .run(&job(&j))
                .await;
            assert_eq!(r.outcome, Outcome::Repaired, "{} {name}", j.id);
            assert_eq!(r.slots, j.good);
            assert!(
                r.attempts[0].violations.iter().any(|v| v.rule == rule),
                "{} {name}: {:?}",
                j.id,
                r.attempts[0].violations
            );
            // repair request carries the previous output and the validator errors
            let seen = m.seen.lock().unwrap();
            assert_eq!(seen.len(), 2);
            let last = seen[1].messages.last().unwrap();
            assert!(
                last.content.contains(&format!("[{rule}]")),
                "{}",
                last.content
            );
            assert_eq!(seen[1].messages[2].role, "assistant");
        }
    }
}

#[tokio::test]
async fn bad_twice_falls_back_to_static_copy() {
    for j in journeys() {
        for (name, mutate, _) in mutations() {
            let mut bad = j.good.clone();
            mutate(&mut bad);
            let m = Mock::new(vec![raw(&bad), raw(&bad)]);
            let r = generator(m.clone(), Arc::new(NoBudget), Arc::new(NoopSpamChecker))
                .run(&job(&j))
                .await;
            assert_eq!(r.outcome, Outcome::Fallback, "{} {name}", j.id);
            assert_eq!(r.slots, j.fallback);
            assert_eq!(m.calls(), 2, "exactly one repair attempt");
            assert_eq!(
                r.fallback_reason.as_deref(),
                Some("validation_failed_after_repair")
            );
        }
    }
}

#[tokio::test]
async fn invalid_json_and_unknown_slot_are_repairable() {
    let j = &journeys()[0];
    let m = Mock::new(vec!["Sure! here is your email".into(), raw(&j.good)]);
    let r = generator(m, Arc::new(NoBudget), Arc::new(NoopSpamChecker))
        .run(&job(j))
        .await;
    assert_eq!(r.outcome, Outcome::Repaired);
    assert_eq!(r.attempts[0].violations[0].rule, "invalid_json");

    // model tries to add its own footer slot -> rejected by deny_unknown_fields
    let mut v: Value = serde_json::to_value(&j.good).unwrap();
    v["unsubscribe_url"] = json!("https://evil.example/u");
    let m = Mock::new(vec![v.to_string(), raw(&j.good)]);
    let r = generator(m, Arc::new(NoBudget), Arc::new(NoopSpamChecker))
        .run(&job(j))
        .await;
    assert_eq!(r.outcome, Outcome::Repaired);
}

#[tokio::test]
async fn budget_exhausted_skips_the_model() {
    let j = &journeys()[0];
    let b = Arc::new(InMemoryBudget::new(
        BudgetLimits {
            max_tokens_per_day: 100,
            max_cost_usd_per_day: 1.0,
        },
        || 1,
    ));
    let m = Mock::new(vec![raw(&j.good)]);
    let r = generator(m.clone(), b, Arc::new(NoopSpamChecker))
        .run(&job(j))
        .await;
    assert_eq!(r.outcome, Outcome::Fallback);
    assert_eq!(m.calls(), 0);
    assert!(r.fallback_reason.unwrap().starts_with("budget"));
}

#[tokio::test]
async fn budget_is_settled_to_actual_usage_per_call() {
    let j = &journeys()[0];
    let b = Arc::new(InMemoryBudget::new(
        BudgetLimits {
            max_tokens_per_day: 100_000,
            max_cost_usd_per_day: 1.0,
        },
        || 1,
    ));
    let mut bad = j.good.clone();
    bad.greeting = "Hi {{x}},".into();
    let m = Mock::new(vec![raw(&bad), raw(&j.good)]);
    let r = generator(m, b.clone(), Arc::new(NoopSpamChecker))
        .run(&job(j))
        .await;
    assert_eq!(r.outcome, Outcome::Repaired);
    let (t, c) = b.used("t1");
    assert_eq!(t, 300); // 2 calls x 150, reservations replaced by actuals
    assert!((c - 0.002).abs() < 1e-9);
}

#[tokio::test]
async fn provider_error_refunds_the_reservation() {
    let j = &journeys()[0];
    let b = Arc::new(InMemoryBudget::new(
        BudgetLimits {
            max_tokens_per_day: 100_000,
            max_cost_usd_per_day: 1.0,
        },
        || 1,
    ));
    let r = generator(Mock::new(vec![]), b.clone(), Arc::new(NoopSpamChecker))
        .run(&job(j))
        .await;
    assert_eq!(r.outcome, Outcome::Fallback);
    assert_eq!(b.used("t1").0, 0);
}

#[tokio::test]
async fn missing_provider_cost_uses_price_table() {
    struct NoCost;
    #[async_trait]
    impl LlmProvider for NoCost {
        fn id(&self) -> &'static str {
            "openai"
        }
        async fn generate(&self, _: GenerateRequest) -> Result<GenerateResult, LlmError> {
            Ok(GenerateResult {
                json: Value::String("nope".into()),
                model: "m".into(),
                request_id: None,
                cost_usd: None,
                usage: Usage {
                    prompt_tokens: 1_000_000,
                    completion_tokens: 0,
                },
            })
        }
    }
    let j = &journeys()[0];
    let g = Generator {
        provider: Arc::new(NoCost),
        validator: Validator::new(ValidatorConfig::spicrawl()).unwrap(),
        spam: Arc::new(NoopSpamChecker),
        spam_cfg: SpamConfig::default(),
        budget: Arc::new(NoBudget),
        temperature: 0.4,
        max_tokens: 400,
    };
    let r = g.run(&job(j)).await; // model "deepseek/deepseek-v4-flash" -> $0.14 per 1M input, 2 attempts
    assert!(
        (r.total_cost_usd - 0.28).abs() < 1e-9,
        "{}",
        r.total_cost_usd
    );
    assert_eq!(r.provider, "openai");
    assert_eq!(r.context_hash.len(), 64);
}

#[tokio::test]
async fn spam_runs_on_the_final_rendered_bytes() {
    struct Renderer;
    impl MessageRenderer for Renderer {
        fn render(&self, s: &Slots) -> Result<Vec<u8>, String> {
            Ok(format!("FINAL-MIME|{}", s.subject).into_bytes())
        }
    }
    struct Capture(Mutex<Vec<u8>>);
    #[async_trait]
    impl SpamChecker for Capture {
        async fn check(&self, m: &[u8]) -> Result<SpamVerdict, String> {
            *self.0.lock().unwrap() = m.to_vec();
            Ok(SpamVerdict {
                score: 0.0,
                symbols: vec![],
            })
        }
    }
    let j = &journeys()[0];
    let cap = Arc::new(Capture(Mutex::default()));
    let mut jb = job(j);
    jb.renderer = Some(Arc::new(Renderer));
    let r = generator(
        Mock::new(vec![raw(&j.good)]),
        Arc::new(NoBudget),
        cap.clone(),
    )
    .run(&jb)
    .await;
    assert_eq!(r.outcome, Outcome::Passed);
    assert_eq!(
        cap.0.lock().unwrap().as_slice(),
        format!("FINAL-MIME|{}", j.good.subject).as_bytes()
    );
}

struct FixedSpam(f64);
#[async_trait]
impl SpamChecker for FixedSpam {
    async fn check(&self, _: &[u8]) -> Result<SpamVerdict, String> {
        Ok(SpamVerdict {
            score: self.0,
            symbols: vec![("BAD_SYM".into(), self.0)],
        })
    }
}
struct DownSpam;
#[async_trait]
impl SpamChecker for DownSpam {
    async fn check(&self, _: &[u8]) -> Result<SpamVerdict, String> {
        Err("connection refused".into())
    }
}

#[tokio::test]
async fn spam_score_over_threshold_triggers_repair_then_fallback() {
    let j = &journeys()[3];
    let m = Mock::new(vec![raw(&j.good), raw(&j.good)]);
    let r = generator(m.clone(), Arc::new(NoBudget), Arc::new(FixedSpam(5.0)))
        .run(&job(j))
        .await;
    assert_eq!(r.outcome, Outcome::Fallback);
    assert_eq!(m.calls(), 2);
    assert!(r.attempts[0].violations[0].detail.contains("BAD_SYM"));
    let r = generator(
        Mock::new(vec![raw(&j.good)]),
        Arc::new(NoBudget),
        Arc::new(FixedSpam(2.9)),
    )
    .run(&job(j))
    .await;
    assert_eq!(r.outcome, Outcome::Passed);
}

#[tokio::test]
async fn spam_checker_down_fail_closed_vs_open() {
    let j = &journeys()[3];
    let m = Mock::new(vec![raw(&j.good)]);
    let r = generator(m, Arc::new(NoBudget), Arc::new(DownSpam))
        .run(&job(j))
        .await;
    assert_eq!(r.outcome, Outcome::Fallback);
    let mut g = generator(
        Mock::new(vec![raw(&j.good)]),
        Arc::new(NoBudget),
        Arc::new(DownSpam),
    );
    g.spam_cfg.fail_open = true;
    assert_eq!(g.run(&job(j)).await.outcome, Outcome::Passed);
}

#[tokio::test]
async fn provider_error_falls_back_without_repair() {
    let j = &journeys()[0];
    let m = Mock::new(vec![]); // pops None -> LlmError::Empty
    let r = generator(m.clone(), Arc::new(NoBudget), Arc::new(NoopSpamChecker))
        .run(&job(j))
        .await;
    assert_eq!(r.outcome, Outcome::Fallback);
    assert!(r.fallback_reason.unwrap().starts_with("provider_error"));
    assert_eq!(m.calls(), 1);
}

#[tokio::test]
async fn template_owns_links_and_footer() {
    let j = &journeys()[2];
    let t = template().render_text(&j.good);
    assert!(t.contains("Read the error docs: https://app.spicrawl.com/dashboard"));
    assert!(t.contains("Unsubscribe: https://app.spicrawl.com/unsub/abc"));
    assert!(t.contains("Spicrawl, 1 Example St"));
}
