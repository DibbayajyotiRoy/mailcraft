use mailcraft_core::llm::Msg;
use mailcraft_llm::*;
use serde_json::{json, Value};
use std::time::Duration;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn req() -> GenerateRequest {
    GenerateRequest {
        model: "nvidia/nemotron-3.5-super-vl:free".into(),
        fallbacks: vec![],
        messages: vec![
            Msg {
                role: "system".into(),
                content: "sys".into(),
            },
            Msg {
                role: "user".into(),
                content: "hi".into(),
            },
        ],
        json_schema: Some(Slots::json_schema()),
        temperature: Some(0.4),
        max_tokens: 300,
    }
}
fn ok_body() -> Value {
    json!({"id":"gen-1","model":"nvidia/nemotron-3.5-super-vl:free","choices":[{"message":{"content":"{\"a\":1}"}}],
        "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.0001}})
}
fn fast(c: OpenAiCompatConfig, url: &str) -> OpenAiCompat {
    let mut c = c.with_base_url(url);
    c.backoff_base = Duration::from_millis(5);
    OpenAiCompat::new(c).unwrap()
}

#[tokio::test]
async fn openrouter_request_shape_and_usage() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .and(header("Authorization", "Bearer k"))
        .and(header("HTTP-Referer", "https://mailcraft.dev"))
        .and(header("X-Title", "mailcraft"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
        .expect(1)
        .mount(&s)
        .await;
    let p = fast(
        OpenAiCompatConfig::openrouter("k", "https://mailcraft.dev", "mailcraft"),
        &s.uri(),
    );
    let out = p.generate(req()).await.unwrap();
    assert_eq!(p.id(), "openrouter");
    assert_eq!(out.usage.prompt_tokens + out.usage.completion_tokens, 15);
    assert_eq!(out.cost_usd, Some(0.0001));
    assert_eq!(out.request_id.as_deref(), Some("gen-1"));
    assert_eq!(out.json, json!({"a":1}));

    let b = s.received_requests().await.unwrap()[0]
        .body_json::<Value>()
        .unwrap();
    assert_eq!(b["provider"], json!({"require_parameters": true}));
    assert_eq!(b["response_format"]["type"], "json_schema");
    assert_eq!(b["response_format"]["json_schema"]["strict"], true);
    assert_eq!(b["response_format"]["json_schema"]["name"], "email_slots");
    assert_eq!(b["messages"][0]["role"], "system");
    assert_eq!(b["max_tokens"], 300);
}

#[tokio::test]
async fn presets() {
    let o = OpenAiCompatConfig::openrouter("k", "r", "t");
    assert_eq!(o.base_url, "https://openrouter.ai/api/v1");
    assert_eq!(
        OpenAiCompatConfig::openai("k").base_url,
        "https://api.openai.com/v1"
    );
    let ol = OpenAiCompatConfig::ollama();
    assert_eq!(ol.base_url, "http://localhost:11434/v1");
    assert!(ol.api_key.is_none());
}

#[tokio::test]
async fn openai_and_ollama_send_no_openrouter_fields_and_ollama_no_auth() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
        .mount(&s)
        .await;
    fast(OpenAiCompatConfig::openai("sk"), &s.uri())
        .generate(req())
        .await
        .unwrap();
    fast(OpenAiCompatConfig::ollama(), &s.uri())
        .generate(req())
        .await
        .unwrap();
    let r = s.received_requests().await.unwrap();
    assert!(r[0].body_json::<Value>().unwrap().get("provider").is_none());
    assert_eq!(
        r[0].headers.get("authorization").unwrap().to_str().unwrap(),
        "Bearer sk"
    );
    assert!(r[1].headers.get("authorization").is_none());
    assert_eq!(
        r[1].body_json::<Value>().unwrap()["response_format"]["type"],
        "json_schema"
    );
}

#[tokio::test]
async fn retries_429_then_succeeds() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(429))
        .up_to_n_times(2)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
        .mount(&s)
        .await;
    let p = fast(OpenAiCompatConfig::openai("k"), &s.uri());
    assert!(p.generate(req()).await.is_ok());
    assert_eq!(s.received_requests().await.unwrap().len(), 3);
}

#[tokio::test]
async fn gives_up_after_max_retries_on_5xx() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503).set_body_string("down"))
        .mount(&s)
        .await;
    let mut c = OpenAiCompatConfig::openai("k");
    c.max_retries = 2;
    let err = fast(c, &s.uri()).generate(req()).await.unwrap_err();
    assert!(matches!(err, LlmError::Transient(_)));
    assert_eq!(s.received_requests().await.unwrap().len(), 3);
}

#[tokio::test]
async fn no_retry_on_400() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400).set_body_string("bad schema"))
        .mount(&s)
        .await;
    let err = fast(OpenAiCompatConfig::openai("k"), &s.uri())
        .generate(req())
        .await
        .unwrap_err();
    assert!(matches!(err, LlmError::InvalidSchema(_)));
    assert_eq!(s.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn timeout_is_retried_then_errors() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(ok_body())
                .set_delay(Duration::from_millis(300)),
        )
        .mount(&s)
        .await;
    let mut c = OpenAiCompatConfig::openai("k");
    c.timeout = Duration::from_millis(50);
    c.max_retries = 1;
    let err = fast(c, &s.uri()).generate(req()).await.unwrap_err();
    assert!(matches!(err, LlmError::Transient(_)));
    assert_eq!(s.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn empty_content_is_error() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"choices":[{"message":{"content":null}}]})),
        )
        .mount(&s)
        .await;
    let err = fast(OpenAiCompatConfig::openai("k"), &s.uri())
        .generate(req())
        .await
        .unwrap_err();
    assert!(matches!(err, LlmError::Transient(_)));
}

#[tokio::test]
async fn non_json_text_is_returned_as_string_and_status_mapping() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"choices":[{"message":{"content":"Sure! here"}}]})),
        )
        .up_to_n_times(1)
        .mount(&s)
        .await;
    let out = fast(OpenAiCompatConfig::openai("k"), &s.uri())
        .generate(req())
        .await
        .unwrap();
    assert_eq!(out.json, json!("Sure! here"));

    for (status, ok) in [(401u16, "fatal"), (402, "quota"), (429, "rate")] {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(status))
            .mount(&s)
            .await;
        let mut c = OpenAiCompatConfig::openai("k");
        c.max_retries = 0;
        let e = fast(c, &s.uri()).generate(req()).await.unwrap_err();
        let got = match e {
            LlmError::Fatal(_) => "fatal",
            LlmError::QuotaExceeded => "quota",
            LlmError::RateLimited(_) => "rate",
            _ => "other",
        };
        assert_eq!(got, ok);
    }
}

#[tokio::test]
async fn openrouter_sends_model_fallbacks() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
        .mount(&s)
        .await;
    let mut r = req();
    r.fallbacks = vec!["google/gemma-4-31b-it:free".into()];
    fast(OpenAiCompatConfig::openrouter("k", "r", "t"), &s.uri())
        .generate(r)
        .await
        .unwrap();
    let b = s.received_requests().await.unwrap()[0]
        .body_json::<Value>()
        .unwrap();
    assert_eq!(b["models"], json!(["google/gemma-4-31b-it:free"]));
}

#[tokio::test]
async fn reasoning_is_sent_only_when_configured() {
    for (r, want) in [
        (None, None),
        (
            Some(json!({"enabled": false})),
            Some(json!({"enabled": false})),
        ),
        (
            Some(json!({"effort": "low"})),
            Some(json!({"effort": "low"})),
        ),
    ] {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
            .mount(&s)
            .await;
        let mut c = OpenAiCompatConfig::openrouter("k", "r", "t");
        c.reasoning = r;
        fast(c, &s.uri()).generate(req()).await.unwrap();
        let b = s.received_requests().await.unwrap()[0]
            .body_json::<Value>()
            .unwrap();
        assert_eq!(b.get("reasoning").cloned(), want);
    }
}

#[tokio::test]
async fn empty_completion_retries_on_next_fallback_model() {
    use wiremock::matchers::body_partial_json;
    let s = MockServer::start().await;
    let empty = json!({"id":"g0","model":"a/x:free","choices":[{"message":{"content":""}}],
        "usage":{"prompt_tokens":0,"completion_tokens":0}});
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"model": "a/x:free"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(empty))
        .expect(1)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"model": "b/y:free"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
        .expect(1)
        .mount(&s)
        .await;
    let mut c = OpenAiCompatConfig::openrouter("k", "r", "t");
    c.fallback_models = vec!["b/y:free".into()];
    let mut r = req();
    r.model = "a/x:free".into();
    let out = fast(c, &s.uri()).generate(r).await.unwrap();
    assert_eq!(out.json, json!({"a":1}));
    let first = s.received_requests().await.unwrap()[0]
        .body_json::<Value>()
        .unwrap();
    assert_eq!(
        first["models"],
        json!(["b/y:free"]),
        "configured fallbacks are sent"
    );
}

#[tokio::test]
async fn openrouter_refuses_a_paid_model_without_calling_out() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
        .expect(0)
        .mount(&s)
        .await;
    let mut r = req();
    r.model = "deepseek/deepseek-v4-flash".into();
    let err = fast(OpenAiCompatConfig::openrouter("k", "r", "t"), &s.uri())
        .generate(r)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, LlmError::Fatal(m) if m.contains("not a :free")),
        "{err:?}"
    );
    assert!(s.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn openrouter_drops_paid_fallbacks_from_request_and_config() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
        .mount(&s)
        .await;
    // Per-request list and the configured list are both filtered.
    let mut c = OpenAiCompatConfig::openrouter("k", "r", "t");
    c.fallback_models = vec!["openai/gpt-5-nano".into(), "a/x:free".into()];
    let p = fast(c, &s.uri());
    p.generate(req()).await.unwrap();
    let mut r = req();
    r.fallbacks = vec!["openai/gpt-5-nano".into(), "b/y:free".into()];
    p.generate(r).await.unwrap();
    let got = s.received_requests().await.unwrap();
    assert_eq!(
        got[0].body_json::<Value>().unwrap()["models"],
        json!(["a/x:free"])
    );
    assert_eq!(
        got[1].body_json::<Value>().unwrap()["models"],
        json!(["b/y:free"])
    );
}

#[tokio::test]
async fn free_suffix_gate_is_openrouter_only() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body()))
        .mount(&s)
        .await;
    let mut r = req();
    r.model = "gpt-5-nano".into();
    fast(OpenAiCompatConfig::openai("k"), &s.uri())
        .generate(r)
        .await
        .unwrap();
}
