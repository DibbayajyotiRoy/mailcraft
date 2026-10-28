use async_trait::async_trait;
use mailcraft_core::llm::{GenerateRequest, GenerateResult, LlmError, LlmProvider, Usage};
use mailcraft_llm::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct Scripted(Mutex<Vec<String>>, Mutex<usize>);
#[async_trait]
impl LlmProvider for Scripted {
    fn id(&self) -> &'static str {
        "mock"
    }
    async fn generate(&self, _: GenerateRequest) -> Result<GenerateResult, LlmError> {
        *self.1.lock().unwrap() += 1;
        let t = self.0.lock().unwrap().remove(0);
        Ok(GenerateResult {
            json: serde_json::from_str(&t).unwrap_or(Value::String(t)),
            usage: Usage {
                prompt_tokens: 10,
                completion_tokens: 5,
            },
            cost_usd: Some(0.0001),
            model: "m".into(),
            request_id: None,
        })
    }
}

fn slots(body: &str) -> Slots {
    Slots {
        subject: "Your trial ends soon".into(),
        preheader: "A quick note".into(),
        greeting: "Hi Ana,".into(),
        body_paragraphs: vec![body.into()],
        cta_label: "Open the app".into(),
    }
}
fn req(g: Guardrails) -> PersonalizeRequest {
    PersonalizeRequest {
        workspace_id: "ws".into(),
        step: "welcome".into(),
        instructions: "Write.".into(),
        context: json!({"first_name": "Ana", "days_left": 3}),
        guardrails: g,
        template: EmailTemplate {
            cta_url: "https://app.example.com".into(),
            signature: "S".into(),
            footer: "F".into(),
            unsubscribe_url: "https://app.example.com/u".into(),
        },
        fallback: slots("Static copy."),
        renderer: None,
        model: None,
        custom_instructions: None,
        slot_specs: vec![],
    }
}
fn p(outs: Vec<Slots>) -> (LlmPersonalizer, Arc<Scripted>) {
    let m = Arc::new(Scripted(
        Mutex::new(
            outs.iter()
                .map(|s| serde_json::to_string(s).unwrap())
                .collect(),
        ),
        Mutex::new(0),
    ));
    (
        LlmPersonalizer::new(
            m.clone(),
            "nvidia/nemotron-3.5-super-vl:free",
            Arc::new(NoopSpamChecker),
            Arc::new(NoBudget),
        ),
        m,
    )
}

#[tokio::test]
async fn valid_output_passes() {
    let (pz, _) = p(vec![slots("You have 3 days left in your trial.")]);
    let r = pz.personalize(req(Guardrails::default())).await;
    assert_eq!(r.outcome, Outcome::Passed);
    assert_eq!(r.prompt_version, PROMPT_VERSION);
    assert_eq!(
        r.slots.body_paragraphs[0],
        "You have 3 days left in your trial."
    );
}

#[tokio::test]
async fn tenant_banned_terms_and_default_pack_apply() {
    let bad = slots("You have 3 days left, we guarantee results.");
    let (pz, m) = p(vec![bad.clone(), bad]);
    let r = pz.personalize(req(Guardrails::default())).await;
    assert_eq!(r.outcome, Outcome::Fallback);
    assert_eq!(r.slots, slots("Static copy."));
    assert_eq!(*m.1.lock().unwrap(), 2);

    let g = Guardrails {
        banned_terms: vec!["trial".into()],
        ..Guardrails::default()
    };
    let (pz, _) = p(vec![slots("You have 3 days left in your trial."); 2]);
    assert_eq!(pz.personalize(req(g)).await.outcome, Outcome::Fallback);
}

#[tokio::test]
async fn allowed_link_domains_gate_hosts() {
    let linked = slots("You have 3 days left. See docs.example.com for details.");
    let (pz, _) = p(vec![linked.clone(), linked.clone()]);
    assert_eq!(
        pz.personalize(req(Guardrails::default())).await.outcome,
        Outcome::Fallback
    );
    let g = Guardrails {
        allowed_link_domains: vec!["*.example.com".into()],
        ..Guardrails::default()
    };
    let (pz, _) = p(vec![linked]);
    assert_eq!(pz.personalize(req(g)).await.outcome, Outcome::Passed);
}

#[tokio::test]
async fn bad_guardrail_regex_falls_back_without_calling_the_model() {
    let (pz, m) = p(vec![]);
    let g = Guardrails {
        banned_terms: vec!["(".into()],
        ..Guardrails::default()
    };
    let r = pz.personalize(req(g)).await;
    assert_eq!(r.outcome, Outcome::Fallback);
    assert!(r.fallback_reason.unwrap().starts_with("invalid_guardrails"));
    assert_eq!(*m.1.lock().unwrap(), 0);
}

fn greet(greeting: &str, body: &str) -> Slots {
    Slots {
        greeting: greeting.into(),
        ..slots(body)
    }
}

#[tokio::test]
async fn repeated_greeting_is_repaired_then_falls_back() {
    // bake-off J5/J7 shapes
    let bad = greet("Hi Ana", "Hi Ana, you have 3 days left.");
    let good = slots("You have 3 days left in your trial. What are you building?");
    let (pz, m) = p(vec![bad.clone(), good.clone()]);
    let r = pz.personalize(req(Guardrails::default())).await;
    assert_eq!((r.outcome, *m.1.lock().unwrap()), (Outcome::Repaired, 2));
    assert_eq!(r.slots, good);

    let (pz, _) = p(vec![bad.clone(), bad]);
    let r = pz.personalize(req(Guardrails::default())).await;
    assert_eq!(r.outcome, Outcome::Fallback);
}

#[test]
fn api_product_guardrail_pack_is_selectable() {
    let g = Guardrails::api_product();
    assert!(g.banned_terms.iter().any(|t| t.contains("camoufox")));
    assert!(g.allowed_link_domains.is_empty());
    assert_eq!(g.spam_threshold, Guardrails::default().spam_threshold);
}

#[tokio::test]
async fn paid_openrouter_model_falls_back_to_static_copy_without_a_call() {
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let srv = MockServer::start().await;
    Mock::given(wiremock::matchers::method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&srv)
        .await;
    // Paid configured default, then a paid per-call override on a free default.
    for (default, per_call) in [
        ("deepseek/deepseek-v4-flash", None),
        (
            "nvidia/nemotron-3.5-super-vl:free",
            Some("deepseek/deepseek-v4-flash"),
        ),
    ] {
        let cfg = OpenAiCompatConfig::openrouter("k", "r", "t").with_base_url(&srv.uri());
        let pz = LlmPersonalizer::new(
            Arc::new(OpenAiCompat::new(cfg).unwrap()),
            default,
            Arc::new(NoopSpamChecker),
            Arc::new(NoBudget),
        );
        let mut rq = req(Guardrails::default());
        rq.model = per_call.map(Into::into);
        let r = pz.personalize(rq).await;
        assert_eq!(r.outcome, Outcome::Fallback);
        assert_eq!(r.slots, slots("Static copy."));
        let why = r.fallback_reason.unwrap();
        assert!(
            why.starts_with("provider_error") && why.contains("not a :free"),
            "{why}"
        );
    }
    assert!(srv.received_requests().await.unwrap().is_empty());
}
