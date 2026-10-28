//! Multiple From addresses and per-address routing: which transport a send uses, the domain gate for
//! mailbox relays (login + aliases), display names, `GET /v1/senders`, domain <-> transport binding.
//! Real Postgres (MAILCRAFT_TEST_PG, default :55550); skips when unreachable unless MAILCRAFT_REQUIRE_DB=1.
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use mailcraft_api::{wiring, AppState, Config};
use mailcraft_automations::SendRouter;
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
use tower::ServiceExt;
use uuid::Uuid;

fn pg_url() -> String {
    std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55550/postgres".into())
}

async fn fresh_db() -> Option<PgPool> {
    let admin = match PgPool::connect(&pg_url()).await {
        Ok(p) => p,
        Err(e) => {
            assert!(
                std::env::var("MAILCRAFT_REQUIRE_DB").is_err(),
                "postgres required: {e}"
            );
            eprintln!("SKIP: postgres unreachable ({e})");
            return None;
        }
    };
    let name = format!("mc_snd_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let url = format!("{}/{name}", pg_url().rsplit_once('/').unwrap().0);
    let db = PgPool::connect(&url).await.unwrap();
    sqlx::migrate!("../../migrations").run(&db).await.unwrap();
    Some(db)
}

struct Env {
    app: Router,
    st: AppState,
    db: PgPool,
    admin: String,
    stop: tokio::sync::watch::Sender<bool>,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

/// A set-up, live-enabled workspace; the send engine runs only when asked.
async fn env(run_engine: bool) -> Option<Env> {
    let db = fresh_db().await?;
    std::env::set_var("MAILCRAFT_EGRESS_IP", "203.0.113.10");
    let mut cfg = Config::from_env();
    cfg.rate_limit_per_min = 6000;
    cfg.unsub_secret = b"snd-unsub-secret".to_vec();
    let (st, engine) = wiring::assemble(db.clone(), None, "snd-test-secret-key-0123456789", cfg)
        .await
        .unwrap();
    let app = mailcraft_api::router(st.clone());
    let (stop, rx) = tokio::sync::watch::channel(false);
    if run_engine {
        tokio::spawn(engine.run(rx));
    }
    let (s, setup) = call(&app, "POST", "/v1/setup", None, Some(json!({}))).await;
    assert_eq!(s, StatusCode::CREATED, "{setup}");
    let admin = setup["data"]["admin_key"].as_str().unwrap().to_string();
    sqlx::query(
        "UPDATE workspaces SET live_enabled = true, legal_name = 'T', postal_address = '1 Main St'",
    )
    .execute(&db)
    .await
    .unwrap();
    Some(Env {
        app,
        st,
        db,
        admin,
        stop,
    })
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    key: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(k) = key {
        b = b.header("authorization", format!("Bearer {k}"));
    }
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl Env {
    async fn c(&self, m: &str, p: &str, b: Option<Value>) -> (StatusCode, Value) {
        call(&self.app, m, p, Some(&self.admin), b).await
    }

    /// Creates a transport on a local (never contacted) port; returns its id.
    async fn transport(&self, name: &str, config: Value) -> Uuid {
        let mut c = json!({"host": "127.0.0.1", "port": 1, "tls": "none"});
        c.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let (s, b) = self
            .c(
                "POST",
                "/v1/transports",
                Some(json!({"kind": "smtp-relay", "name": name, "config": c})),
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{b}");
        b["data"]["id"].as_str().unwrap().parse().unwrap()
    }

    /// A mailbox relay: `login` plus optional `aliases` / `display_names`.
    async fn mailbox(&self, name: &str, login: &str, extra: Value) -> Uuid {
        let mut c = json!({"username": login, "password": "pw", "mailbox_sender": true});
        c.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.transport(name, c).await
    }

    /// Adds a domain and (optionally) marks it verified.
    async fn domain(&self, name: &str, verified: bool) -> Uuid {
        let (s, b) = self
            .c("POST", "/v1/domains", Some(json!({"domain": name})))
            .await;
        assert_eq!(s, StatusCode::CREATED, "{b}");
        let id: Uuid = b["data"]["id"].as_str().unwrap().parse().unwrap();
        if verified {
            sqlx::query(
                "UPDATE domains SET status = 'verified', verified_at = now() WHERE id = $1",
            )
            .bind(id)
            .execute(&self.db)
            .await
            .unwrap();
        }
        id
    }

    async fn send(&self, body: Value) -> (StatusCode, Value) {
        let mut b = json!({"to": ["rcpt@example.org"], "subject": "s", "text": "t"});
        b.as_object_mut()
            .unwrap()
            .extend(body.as_object().unwrap().clone());
        self.c("POST", "/v1/emails", Some(b)).await
    }

    /// `(transport_id, domain_id, from_addr, routing decision)` of a queued email.
    async fn row(&self, send_response: &Value) -> (Option<Uuid>, Option<Uuid>, String, Value) {
        let id: Uuid = send_response["data"]["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let (t, d, f, dec): (Option<Uuid>, Option<Uuid>, String, Value) = sqlx::query_as(
            "SELECT transport_id, domain_id, from_addr, policy_decisions FROM emails WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&self.db)
        .await
        .unwrap();
        let routing = dec
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["rule"] == "routing")
            .cloned()
            .unwrap();
        (t, d, f, routing)
    }
}

fn code(b: &Value) -> &str {
    b["error"]["code"].as_str().unwrap_or("")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_send_goes_through_the_transport_its_from_address_routes_to() {
    let Some(e) = env(false).await else { return };
    let default = e.transport("default-relay", json!({})).await;
    let zoho = e
        .mailbox("zoho-one", "a@one.com", json!({"aliases": ["al@one.com"]}))
        .await;
    let two = e.transport("relay-two", json!({})).await;
    e.domain("one.com", false).await;
    let two_dom = e.domain("two.com", true).await;
    let four_dom = e.domain("four.com", true).await;
    let (s, b) = e
        .c(
            "PATCH",
            &format!("/v1/domains/{two_dom}"),
            Some(json!({"transport_id": two})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["data"]["transport_id"], json!(two));

    // the mailbox login: relay 1, no domain row needed
    let (s, b) = e.send(json!({"from": "a@one.com"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let (t, d, _, r) = e.row(&b).await;
    assert_eq!((t, d), (Some(zoho), None));
    assert_eq!(
        (r["why"].as_str(), r["transport"].as_str()),
        (Some("mailbox_relay"), Some("zoho-one"))
    );
    // case does not matter
    let (s, b) = e.send(json!({"from": "A@One.com"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    assert_eq!(e.row(&b).await.0, Some(zoho));
    // an alias of that mailbox: same relay, same shortcut
    let (s, b) = e.send(json!({"from": "al@one.com"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    assert_eq!(e.row(&b).await.0, Some(zoho));
    // another address on that domain is neither the login nor an alias, and the domain is unverified
    let (s, b) = e.send(json!({"from": "b@one.com"})).await;
    assert_eq!(
        (s, code(&b)),
        (StatusCode::UNPROCESSABLE_ENTITY, "domain_not_verified"),
        "{b}"
    );
    // an unknown domain
    let (s, b) = e.send(json!({"from": "x@nowhere.test"})).await;
    assert_eq!(
        (s, code(&b)),
        (StatusCode::UNPROCESSABLE_ENTITY, "domain_not_verified"),
        "{b}"
    );

    // a verified domain bound to relay 2
    let (s, b) = e.send(json!({"from": "x@two.com"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let (t, d, _, r) = e.row(&b).await;
    assert_eq!(
        (t, d, r["why"].as_str()),
        (Some(two), Some(two_dom), Some("domain"))
    );
    // a verified, unbound domain: the workspace default, still pinned on the row
    let (s, b) = e.send(json!({"from": "x@four.com"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let (t, d, _, r) = e.row(&b).await;
    assert_eq!(
        (t, d, r["why"].as_str()),
        (Some(default), Some(four_dom), Some("default"))
    );

    // an explicit transport wins over the domain binding (and over the mailbox shortcut)
    let (s, b) = e
        .send(json!({"from": "x@two.com", "transport_id": default}))
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let (t, _, _, r) = e.row(&b).await;
    assert_eq!((t, r["why"].as_str()), (Some(default), Some("explicit")));
    let (s, b) = e
        .send(json!({"from": "a@one.com", "transport_id": two}))
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    assert_eq!(e.row(&b).await.0, Some(two));
    // ... but never past the domain gate
    let (s, b) = e
        .send(json!({"from": "b@one.com", "transport_id": two}))
        .await;
    assert_eq!(
        (s, code(&b)),
        (StatusCode::UNPROCESSABLE_ENTITY, "domain_not_verified"),
        "{b}"
    );
    // ... and only a transport of this workspace
    let (s, b) = e
        .send(json!({"from": "x@two.com", "transport_id": Uuid::new_v4()}))
        .await;
    assert_eq!((s, code(&b)), (StatusCode::NOT_FOUND, "not_found"), "{b}");

    // a dry run reports the choice without queueing
    let (s, b) = e.send(json!({"from": "al@one.com", "dry_run": true})).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["data"]["transport"], "zoho-one");

    // batch items route one by one
    let (s, b) = e
        .c(
            "POST",
            "/v1/emails/batch",
            Some(json!({"emails": [
                {"from": "a@one.com", "to": ["r@example.org"], "subject": "s", "text": "t"},
                {"from": "x@two.com", "to": ["r@example.org"], "subject": "s", "text": "t"}]})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let ids: Vec<Option<Uuid>> = futures_ids(&e, &b).await;
    assert_eq!(ids, vec![Some(zoho), Some(two)]);

    // a key bound to its own domain still cannot use a mailbox relay address (no domain row)
    let (s, b) = e
        .c(
            "POST",
            "/v1/keys",
            Some(
                json!({"name": "scoped", "env": "live", "scopes": ["send"], "domain_id": four_dom}),
            ),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{b}");
    let scoped = b["data"]["token"]
        .as_str()
        .or(b["data"]["key"].as_str())
        .unwrap()
        .to_string();
    let (s, b) = call(
        &e.app,
        "POST",
        "/v1/emails",
        Some(&scoped),
        Some(json!({"from": "a@one.com", "to": ["r@example.org"], "subject": "s", "text": "t"})),
    )
    .await;
    assert_eq!(
        (s, code(&b)),
        (StatusCode::FORBIDDEN, "blocked_by_policy"),
        "{b}"
    );
}

async fn futures_ids(e: &Env, batch: &Value) -> Vec<Option<Uuid>> {
    let mut out = Vec::new();
    for item in batch["data"].as_array().unwrap() {
        assert_eq!(item["ok"], true, "{item}");
        let id: Uuid = item["data"]["id"].as_str().unwrap().parse().unwrap();
        out.push(
            sqlx::query_scalar("SELECT transport_id FROM emails WHERE id = $1")
                .bind(id)
                .fetch_one(&e.db)
                .await
                .unwrap(),
        );
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connected_address_goes_out_under_its_display_name() {
    let Some(e) = env(false).await else { return };
    let zoho = e
        .mailbox(
            "zoho",
            "dev@acme.test",
            json!({"aliases": ["Support@acme.test"],
                   "display_names": {"dev@acme.test": "Acme Developers", "support@acme.test": "Acme Support"}}),
        )
        .await;
    let (s, b) = e.send(json!({"from": "dev@acme.test"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    assert_eq!(e.row(&b).await.2, "\"Acme Developers\" <dev@acme.test>");
    let (s, b) = e.send(json!({"from": "support@acme.test"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let (t, _, from, _) = e.row(&b).await;
    assert_eq!(
        (t, from.as_str()),
        (Some(zoho), "\"Acme Support\" <support@acme.test>")
    );
    // a name the caller wrote is theirs
    let (s, b) = e.send(json!({"from": "Custom Name <dev@acme.test>"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    assert_eq!(e.row(&b).await.2, "Custom Name <dev@acme.test>");

    // the automations engine asks the same router
    let ws: Uuid = sqlx::query_scalar("SELECT id FROM workspaces")
        .fetch_one(&e.db)
        .await
        .unwrap();
    let (from, t) = e.st.route(ws, "dev@acme.test", None).await.unwrap();
    assert_eq!(
        (from.as_str(), t),
        ("\"Acme Developers\" <dev@acme.test>", Some(zoho))
    );
    let (from, _) = e.st.route(ws, "Mine <dev@acme.test>", None).await.unwrap();
    assert_eq!(from, "Mine <dev@acme.test>");
    assert!(e
        .st
        .route(ws, "dev@acme.test", Some(Uuid::new_v4()))
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn broadcasts_route_by_their_from_address() {
    let Some(e) = env(false).await else { return };
    let _default = e.transport("default-relay", json!({})).await;
    let zoho = e.mailbox("zoho", "news@one.com", json!({})).await;
    let (s, b) = e
        .c(
            "POST",
            "/v1/templates",
            Some(
                json!({"name": "news", "stream": "marketing", "content": {"version": 1,
                "subject": "News", "blocks": [{"type": "paragraph", "text": "Hello"}]}}),
            ),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{b}");
    let (s, b) = e.c("POST", "/v1/templates/news/publish", None).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let (s, b) = e
        .c(
            "POST",
            "/v1/broadcasts",
            Some(json!({"template_id": "news", "from": "news@one.com",
                        "recipients": [{"email": "a@example.org"}, {"email": "b@example.org"}]})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let bid: Uuid = b["data"]["id"].as_str().unwrap().parse().unwrap();
    let ts: Vec<Option<Uuid>> =
        sqlx::query_scalar("SELECT transport_id FROM emails WHERE broadcast_id = $1")
            .bind(bid)
            .fetch_all(&e.db)
            .await
            .unwrap();
    assert_eq!(ts, vec![Some(zoho), Some(zoho)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn senders_list_status_and_domains_mark_every_mailbox_relay() {
    let Some(e) = env(false).await else { return };
    let one = e
        .mailbox(
            "zoho-one",
            "a@one.com",
            json!({"aliases": ["al@one.com"], "display_names": {"a@one.com": "One"}}),
        )
        .await;
    let acme = e.mailbox("zoho-acme", "dev@acme.test", json!({})).await;
    let plain = e.transport("plain", json!({})).await;
    let one_dom = e.domain("one.com", false).await;
    let acme_dom = e.domain("acme.test", false).await;
    let two_dom = e.domain("two.com", true).await;
    let (s, _) = e
        .c(
            "PATCH",
            &format!("/v1/domains/{two_dom}"),
            Some(json!({"transport_id": plain})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);

    // domains: each domain lists the mailbox addresses on it, whichever relay they belong to
    let (s, b) = e.c("GET", "/v1/domains", None).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let by_id = |id: Uuid| {
        b["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == json!(id))
            .cloned()
            .unwrap()
    };
    let (d1, d2, d3) = (by_id(one_dom), by_id(acme_dom), by_id(two_dom));
    assert_eq!(d1["relay_senders"], json!(["a@one.com", "al@one.com"]));
    assert_eq!(d1["relay_sender"], "a@one.com");
    assert_eq!(d2["relay_senders"], json!(["dev@acme.test"]));
    assert!(d3.get("relay_senders").is_none() && d3["transport_id"] == json!(plain));
    assert!(d1["transport_id"].is_null());
    let (_, g) = e.c("GET", &format!("/v1/domains/{acme_dom}"), None).await;
    assert_eq!(g["data"]["relay_sender"], "dev@acme.test");

    // senders: login + alias of each mailbox, all ready; the default is marked
    let (s, _) = e
        .c(
            "PUT",
            "/v1/settings",
            Some(json!({"default_from": "al@one.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, b) = e.c("GET", "/v1/senders", None).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let rows = b["data"].as_array().unwrap();
    let get = |a: &str| rows.iter().find(|r| r["address"] == a).cloned().unwrap();
    assert_eq!(rows.len(), 3, "{rows:?}");
    let a = get("a@one.com");
    assert_eq!(
        (
            a["display_name"].as_str(),
            a["kind"].as_str(),
            a["status"].as_str(),
            a["transport"].as_str(),
            a["is_default"].as_bool()
        ),
        (
            Some("One"),
            Some("login"),
            Some("ready"),
            Some("zoho-one"),
            Some(false)
        ),
    );
    assert_eq!(a["transport_id"], json!(one));
    let al = get("al@one.com");
    assert_eq!(
        (
            al["kind"].as_str(),
            al["is_default"].as_bool(),
            al["display_name"].is_null()
        ),
        (Some("alias"), Some(true), true)
    );
    assert_eq!(get("dev@acme.test")["transport_id"], json!(acme));

    // a default that is not a connected mailbox is listed with what it still needs
    for (from, status, transport) in [
        ("hello@two.com", "ready", Some("plain")),
        ("hello@nowhere.test", "needs_domain", Some("zoho-one")),
    ] {
        let (s, _) = e
            .c("PUT", "/v1/settings", Some(json!({"default_from": from})))
            .await;
        assert_eq!(s, StatusCode::OK);
        let (_, b) = e.c("GET", "/v1/senders", None).await;
        let r = b["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["address"] == from)
            .cloned()
            .unwrap();
        assert_eq!(
            (
                r["status"].as_str(),
                r["kind"].as_str(),
                r["is_default"].as_bool(),
                r["transport"].as_str()
            ),
            (Some(status), Some("domain"), Some(true), transport),
            "{from}"
        );
    }

    // editing the relay shows at once
    let (s, b) = e
        .c(
            "PATCH",
            &format!("/v1/transports/{acme}"),
            Some(json!({"aliases": ["partner@acme.test"], "display_names": {"partner@acme.test": "Acme Partners", "dev@acme.test": "Acme Dev"}})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let (_, b) = e.c("GET", "/v1/senders", None).await;
    let p = b["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["address"] == "partner@acme.test")
        .cloned()
        .unwrap();
    assert_eq!(
        (
            p["display_name"].as_str(),
            p["status"].as_str(),
            p["kind"].as_str()
        ),
        (Some("Acme Partners"), Some("ready"), Some("alias"))
    );
    // ... including the send path
    let (s, b) = e.send(json!({"from": "partner@acme.test"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let (t, _, from, _) = e.row(&b).await;
    assert_eq!(
        (t, from.as_str()),
        (Some(acme), "\"Acme Partners\" <partner@acme.test>")
    );
    // audited
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action IN ('transport.update','domain.update')",
    )
    .fetch_one(&e.db)
    .await
    .unwrap();
    assert_eq!(n, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_verified_domain_without_any_transport_is_transport_missing() {
    let Some(e) = env(false).await else { return };
    e.domain("two.com", true).await;
    e.c(
        "PUT",
        "/v1/settings",
        Some(json!({"default_from": "hi@two.com"})),
    )
    .await;
    let (_, b) = e.c("GET", "/v1/senders", None).await;
    assert_eq!(b["data"][0]["status"], "transport_missing", "{b}");
    assert!(b["data"][0]["transport_id"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_alias_and_display_name_validation_and_domain_binding() {
    let Some(e) = env(false).await else { return };
    let post = |config: Value| {
        let c = json!({"host": "127.0.0.1", "port": 1, "tls": "none", "password": "pw"});
        let mut c = c;
        c.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        json!({"kind": "smtp-relay", "config": c})
    };
    for (cfg, field) in [
        // aliases without a mailbox relay
        (
            json!({"username": "a@one.com", "aliases": ["b@one.com"]}),
            "config.aliases",
        ),
        // not a plain address
        (
            json!({"username": "a@one.com", "mailbox_sender": true, "aliases": ["Name <b@one.com>"]}),
            "config.aliases",
        ),
        (
            json!({"username": "a@one.com", "mailbox_sender": true, "aliases": ["nope"]}),
            "config.aliases",
        ),
        // a name for an address that is not on the relay
        (
            json!({"username": "a@one.com", "mailbox_sender": true, "display_names": {"z@one.com": "Z"}}),
            "config.display_names",
        ),
        // a name that would break the header
        (
            json!({"username": "a@one.com", "mailbox_sender": true, "display_names": {"a@one.com": "A\" <x@evil.test>"}}),
            "config.display_names",
        ),
        // the login must be an address
        (
            json!({"username": "apikey", "mailbox_sender": true}),
            "config.mailbox_sender",
        ),
    ] {
        let (s, b) = e.c("POST", "/v1/transports", Some(post(cfg.clone()))).await;
        assert_eq!(
            (s, b["error"]["field"].as_str()),
            (StatusCode::BAD_REQUEST, Some(field)),
            "{cfg} -> {b}"
        );
    }
    // the secrets stay write-only; the aliases come back lowercased and de-duplicated
    let (s, b) = e
        .c("POST", "/v1/transports", Some(post(json!({"username": "A@One.com", "mailbox_sender": true, "aliases": ["B@one.com", "b@one.com", "a@one.com"]}))))
        .await;
    assert_eq!(s, StatusCode::CREATED, "{b}");
    assert_eq!(b["data"]["detail"]["aliases"], json!(["b@one.com"]));
    assert!(!b["data"].to_string().contains("pw"));
    let relay: Uuid = b["data"]["id"].as_str().unwrap().parse().unwrap();
    // a plain relay has nothing to edit
    let plain = e.transport("plain", json!({})).await;
    let (s, _) = e
        .c(
            "PATCH",
            &format!("/v1/transports/{plain}"),
            Some(json!({"aliases": ["x@one.com"]})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = e
        .c(
            "PATCH",
            &format!("/v1/transports/{}", Uuid::new_v4()),
            Some(json!({"aliases": []})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // PATCH keeps what it is not given
    let (s, b) = e
        .c(
            "PATCH",
            &format!("/v1/transports/{relay}"),
            Some(json!({"display_names": {"b@one.com": "Bee"}})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(
        (&b["data"]["aliases"], &b["data"]["display_names"]),
        (&json!(["b@one.com"]), &json!({"b@one.com": "Bee"}))
    );

    // domain binding: only this workspace's transports; null unbinds; unknown domain
    let dom = e.domain("two.com", false).await;
    let (s, b) = e
        .c(
            "PATCH",
            &format!("/v1/domains/{dom}"),
            Some(json!({"transport_id": Uuid::new_v4()})),
        )
        .await;
    assert_eq!(
        (s, b["error"]["field"].as_str()),
        (StatusCode::NOT_FOUND, Some("transport_id")),
        "{b}"
    );
    let (s, b) = e
        .c(
            "PATCH",
            &format!("/v1/domains/{dom}"),
            Some(json!({"transport_id": plain})),
        )
        .await;
    assert_eq!(
        (s, &b["data"]["transport_id"]),
        (StatusCode::OK, &json!(plain)),
        "{b}"
    );
    let (s, b) = e
        .c(
            "PATCH",
            &format!("/v1/domains/{dom}"),
            Some(json!({"transport_id": null})),
        )
        .await;
    assert!(
        s == StatusCode::OK && b["data"]["transport_id"].is_null(),
        "{b}"
    );
    let (s, _) = e
        .c(
            "PATCH",
            &format!("/v1/domains/{}", Uuid::new_v4()),
            Some(json!({"transport_id": null})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // deleting a bound transport unbinds it instead of failing
    e.c(
        "PATCH",
        &format!("/v1/domains/{dom}"),
        Some(json!({"transport_id": plain})),
    )
    .await;
    let (s, _) = e
        .c("DELETE", &format!("/v1/transports/{plain}"), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, g) = e.c("GET", &format!("/v1/domains/{dom}"), None).await;
    assert!(g["data"]["transport_id"].is_null());
}

/// SMTP sink that keeps each MAIL FROM and DATA payload.
async fn smtp_sink() -> (u16, Arc<Mutex<Vec<(String, String)>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let got: Arc<Mutex<Vec<(String, String)>>> = Default::default();
    let store = got.clone();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let store = store.clone();
            tokio::spawn(async move {
                let (r, mut w) = s.into_split();
                let mut r = BufReader::new(r);
                let _ = w.write_all(b"220 sink ESMTP\r\n").await;
                let (mut from, mut data, mut in_data) = (String::new(), String::new(), false);
                let mut line = String::new();
                loop {
                    line.clear();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    if in_data {
                        if line == ".\r\n" {
                            store
                                .lock()
                                .unwrap()
                                .push((from.clone(), std::mem::take(&mut data)));
                            in_data = false;
                            let _ = w.write_all(b"250 2.0.0 queued as sink-1\r\n").await;
                        } else {
                            data.push_str(&line);
                        }
                        continue;
                    }
                    let up = line.to_ascii_uppercase();
                    let reply: &[u8] = if up.starts_with("EHLO") || up.starts_with("HELO") {
                        b"250-sink\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n"
                    } else if up.starts_with("AUTH") {
                        b"235 2.7.0 ok\r\n"
                    } else if up.starts_with("MAIL FROM:") {
                        from = line.trim().to_string();
                        b"250 ok\r\n"
                    } else if up.starts_with("DATA") {
                        in_data = true;
                        b"354 go\r\n"
                    } else if up.starts_with("QUIT") {
                        let _ = w.write_all(b"221 bye\r\n").await;
                        return;
                    } else {
                        b"250 ok\r\n"
                    };
                    let _ = w.write_all(reply).await;
                }
            });
        }
    });
    (port, got)
}

/// Zoho-style "send mail as": the SMTP login is the envelope sender, the alias is only the From header.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_alias_sends_with_the_login_as_envelope_and_the_alias_as_from() {
    let Some(e) = env(true).await else { return };
    let (port, inbox) = smtp_sink().await;
    let mut c = json!({"host": "127.0.0.1", "port": port, "tls": "none"});
    c.as_object_mut().unwrap().extend(
        json!({"username": "a@one.com", "password": "pw", "mailbox_sender": true,
               "aliases": ["b@one.com"], "display_names": {"b@one.com": "Bee Team"}})
        .as_object()
        .unwrap()
        .clone(),
    );
    let (s, t) = e
        .c(
            "POST",
            "/v1/transports",
            Some(json!({"kind": "smtp-relay", "name": "zoho", "config": c})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{t}");
    let (s, b) = e.send(json!({"from": "b@one.com"})).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let end = Instant::now() + Duration::from_secs(30);
    while inbox.lock().unwrap().is_empty() {
        if Instant::now() >= end {
            let st: (String, Option<String>, i32) =
                sqlx::query_as("SELECT status, last_error, attempts FROM emails")
                    .fetch_one(&e.db)
                    .await
                    .unwrap();
            panic!("the sink received nothing; email: {st:?}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let (mail_from, data) = inbox.lock().unwrap()[0].clone();
    assert_eq!(mail_from, "MAIL FROM:<a@one.com>", "{data}");
    let from_header = data.lines().find(|l| l.starts_with("From:")).unwrap();
    assert!(
        from_header.contains("Bee Team")
            && from_header.contains("<b@one.com>")
            && !from_header.contains("a@one.com"),
        "{from_header}"
    );
    let id: Uuid = b["data"]["id"].as_str().unwrap().parse().unwrap();
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        let st: String = sqlx::query_scalar("SELECT status FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(&e.db)
            .await
            .unwrap();
        if st == "sent" {
            break;
        }
        assert!(Instant::now() < end, "status stuck at {st}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
