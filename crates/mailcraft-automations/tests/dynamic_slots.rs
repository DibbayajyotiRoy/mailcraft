//! Dynamic slot contract end to end: wiremock LLM -> LlmPersonalizer -> adapter mapping -> render.
//! No Postgres, no live calls.
use mailcraft_automations::{
    llm_adapter::{llm_specs, map_report},
    Personalized, SlotSpec,
};
use mailcraft_llm::{
    EmailTemplate, Guardrails, LlmPersonalizer, LlmSettings, NoBudget, NoopSpamChecker, Outcome,
    PersonalizeRequest, Personalizer, Report, Slots,
};
use mailcraft_templates::{render_html, Block, Template};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use wiremock::{matchers::method, Mock, MockServer, Request, Respond, ResponseTemplate};

/// Replies with the scripted contents in order (last one repeats) and records request bodies.
struct Script(Mutex<Vec<Value>>, Arc<Mutex<Vec<Value>>>);
impl Respond for Script {
    fn respond(&self, r: &Request) -> ResponseTemplate {
        self.1
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&r.body).unwrap());
        let mut q = self.0.lock().unwrap();
        let c = if q.len() > 1 {
            q.remove(0)
        } else {
            q[0].clone()
        };
        ResponseTemplate::new(200).set_body_json(json!({
            "id": "g", "model": "m",
            "choices": [{"message": {"content": c.to_string()}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20}
        }))
    }
}

fn spec(name: &str, max_len: Option<usize>, fallback: &str) -> SlotSpec {
    SlotSpec {
        name: name.into(),
        max_len,
        instructions: Some(format!("Write the {name}.")),
        fallback: Some(fallback.into()),
    }
}

fn template(specs: &[SlotSpec]) -> Template {
    let blocks = specs
        .iter()
        .map(|s| Block::Slot {
            name: s.name.clone(),
            max_len: s.max_len,
            instructions: s.instructions.clone(),
            fallback: s.fallback.clone(),
        })
        .collect();
    Template::new("Welcome", blocks)
}

async fn run(specs: &[SlotSpec], replies: Vec<Value>, legacy: bool) -> (Report, Vec<Value>) {
    let srv = MockServer::start().await;
    let seen = Arc::new(Mutex::new(vec![]));
    Mock::given(method("POST"))
        .respond_with(Script(Mutex::new(replies), seen.clone()))
        .mount(&srv)
        .await;
    let base = srv.uri();
    let (provider, model) = LlmSettings::from_lookup(|k| match k {
        "OPENROUTER_API_KEY" => Some("k".into()),
        "MAILCRAFT_LLM_BASE_URL" => Some(base.clone()),
        _ => None,
    })
    .unwrap()
    .build()
    .unwrap();
    let pz = LlmPersonalizer::new(
        Arc::new(provider),
        model,
        Arc::new(NoopSpamChecker),
        Arc::new(NoBudget),
    );
    let r = pz
        .personalize(PersonalizeRequest {
            workspace_id: "ws".into(),
            step: "welcome".into(),
            instructions: "Welcome the contact.".into(),
            context: json!({"contact": {"first_name": "Ana"}}),
            guardrails: Guardrails::default(),
            template: EmailTemplate {
                cta_url: "https://example.com/".into(),
                signature: String::new(),
                footer: String::new(),
                unsubscribe_url: "https://example.com/u".into(),
            },
            fallback: Slots {
                subject: "Welcome".into(),
                preheader: String::new(),
                greeting: String::new(),
                body_paragraphs: vec![],
                cta_label: String::new(),
            },
            renderer: None,
            model: None,
            custom_instructions: None,
            slot_specs: if legacy { vec![] } else { llm_specs(specs) },
        })
        .await;
    let seen = seen.lock().unwrap().clone();
    (r, seen)
}

/// Same fill the engine does: generated text, else the slot fallback.
fn render(specs: &[SlotSpec], got: &Personalized) -> String {
    let filled: serde_json::Map<String, Value> = specs
        .iter()
        .map(|s| {
            let v = got
                .slots
                .get(&s.name)
                .cloned()
                .or_else(|| s.fallback.clone())
                .unwrap();
            (s.name.clone(), json!(v))
        })
        .collect();
    render_html(&template(specs), &json!({ "slots": filled })).unwrap()
}

#[tokio::test]
async fn intro_slot_is_llm_filled_and_rendered_not_the_fallback() {
    let specs = [spec("intro", Some(200), "STATIC INTRO")];
    let (r, seen) = run(
        &specs,
        vec![json!({"subject": "Welcome, Ana", "preheader": "Getting started", "intro": "Glad you joined us, Ana."})],
        false,
    )
    .await;
    assert_eq!(r.outcome, Outcome::Passed);
    let got = map_report(&specs, &r);
    assert!(!got.used_fallback);
    assert_eq!(got.subject.as_deref(), Some("Welcome, Ana"));
    let html = render(&specs, &got);
    assert!(html.contains("Glad you joined us, Ana."));
    assert!(!html.contains("STATIC INTRO"));
    // strict schema with exactly these keys, and the prompt names the slot
    let body = &seen[0];
    let schema = &body["response_format"]["json_schema"]["schema"];
    assert_eq!(schema["additionalProperties"], json!(false));
    assert_eq!(schema["required"], json!(["intro", "preheader", "subject"]));
    assert!(body.to_string().contains("Write the intro."));
}

#[tokio::test]
async fn multi_slot_template_fills_every_slot() {
    let specs = [spec("intro", None, "S1"), spec("tip", Some(120), "S2")];
    let (r, _) = run(
        &specs,
        vec![json!({"subject": "Hello", "preheader": "p", "intro": "Welcome aboard.", "tip": "Try the quickstart first."})],
        false,
    )
    .await;
    let got = map_report(&specs, &r);
    assert!(!got.used_fallback);
    let html = render(&specs, &got);
    assert!(html.contains("Welcome aboard.") && html.contains("Try the quickstart first."));
    assert!(!html.contains("S1") && !html.contains("S2"));
}

#[tokio::test]
async fn missing_declared_slot_repairs_then_falls_back() {
    let specs = [spec("intro", None, "S1"), spec("tip", None, "S2")];
    let bad = json!({"subject": "Hello", "preheader": "p", "intro": "Welcome aboard."});
    // repaired on the second attempt
    let good = json!({"subject": "Hello", "preheader": "p", "intro": "Welcome aboard.", "tip": "Try the quickstart."});
    let (r, seen) = run(&specs, vec![bad.clone(), good], false).await;
    assert_eq!(r.outcome, Outcome::Repaired);
    assert_eq!(r.attempts[0].violations[0].rule, "missing");
    assert_eq!(r.attempts[0].violations[0].slot, "tip");
    assert!(seen[1].to_string().contains("[missing] tip"));
    assert!(!map_report(&specs, &r).used_fallback);
    // never fixed: fallback, not "passed"
    let (r, _) = run(&specs, vec![bad], false).await;
    assert_eq!(r.outcome, Outcome::Fallback);
    let got = map_report(&specs, &r);
    assert!(got.used_fallback && got.slots.is_empty());
}

#[tokio::test]
async fn over_long_slot_is_a_violation() {
    let specs = [spec("intro", Some(10), "S1")];
    let out = json!({"subject": "Hello", "preheader": "p", "intro": "This is far longer than ten characters."});
    let (r, _) = run(&specs, vec![out], false).await;
    assert_eq!(r.outcome, Outcome::Fallback);
    let v = &r.attempts[0].violations;
    assert!(
        v.iter().any(|v| v.rule == "length" && v.slot == "intro"),
        "{v:?}"
    );
}

#[tokio::test]
async fn banned_term_in_a_custom_slot_is_caught() {
    let specs = [spec("intro", None, "S1")];
    let out = json!({"subject": "Hello", "preheader": "p", "intro": "We guarantee results."});
    let (r, _) = run(&specs, vec![out], false).await;
    assert_eq!(r.outcome, Outcome::Fallback);
    assert!(r.attempts[0]
        .violations
        .iter()
        .any(|v| v.rule == "banned_term" && v.slot == "intro"));
}

#[tokio::test]
async fn no_slot_specs_keeps_the_five_slot_contract() {
    let out = json!({
        "subject": "Welcome", "preheader": "p", "greeting": "Hi Ana,",
        "body_paragraphs": ["Glad you joined."], "cta_label": "Open dashboard"
    });
    let (r, seen) = run(&[], vec![out], true).await;
    assert_eq!(r.outcome, Outcome::Passed);
    assert_eq!(r.slots.greeting, "Hi Ana,");
    assert!(r.values.is_empty());
    let schema = &seen[0]["response_format"]["json_schema"]["schema"];
    assert!(schema["properties"]["body_paragraphs"].is_object());
    assert!(!seen[0].to_string().contains("SLOTS:"));
}
