//! `MAILCRAFT_TEST_PG=postgres://postgres:x@127.0.0.1:55432/postgres` (skipped when unset).
use mailcraft_automations::{llm_adapter::personalizer_from_lookup, PersonalizeRequest, SlotSpec};
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool};
use uuid::Uuid;
use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};

async fn pool() -> Option<(PgPool, Uuid)> {
    let url = std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55432/postgres".into());
    let admin = match PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect(&url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            assert!(
                std::env::var("MAILCRAFT_REQUIRE_DB").is_err(),
                "postgres required: {e}"
            );
            eprintln!("skipped: postgres unreachable ({e})");
            return None;
        }
    };
    let db = format!("mc_llm_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db}"))
        .execute(&admin)
        .await
        .unwrap();
    let url = format!("{}/{db}", url.rsplit_once('/').unwrap().0);
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("../../migrations").run(&pool).await.unwrap();
    let (ws,): (Uuid,) = sqlx::query_as("INSERT INTO workspaces (name) VALUES ('w') RETURNING id")
        .fetch_one(&pool)
        .await
        .unwrap();
    Some((pool, ws))
}

fn req(ws: Uuid) -> PersonalizeRequest {
    let slot = |n: &str, f: &str| SlotSpec {
        name: n.into(),
        max_len: None,
        instructions: None,
        fallback: Some(f.into()),
    };
    PersonalizeRequest {
        workspace_id: ws,
        automation_id: Uuid::new_v4(),
        run_id: Uuid::new_v4(),
        step_key: "welcome".into(),
        template_alias: "t".into(),
        subject_template: "Welcome".into(),
        slots: vec![
            slot("greeting", "Hi,"),
            slot("body", "Static body."),
            slot("cta_label", "Open"),
            slot("custom_extra", "Static extra."),
        ],
        context: json!({"contact": {"first_name": "Ana"}}),
        instructions: Some("Welcome the contact.".into()),
        custom_instructions: None,
    }
}

fn llm_body(content: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "id": "gen-1", "model": "m",
        "choices": [{"message": {"content": content.to_string()}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20}
    }))
}

fn env(base: &str) -> impl Fn(&str) -> Option<String> {
    let base = base.to_string();
    move |k| match k {
        "OPENROUTER_API_KEY" => Some("k".into()),
        "MAILCRAFT_LLM_BASE_URL" => Some(base.clone()),
        _ => None,
    }
}

async fn rows(pool: &PgPool) -> Vec<(i32, bool)> {
    sqlx::query_as("SELECT attempt, used_fallback FROM llm_generations ORDER BY attempt")
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn valid_output_fills_every_declared_slot_and_logs() {
    let Some((pool, ws)) = pool().await else {
        return;
    };
    let srv = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(llm_body(json!({
            "subject": "Welcome aboard, Ana", "preheader": "Getting started", "greeting": "Hi Ana,",
            "body": "Glad you joined.\n\nReply if you need help.", "cta_label": "Open dashboard",
            "custom_extra": "Here is a tip."
        })))
        .mount(&srv)
        .await;
    let p = personalizer_from_lookup(pool.clone(), env(&srv.uri()));
    let out = p.personalize(req(ws)).await.unwrap();
    assert!(!out.used_fallback);
    assert_eq!(out.subject.as_deref(), Some("Welcome aboard, Ana"));
    assert_eq!(out.slots["greeting"], "Hi Ana,");
    assert_eq!(
        out.slots["body"],
        "Glad you joined.\n\nReply if you need help."
    );
    assert_eq!(out.slots["custom_extra"], "Here is a tip.");
    let id = out.generation_id.unwrap();
    assert_eq!(rows(&pool).await, vec![(1, false)]);
    let (ok,): (bool,) =
        sqlx::query_as("SELECT (validator->>'passed')::bool FROM llm_generations WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(ok);
}

#[tokio::test]
async fn invalid_twice_falls_back() {
    let Some((pool, ws)) = pool().await else {
        return;
    };
    let srv = MockServer::start().await;
    // exclamation marks and a URL are forbidden by the validator
    Mock::given(method("POST"))
        .respond_with(llm_body(json!({
            "subject": "Hi!", "preheader": "x", "greeting": "Hi!",
            "body_paragraphs": ["Visit http://evil.test now!"], "cta_label": "Go!"
        })))
        .mount(&srv)
        .await;
    let p = personalizer_from_lookup(pool.clone(), env(&srv.uri()));
    let out = p.personalize(req(ws)).await.unwrap();
    assert!(out.used_fallback);
    assert!(
        out.subject.is_none() && out.slots.is_empty(),
        "engine applies per-slot fallbacks"
    );
    assert!(out.generation_id.is_some());
    assert_eq!(rows(&pool).await, vec![(1, false), (2, true)]);
}

#[tokio::test]
async fn no_key_is_noop() {
    let Some((pool, ws)) = pool().await else {
        return;
    };
    let p = personalizer_from_lookup(pool.clone(), |_| None);
    let out = p.personalize(req(ws)).await.unwrap();
    assert!(out.used_fallback && out.generation_id.is_none());
    assert_eq!(out.slots["body"], "Static body.");
    assert!(rows(&pool).await.is_empty());
}
