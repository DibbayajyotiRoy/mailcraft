//! End-to-end: run the real binary against a tiny in-process mock API.
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Output},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Clone, Debug)]
struct Req {
    path: String,
    headers: String,
    body: Value,
}

struct Mock {
    url: String,
    seen: Arc<Mutex<Vec<Req>>>,
}

/// routes: (method, path, status, body). First match wins; unmatched -> 404 not_found.
fn mock(routes: Vec<(&'static str, &'static str, u16, Value)>) -> Mock {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let s2 = seen.clone();
    thread::spawn(move || {
        for conn in l.incoming() {
            let Ok(mut c) = conn else { continue };
            let mut buf = vec![];
            let mut chunk = [0u8; 4096];
            let (head_end, len) = loop {
                let n = c.read(&mut chunk).unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let txt = String::from_utf8_lossy(&buf).to_string();
                if let Some(i) = txt.find("\r\n\r\n") {
                    let len = txt[..i]
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if buf.len() >= i + 4 + len {
                        break (i, len);
                    }
                }
                if n == 0 {
                    break (0, 0);
                }
            };
            let txt = String::from_utf8_lossy(&buf).to_string();
            let mut first = txt.lines().next().unwrap_or("").split_whitespace();
            let (method, path) = (
                first.next().unwrap_or("").to_string(),
                first.next().unwrap_or("").to_string(),
            );
            let body = serde_json::from_slice(
                &buf[(head_end + 4).min(buf.len())..(head_end + 4 + len).min(buf.len())],
            )
            .unwrap_or(Value::Null);
            s2.lock().unwrap().push(Req {
                path: path.clone(),
                headers: txt[..head_end].to_lowercase(),
                body,
            });
            let (st, b) = routes
                .iter()
                .find(|(m, p, _, _)| *m == method && path.split('?').next() == Some(*p))
                .map(|(_, _, s, b)| (*s, b.to_string()))
                .unwrap_or((
                    404,
                    json!({"ok": false, "error": {"code": "not_found", "message": "nope"}})
                        .to_string(),
                ));
            let _ = write!(c, "HTTP/1.1 {st} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
        }
    });
    Mock { url, seen }
}

fn conf_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("mc-cli-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn run(m: &Mock, dir: &std::path::Path, key: Option<&str>, args: &[&str]) -> Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_mailcraft"));
    c.env("MAILCRAFT_CONFIG_DIR", dir)
        .env("MAILCRAFT_API_URL", &m.url)
        .env_remove("MAILCRAFT_API_KEY")
        .args(args)
        .arg("--json");
    if let Some(k) = key {
        c.env("MAILCRAFT_API_KEY", k);
    }
    c.output().unwrap()
}

fn out(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|_| panic!("stdout not JSON: {}", String::from_utf8_lossy(&o.stdout)))
}

fn env_ok(data: Value) -> Value {
    json!({"ok": true, "request_id": "req_1", "data": data})
}

#[test]
fn send_sends_auth_and_idempotency_key() {
    let m = mock(vec![(
        "POST",
        "/v1/emails",
        202,
        env_ok(json!({"id": "0192f3a0-7b1c-7a10-8000-000000000001", "status": "queued"})),
    )]);
    let o = run(
        &m,
        &conf_dir("send"),
        Some("mc_test_abc"),
        &[
            "send",
            "--to",
            "a@x.org,b@x.org",
            "--subject",
            "Hi",
            "--text",
            "yo",
            "--idempotency-key",
            "k1",
            "--dry-run",
        ],
    );
    assert_eq!(o.status.code(), Some(0));
    let v = out(&o);
    assert_eq!(v["schema"], 1);
    assert_eq!(v["data"]["id"], "0192f3a0-7b1c-7a10-8000-000000000001");
    let r = m.seen.lock().unwrap()[0].clone();
    assert!(r.headers.contains("authorization: bearer mc_test_abc"));
    assert!(r.headers.contains("idempotency-key: k1"));
    assert_eq!(r.body["to"], json!(["a@x.org", "b@x.org"]));
    assert_eq!(r.body["dry_run"], true);
}

#[test]
fn send_with_template_and_data() {
    let m = mock(vec![(
        "POST",
        "/v1/emails",
        202,
        env_ok(json!({"id": "0192f3a0-7b1c-7a10-8000-000000000001", "status": "queued"})),
    )]);
    let o = run(
        &m,
        &conf_dir("tpl"),
        Some("k"),
        &[
            "send",
            "--to",
            "a@x.org",
            "--template",
            "welcome",
            "--data",
            r#"{"name":"Ana"}"#,
        ],
    );
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(
        m.seen.lock().unwrap()[0].body["template"],
        json!({"id": "welcome", "variables": {"name": "Ana"}})
    );
}

#[test]
fn pending_approval_exits_4() {
    let m = mock(vec![(
        "POST",
        "/v1/emails",
        202,
        env_ok(json!({"id": "0192f3a0-7b1c-7a10-8000-000000000001", "status": "pending_approval"})),
    )]);
    let o = run(
        &m,
        &conf_dir("pa"),
        Some("k"),
        &["send", "--to", "a@x.org", "--subject", "s", "--text", "t"],
    );
    assert_eq!(o.status.code(), Some(4));
    assert_eq!(out(&o)["data"]["status"], "pending_approval");
}

#[test]
fn error_exit_codes() {
    let err = |c: &str| json!({"ok": false, "error": {"code": c, "message": "m", "hint": "h", "retryable": c == "rate_limited"}});
    for (status, code, want) in [
        (403, "forbidden_scope", 3),
        (401, "unauthenticated", 3),
        (404, "not_found", 6),
        (429, "rate_limited", 5),
        (501, "not_implemented", 1),
        (409, "idempotency_key_reused", 1),
    ] {
        let m = mock(vec![(
            "GET",
            "/v1/emails/0192f3a0-7b1c-7a10-8000-000000000001",
            status,
            err(code),
        )]);
        let o = run(
            &m,
            &conf_dir("err"),
            Some("k"),
            &["emails", "get", "0192f3a0-7b1c-7a10-8000-000000000001"],
        );
        assert_eq!(o.status.code(), Some(want), "{code}");
        let v = out(&o);
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], code);
        assert_eq!(v["error"]["hint"], "h");
    }
}

#[test]
fn usage_and_missing_key() {
    let m = mock(vec![]);
    let o = run(
        &m,
        &conf_dir("use"),
        Some("k"),
        &["send", "--to", "a@x.org"],
    );
    assert_eq!(o.status.code(), Some(2));
    let o = run(&m, &conf_dir("nokey"), None, &["emails", "list"]);
    assert_eq!(o.status.code(), Some(3));
    assert_eq!(out(&o)["error"]["code"], "unauthenticated");
}

#[test]
fn unreachable_is_retryable() {
    let m = Mock {
        url: "http://127.0.0.1:1".into(),
        seen: Default::default(),
    };
    let o = run(&m, &conf_dir("down"), Some("k"), &["emails", "list"]);
    assert_eq!(o.status.code(), Some(5));
}

#[test]
fn domain_verify_resolves_id_and_exits_7_until_verified() {
    let m = mock(vec![
        (
            "GET",
            "/v1/domains",
            200,
            env_ok(json!([{"id": "0192f3a0-7b1c-7a10-8000-0000000000d1", "name": "example.com"}])),
        ),
        (
            "POST",
            "/v1/domains/0192f3a0-7b1c-7a10-8000-0000000000d1/verify",
            200,
            env_ok(json!({"status": "pending", "records": []})),
        ),
    ]);
    let o = run(
        &m,
        &conf_dir("dv"),
        Some("k"),
        &["domain", "verify", "example.com"],
    );
    assert_eq!(o.status.code(), Some(7));
    let o = run(
        &m,
        &conf_dir("dv"),
        Some("k"),
        &["domain", "verify", "nope.com"],
    );
    assert_eq!(o.status.code(), Some(6));
}

#[test]
fn domain_add_and_kill_switch_and_approvals() {
    let m = mock(vec![
        (
            "POST",
            "/v1/domains",
            201,
            env_ok(
                json!({"id": "0192f3a0-7b1c-7a10-8000-0000000000d1", "status": "not_started", "records": []}),
            ),
        ),
        ("POST", "/v1/kill-switch", 200, env_ok(json!({"on": true}))),
        (
            "POST",
            "/v1/approvals/0192f3a0-7b1c-7a10-8000-0000000000a1/decide",
            403,
            json!({"ok": false, "error": {"code": "forbidden_scope", "message": "agent keys cannot decide"}}),
        ),
    ]);
    let d = conf_dir("misc");
    assert_eq!(
        run(&m, &d, Some("k"), &["domain", "add", "example.com"])
            .status
            .code(),
        Some(0)
    );
    assert_eq!(
        run(&m, &d, Some("k"), &["kill-switch", "on"]).status.code(),
        Some(0)
    );
    assert_eq!(
        run(
            &m,
            &d,
            Some("k"),
            &[
                "approvals",
                "approve",
                "0192f3a0-7b1c-7a10-8000-0000000000a1"
            ]
        )
        .status
        .code(),
        Some(3)
    );
    let seen = m.seen.lock().unwrap();
    assert_eq!(seen[0].body["domain"], "example.com");
    assert_eq!(seen[1].body, json!({"on": true}));
    assert_eq!(seen[2].body["decision"], "approve");
}

#[test]
fn init_saves_both_keys_as_profiles_0600_and_shows_admin_once() {
    let m = mock(vec![
        ("GET", "/healthz", 200, json!({"ok": true})),
        (
            "POST",
            "/v1/setup",
            201,
            env_ok(
                json!({"admin_key": "mc_live_ADMINSECRET", "test_key": "mc_test_TESTSECRET0123456789"}),
            ),
        ),
        (
            "GET",
            "/v1/account/status",
            200,
            env_ok(
                json!({"workspace": "w", "kill_switch": false, "live_enabled": false, "pending_approvals": 0, "key": {"env": "test"}, "delivery_path": {"kind": "sandbox"}}),
            ),
        ),
        (
            "POST",
            "/v1/emails",
            202,
            env_ok(json!({"id": "0192f3a0-7b1c-7a10-8000-000000000001", "status": "queued"})),
        ),
    ]);
    let d = conf_dir("init");
    let o = run(
        &m,
        &d,
        None,
        &["init", "--non-interactive", "--delivery", "sandbox"],
    );
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stdout)
    );
    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
    // the test key is never echoed; the admin key is shown once (stdout json + stderr banner)
    assert!(!stdout.contains("TESTSECRET0123456789"));
    assert_eq!(out(&o)["data"]["admin_key"], "mc_live_ADMINSECRET");
    assert!(String::from_utf8_lossy(&o.stderr).contains("won't be shown again"));
    let cfg: Value =
        serde_json::from_str(&std::fs::read_to_string(d.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg["profiles"]["default"], "mc_test_TESTSECRET0123456789");
    assert_eq!(cfg["profiles"]["admin"], "mc_live_ADMINSECRET");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(d.join("config.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let seen = m.seen.lock().unwrap();
    let send = seen.iter().find(|r| r.path == "/v1/emails").unwrap();
    assert_eq!(send.body["to"], json!(["delivered@test.mailcraft.local"]));
    assert!(out(&o)["data"]["next_steps"].as_array().unwrap().len() >= 2);
}

#[test]
fn connect_gmail_loopback() {
    let m = mock(vec![
        (
            "POST",
            "/v1/transports/gmail/oauth/start",
            200,
            env_ok(json!({"auth_url": "https://accounts.google.com/x", "state": "s1"})),
        ),
        (
            "POST",
            "/v1/transports/gmail/oauth/complete",
            200,
            env_ok(json!({"id": "tr_1", "kind": "gmail-oauth"})),
        ),
    ]);
    let seen = m.seen.clone();
    // Play the browser: wait for the start call, then hit the loopback redirect it announced.
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(100));
        let uri = seen
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.path.ends_with("/oauth/start"))
            .map(|r| r.body["redirect_uri"].as_str().unwrap().to_string());
        if let Some(u) = uri {
            thread::sleep(Duration::from_millis(300));
            let addr = u
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap()
                .to_string();
            let mut s = TcpStream::connect(addr).unwrap();
            let _ = write!(
                s,
                "GET /callback?code=4%2Fcode&state=s1 HTTP/1.1\r\nHost: x\r\n\r\n"
            );
            let mut r = String::new();
            let _ = s.read_to_string(&mut r);
            return;
        }
    });
    let o = run(
        &m,
        &conf_dir("gm"),
        Some("k"),
        &["connect", "gmail", "--timeout", "20"],
    );
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stdout)
    );
    let seen = m.seen.lock().unwrap();
    let c = seen.iter().find(|r| r.path.ends_with("/complete")).unwrap();
    assert_eq!(c.body["code"], "4/code");
    assert_eq!(c.body["state"], "s1");
}

#[test]
fn doctor_reports_check_failure_exit_7() {
    // API down => api_reachable fails => exit 7 regardless of local network.
    let m = Mock {
        url: "http://127.0.0.1:1".into(),
        seen: Default::default(),
    };
    let o = run(&m, &conf_dir("doc"), Some("k"), &["doctor"]);
    assert_eq!(o.status.code(), Some(7));
    let v = out(&o);
    let ids: Vec<&str> = v["data"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"port25_outbound") && ids.contains(&"api_reachable"));
}

// ---- contract: serve the API's real response shapes (docs/contract/fixtures.json) ----

fn fx(key: &str) -> (u16, Value) {
    let all: Value =
        serde_json::from_str(include_str!("../../../docs/contract/fixtures.json")).unwrap();
    let f = &all[key];
    assert!(f.is_object(), "no fixture {key}");
    (f["status"].as_u64().unwrap() as u16, f["body"].clone())
}

const ID: &str = "0192f3a0-7b1c-7a10-8000-000000000001";

#[test]
#[allow(clippy::type_complexity)]
fn contract_real_envelopes() {
    // (cli args, method, path, fixture key, expected exit, data pointer, expected value)
    let cases: Vec<(Vec<&str>, &str, String, &str, u8, &str, Value)> = vec![
        (
            vec![
                "send",
                "--to",
                "delivered@test.mailcraft.local",
                "--subject",
                "s",
                "--text",
                "t",
            ],
            "POST",
            "/v1/emails".into(),
            "POST /v1/emails",
            0,
            "/recipients/0/id",
            json!(ID),
        ),
        (
            vec![
                "send",
                "--to",
                "a@example.com",
                "--subject",
                "s",
                "--text",
                "t",
            ],
            "POST",
            "/v1/emails".into(),
            "POST /v1/emails#pending",
            4,
            "/approval_id",
            json!("0192f3a0-7b1c-7a10-8000-0000000000a1"),
        ),
        (
            vec![
                "send",
                "--to",
                "a@example.com",
                "--subject",
                "s",
                "--text",
                "t",
                "--dry-run",
            ],
            "POST",
            "/v1/emails".into(),
            "POST /v1/emails#dry_run",
            0,
            "/would_send_via",
            json!("sandbox"),
        ),
        (
            vec!["emails", "list", "--status", "queued"],
            "GET",
            "/v1/emails".into(),
            "GET /v1/emails",
            0,
            "/0/to_addr",
            json!("delivered@test.mailcraft.local"),
        ),
        (
            vec!["emails", "get", ID],
            "GET",
            format!("/v1/emails/{ID}"),
            "GET /v1/emails/{id}",
            0,
            "/status",
            json!("queued"),
        ),
        (
            vec!["emails", "events", ID],
            "GET",
            format!("/v1/emails/{ID}/events"),
            "GET /v1/emails/{id}/events",
            0,
            "/0/type",
            json!("delivered"),
        ),
        (
            vec!["emails", "cancel", ID],
            "POST",
            format!("/v1/emails/{ID}/cancel"),
            "POST /v1/emails/{id}/cancel",
            0,
            "/status",
            json!("cancelled"),
        ),
        (
            vec!["keys", "create", "--name", "agent"],
            "POST",
            "/v1/keys".into(),
            "POST /v1/keys",
            0,
            "/prefix",
            json!("mc_test_AbCd"),
        ),
        (
            vec!["keys", "list"],
            "GET",
            "/v1/keys".into(),
            "GET /v1/keys",
            0,
            "/0/paused",
            json!(false),
        ),
        (
            vec!["keys", "revoke", ID],
            "DELETE",
            format!("/v1/keys/{ID}"),
            "DELETE /v1/keys/{id}",
            0,
            "/revoked",
            json!(true),
        ),
        (
            vec!["approvals", "list"],
            "GET",
            "/v1/approvals".into(),
            "GET /v1/approvals",
            0,
            "/0/payload/preview/subject",
            json!("hi"),
        ),
        (
            vec!["approvals", "approve", ID],
            "POST",
            format!("/v1/approvals/{ID}/decide"),
            "POST /v1/approvals/{id}/decide",
            0,
            "/status",
            json!("approved"),
        ),
        (
            vec!["kill-switch", "on"],
            "POST",
            "/v1/kill-switch".into(),
            "POST /v1/kill-switch",
            0,
            "/on",
            json!(true),
        ),
        (
            vec!["pause"],
            "POST",
            "/v1/kill-switch".into(),
            "POST /v1/kill-switch",
            0,
            "/on",
            json!(true),
        ),
    ];
    for (args, method, path, key, want_exit, ptr, want) in cases {
        let (st, body) = fx(key);
        let m = mock(vec![(
            method,
            Box::leak(path.clone().into_boxed_str()),
            st,
            body,
        )]);
        let o = run(&m, &conf_dir("contract"), Some("mc_test_k"), &args);
        assert_eq!(o.status.code(), Some(want_exit as i32), "{args:?}");
        let v = out(&o);
        assert_eq!(v["request_id"], "req_0192f3a07b1c", "{args:?}");
        assert_eq!(v["data"].pointer(ptr), Some(&want), "{args:?} {ptr}");
    }
}

#[test]
fn contract_resume_sends_off_and_admin_refusal_is_exit_3() {
    let (st, body) = fx("POST /v1/kill-switch");
    let m = mock(vec![("POST", "/v1/kill-switch", st, body)]);
    run(&m, &conf_dir("resume"), Some("k"), &["resume"]);
    run(
        &m,
        &conf_dir("resume"),
        Some("k"),
        &["kill-switch", "resume"],
    );
    let seen = m.seen.lock().unwrap();
    assert!(seen.iter().all(|r| r.body == json!({"on": false})));
    drop(seen);
    let (st, body) = fx("ERROR forbidden_scope");
    let m = mock(vec![(
        "POST",
        Box::leak(format!("/v1/approvals/{ID}/decide").into_boxed_str()),
        st,
        body,
    )]);
    let o = run(
        &m,
        &conf_dir("deny"),
        Some("k"),
        &["approvals", "approve", ID],
    );
    assert_eq!(o.status.code(), Some(3));
    assert_eq!(out(&o)["error"]["code"], "forbidden_scope");
}

#[test]
fn contract_doctor_reads_key_env_from_account_status() {
    let (st, body) = fx("GET /v1/account/status");
    let m = mock(vec![
        ("GET", "/healthz", 200, json!({"ok": true})),
        ("GET", "/v1/account/status", st, body),
    ]);
    let o = run(&m, &conf_dir("docenv"), Some("k"), &["doctor"]);
    let v = out(&o);
    let c = v["data"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "api_key")
        .unwrap()
        .clone();
    assert_eq!(c["status"], "pass");
    assert_eq!(c["detail"], "env test");
}

#[test]
fn settings_instructions_set_get_clear() {
    let m = mock(vec![
        (
            "PUT",
            "/v1/settings",
            200,
            env_ok(json!({"custom_instructions": "Be warm."})),
        ),
        (
            "GET",
            "/v1/settings",
            200,
            env_ok(json!({"custom_instructions": "Be warm.", "reply_to": null})),
        ),
    ]);
    let d = conf_dir("instr");
    let o = run(
        &m,
        &d,
        Some("mc_test_abc"),
        &["settings", "instructions", "set", "Be warm."],
    );
    assert!(o.status.success());
    assert_eq!(
        m.seen.lock().unwrap().last().unwrap().body,
        json!({"custom_instructions": "Be warm."})
    );
    let f = d.with_extension("txt");
    std::fs::write(&f, "From file").unwrap();
    run(
        &m,
        &d,
        Some("mc_test_abc"),
        &[
            "settings",
            "instructions",
            "set",
            "--file",
            f.to_str().unwrap(),
        ],
    );
    assert_eq!(
        m.seen.lock().unwrap().last().unwrap().body,
        json!({"custom_instructions": "From file"})
    );
    let o = run(
        &m,
        &d,
        Some("mc_test_abc"),
        &["settings", "instructions", "get"],
    );
    assert_eq!(out(&o)["data"], json!({"custom_instructions": "Be warm."}));
    run(
        &m,
        &d,
        Some("mc_test_abc"),
        &["settings", "instructions", "clear"],
    );
    assert_eq!(
        m.seen.lock().unwrap().last().unwrap().body,
        json!({"custom_instructions": ""})
    );
}

#[test]
fn settings_instructions_surfaces_api_error() {
    let m = mock(vec![(
        "PUT",
        "/v1/settings",
        422,
        json!({"ok": false, "error": {"code": "custom_instructions_too_long", "message": "too long", "hint": "shorten it"}}),
    )]);
    let o = run(
        &m,
        &conf_dir("instr2"),
        Some("mc_test_abc"),
        &["settings", "instructions", "set", "x"],
    );
    assert!(!o.status.success());
    assert!(String::from_utf8_lossy(&o.stdout).contains("custom_instructions_too_long"));
}

#[test]
fn profile_flag_selects_admin_key() {
    let m = mock(vec![("GET", "/v1/approvals", 200, env_ok(json!([])))]);
    let d = conf_dir("profile");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(
        d.join("config.json"),
        json!({"base_url": m.url, "profiles": {"default": "mc_test_T", "admin": "mc_live_A"}})
            .to_string(),
    )
    .unwrap();
    let o = run(&m, &d, None, &["approvals", "list", "--profile", "admin"]);
    assert_eq!(o.status.code(), Some(0));
    run(&m, &d, None, &["approvals", "list"]);
    let seen = m.seen.lock().unwrap();
    assert!(seen[0].headers.contains("bearer mc_live_a"));
    assert!(seen[1].headers.contains("bearer mc_test_t"));
}

#[test]
fn publish_commands_and_contact_timezone() {
    let m = mock(vec![
        (
            "POST",
            "/v1/templates/welcome/publish",
            200,
            env_ok(json!({"published_version": 2})),
        ),
        (
            "POST",
            "/v1/automations/onboard/publish",
            200,
            env_ok(json!({"status": "active"})),
        ),
        (
            "PUT",
            "/v1/contacts",
            200,
            env_ok(json!({"email": "a@b.co"})),
        ),
        (
            "POST",
            "/v1/automations/drafty/resume",
            409,
            json!({"ok": false, "error": {"code": "invalid_state", "message": "automation is `draft`; automation.resume needs paused"}}),
        ),
    ]);
    let d = conf_dir("publish");
    let k = Some("mc_test_K");
    let o = run(
        &m,
        &d,
        k,
        &["templates", "publish", "welcome", "--version", "2"],
    );
    assert_eq!(o.status.code(), Some(0));
    let o = run(
        &m,
        &d,
        k,
        &["automations", "publish", "onboard", "--backfill-suppress"],
    );
    assert_eq!(o.status.code(), Some(0));
    let o = run(
        &m,
        &d,
        k,
        &[
            "contacts",
            "upsert",
            "a@b.co",
            "--timezone",
            "Europe/Berlin",
        ],
    );
    assert_eq!(o.status.code(), Some(0));
    let o = run(&m, &d, k, &["automations", "enable", "drafty"]);
    assert!(out(&o)["error"]["hint"]
        .as_str()
        .unwrap()
        .contains("automations publish drafty"));
    let seen = m.seen.lock().unwrap();
    assert_eq!(seen[0].body, json!({"version": 2}));
    assert_eq!(seen[1].body, json!({"backfill_suppress": true}));
    assert_eq!(seen[2].body["timezone"], "Europe/Berlin");
}
