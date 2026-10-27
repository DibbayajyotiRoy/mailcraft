//! Inbound bounce / complaint / unsubscribe processing against real Postgres: SMTP receiver,
//! `/ingest/raw`, `/ingest/ses`. Needs MAILCRAFT_TEST_PG (default :55432); fails instead of skipping
//! when MAILCRAFT_REQUIRE_DB=1.
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use mailcraft_api::{ingest, router, smtp_in, webhooks, AppState, Config};
use mailcraft_core::crypto::SecretBox;
use mailcraft_deliverability::unsubscribe::{self, Category, UnsubToken};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{tcp::OwnedWriteHalf, TcpListener, TcpStream},
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &[u8] = b"unsub-secret";
const HOST: &str = "bounce.mail.example.test";
const ARN: &str = "arn:aws:sns:us-east-1:123456789012:ses-events";

fn pg_url() -> String {
    std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55432/postgres".into())
}

struct Ctx {
    st: AppState,
    ws: Uuid,
}

async fn setup() -> Option<Ctx> {
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
    let name = format!("mc_in_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let db = PgPool::connect(&format!("{}/{name}", pg_url().rsplit_once('/').unwrap().0))
        .await
        .unwrap();
    sqlx::migrate!("../../migrations").run(&db).await.unwrap();
    let ws = sqlx::query_scalar("INSERT INTO workspaces (name) VALUES ('t') RETURNING id")
        .fetch_one(&db)
        .await
        .unwrap();
    let config = Config {
        unsub_secret: SECRET.to_vec(),
        ingest_token: Some("tok".into()),
        ses_topic_arns: vec![ARN.into()],
        ..Config::from_env()
    };
    let st = AppState::new(db, None, SecretBox::from_key(&[1u8; 32]).unwrap(), config);
    Some(Ctx { st, ws })
}

impl Ctx {
    async fn email(&self, to: &str, ses_id: Option<&str>) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO emails (workspace_id, stream, from_addr, to_addr, subject, status, provider_message_id) \
             VALUES ($1,'marketing','news@mail.example.test',$2,'hi','sent',$3) RETURNING id",
        )
        .bind(self.ws)
        .bind(to)
        .bind(ses_id)
        .fetch_one(&self.st.db)
        .await
        .unwrap()
    }
    async fn events(&self, id: Uuid) -> Vec<(String, Option<String>)> {
        sqlx::query_as(
            "SELECT type, bounce_class FROM email_events WHERE email_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(&self.st.db)
        .await
        .unwrap()
    }
    async fn suppression(&self, to: &str) -> Option<String> {
        sqlx::query_scalar("SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2")
            .bind(self.ws)
            .bind(to)
            .fetch_optional(&self.st.db)
            .await
            .unwrap()
    }
    async fn status(&self, id: Uuid) -> String {
        sqlx::query_scalar("SELECT status FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(&self.st.db)
            .await
            .unwrap()
    }
    /// SMTP receiver on an ephemeral port.
    async fn smtp(&self, max: usize) -> (u16, tokio::sync::watch::Sender<bool>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::watch::channel(false);
        tokio::spawn(smtp_in::serve(self.st.clone(), l, max, rx));
        (port, tx)
    }
}

/// Fixture from the deliverability crate with our signed VERP return path substituted.
fn fixture(eml: &str, id: Uuid) -> String {
    eml.replace("{{VERP}}", &ingest::return_path(SECRET, id, HOST))
        .replace("{{MSGID}}", &id.simple().to_string())
}
const USER_UNKNOWN: &str =
    include_str!("../../mailcraft-deliverability/tests/fixtures/postfix_user_unknown.eml");
const MAILBOX_FULL: &str =
    include_str!("../../mailcraft-deliverability/tests/fixtures/postfix_mailbox_full.eml");
const BLOCK: &str =
    include_str!("../../mailcraft-deliverability/tests/fixtures/gmail_block_5_7_26.eml");
const ARF: &str = include_str!("../../mailcraft-deliverability/tests/fixtures/arf_yahoo_cfl.eml");

// ---- tiny SMTP client
async fn reply(r: &mut BufReader<tokio::net::tcp::OwnedReadHalf>) -> String {
    loop {
        let mut l = String::new();
        r.read_line(&mut l).await.unwrap();
        if l.len() < 4 || l.as_bytes()[3] == b' ' {
            return l.trim().to_string();
        }
    }
}
async fn cmd(
    r: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
    w: &mut OwnedWriteHalf,
    c: &str,
) -> String {
    w.write_all(format!("{c}\r\n").as_bytes()).await.unwrap();
    reply(r).await
}
/// One message to `rcpts`; returns every reply code line from RCPT on plus the DATA result.
async fn deliver(port: u16, rcpts: &[String], body: &str) -> Vec<String> {
    let (r, mut w) = TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap()
        .into_split();
    let mut r = BufReader::new(r);
    assert!(reply(&mut r).await.starts_with("220"));
    cmd(&mut r, &mut w, "EHLO t").await;
    cmd(&mut r, &mut w, "MAIL FROM:<>").await;
    let mut out = vec![];
    for a in rcpts {
        out.push(cmd(&mut r, &mut w, &format!("RCPT TO:<{a}>")).await);
    }
    if out.iter().any(|o| o.starts_with("250")) {
        assert!(cmd(&mut r, &mut w, "DATA").await.starts_with("354"));
        let stuffed: String = body
            .replace("\r\n", "\n")
            .lines()
            .map(|l| {
                if l.starts_with('.') {
                    format!(".{l}\r\n")
                } else {
                    format!("{l}\r\n")
                }
            })
            .collect();
        w.write_all(format!("{stuffed}.\r\n").as_bytes())
            .await
            .unwrap();
        out.push(reply(&mut r).await);
    }
    out
}
fn vp(id: Uuid) -> String {
    ingest::return_path(SECRET, id, HOST)
}

#[tokio::test]
async fn dsn_marks_bounced_suppresses_and_fans_out() {
    let Some(c) = setup().await else { return };
    let id = c.email("ghost@corp.example.org", None).await;
    let (port, _s) = c.smtp(1 << 20).await;
    let r = deliver(port, &[vp(id)], &fixture(USER_UNKNOWN, id)).await;
    assert!(r[0].starts_with("250") && r[1].starts_with("250"), "{r:?}");
    assert_eq!(c.status(id).await, "bounced");
    assert_eq!(
        c.events(id).await,
        vec![("bounced".into(), Some("hard".into()))]
    );
    assert_eq!(
        c.suppression("ghost@corp.example.org").await.as_deref(),
        Some("hard_bounce")
    );
    // redelivered DSN: accepted, nothing doubled
    deliver(port, &[vp(id)], &fixture(USER_UNKNOWN, id)).await;
    assert_eq!(c.events(id).await.len(), 1);
    // the existing outbox picks the event up for webhooks
    assert!(webhooks::fan_out(&c.st, 100).await.unwrap() >= 1);
}

#[tokio::test]
async fn arf_complaint_suppresses_and_block_class_does_not() {
    let Some(c) = setup().await else { return };
    let (port, _s) = c.smtp(1 << 20).await;
    let a = c.email("angry@yahoo.example", None).await;
    deliver(port, &[vp(a)], &fixture(ARF, a)).await;
    assert_eq!(c.events(a).await, vec![("complained".into(), None)]);
    assert_eq!(
        c.suppression("angry@yahoo.example").await.as_deref(),
        Some("complaint")
    );

    let b = c.email("fine@gmail.example", None).await;
    deliver(port, &[vp(b)], &fixture(BLOCK, b)).await;
    assert_eq!(
        c.events(b).await,
        vec![("bounced".into(), Some("block".into()))]
    );
    assert_eq!(
        c.suppression("fine@gmail.example").await,
        None,
        "our reputation problem, not the recipient's"
    );
}

#[tokio::test]
async fn third_soft_bounce_in_a_week_suppresses() {
    let Some(c) = setup().await else { return };
    let (port, _s) = c.smtp(1 << 20).await;
    for n in 1..=3 {
        let id = c.email("full@corp.example.org", None).await;
        deliver(port, &[vp(id)], &fixture(MAILBOX_FULL, id)).await;
        let want = (n == 3).then_some("soft_bounce_limit");
        assert_eq!(
            c.suppression("full@corp.example.org").await.as_deref(),
            want,
            "after soft bounce {n}"
        );
    }
}

#[tokio::test]
async fn unknown_or_forged_recipients_are_rejected_at_rcpt() {
    let Some(c) = setup().await else { return };
    let id = c.email("x@y.example", None).await;
    let (port, _s) = c.smtp(1 << 20).await;
    let forged = format!("bounce+{}.AAAAAAAA@{HOST}", id.simple());
    let no_email = vp(Uuid::new_v4()); // valid MAC, no such email
    for bad in [
        "postmaster@example.com",
        "bounce+junk@example.com",
        forged.as_str(),
        no_email.as_str(),
    ] {
        let r = deliver(port, &[bad.to_string()], "Subject: x\r\n\r\nhi").await;
        assert_eq!(r.len(), 1, "no DATA for {bad}");
        assert!(r[0].starts_with("550"), "{bad}: {r:?}");
    }
    assert!(c.events(id).await.is_empty());
}

#[tokio::test]
async fn oversize_message_is_refused() {
    let Some(c) = setup().await else { return };
    let id = c.email("ghost@corp.example.org", None).await;
    let (port, _s) = c.smtp(200).await;
    let r = deliver(port, &[vp(id)], &fixture(USER_UNKNOWN, id)).await;
    assert!(r[1].starts_with("552"), "{r:?}");
    assert!(c.events(id).await.is_empty());
}

#[tokio::test]
async fn mailto_unsubscribe_opts_the_contact_out() {
    let Some(c) = setup().await else { return };
    let contact: Uuid = sqlx::query_scalar(
        "INSERT INTO contacts (workspace_id, email) VALUES ($1,'u@x.example') RETURNING id",
    )
    .bind(c.ws)
    .fetch_one(&c.st.db)
    .await
    .unwrap();
    let tok = unsubscribe::issue(
        SECRET,
        &UnsubToken {
            tenant: c.ws.simple().to_string(),
            contact: contact.to_string(),
            category: Category::Product,
            exp: chrono::Utc::now().timestamp() as u64 + 3600,
        },
    )
    .unwrap();
    let (port, _s) = c.smtp(1 << 20).await;
    let r = deliver(
        port,
        &[format!("unsub+{tok}@mx.example.test")],
        "Subject: unsubscribe\r\n\r\n",
    )
    .await;
    assert!(r[1].starts_with("250"), "{r:?}");
    let opted: bool =
        sqlx::query_scalar("SELECT opted_in FROM contact_topics WHERE contact_id = $1")
            .bind(contact)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert!(!opted);
    let bad = deliver(port, &["unsub+garbage@mx.example.test".into()], "x").await;
    assert!(bad[0].starts_with("550"));
}

async fn post(c: &Ctx, uri: &str, body: String, bearer: Option<&str>) -> (u16, Value) {
    let mut rq = Request::post(uri);
    if let Some(b) = bearer {
        rq = rq.header("authorization", format!("Bearer {b}"));
    }
    let res = router(c.st.clone())
        .oneshot(rq.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let s = res.status().as_u16();
    let b = res.into_body().collect().await.unwrap().to_bytes();
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

fn sns(arn: &str, msg: Value) -> String {
    json!({"Type":"Notification","MessageId":"sns-1","TopicArn":arn,"Message":msg.to_string()})
        .to_string()
}

#[tokio::test]
async fn ses_sns_bounce_and_complaint_are_recorded() {
    let Some(c) = setup().await else { return };
    let id = c.email("gone@example.org", Some("ses-100")).await;
    let bounce = json!({"notificationType":"Bounce","mail":{"messageId":"ses-100"},
        "bounce":{"bounceType":"Permanent","bounceSubType":"General","bouncedRecipients":[
          {"emailAddress":"gone@example.org","status":"5.1.1","diagnosticCode":"smtp; 550 5.1.1 user unknown"}]}});
    let body = sns(ARN, bounce);
    assert_eq!(post(&c, "/ingest/ses", body.clone(), None).await.0, 401);
    assert_eq!(
        post(&c, "/ingest/ses?token=wrong", body.clone(), None)
            .await
            .0,
        401
    );
    assert_eq!(
        post(
            &c,
            "/ingest/ses",
            sns("arn:aws:sns:us-east-1:1:evil", json!({})),
            Some("tok")
        )
        .await
        .0,
        403
    );
    let (s, b) = post(&c, "/ingest/ses?token=tok", body.clone(), None).await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(
        c.events(id).await,
        vec![("bounced".into(), Some("hard".into()))]
    );
    assert_eq!(c.status(id).await, "bounced");
    assert_eq!(
        c.suppression("gone@example.org").await.as_deref(),
        Some("hard_bounce")
    );
    post(&c, "/ingest/ses?token=tok", body, None).await; // SNS retry
    assert_eq!(c.events(id).await.len(), 1);

    let id2 = c.email("mad@example.org", Some("ses-200")).await;
    let complaint = json!({"notificationType":"Complaint","mail":{"messageId":"ses-200"},
        "complaint":{"complaintFeedbackType":"abuse","complainedRecipients":[{"emailAddress":"mad@example.org"}]}});
    let body = json!({"Type":"Notification","MessageId":"sns-2","TopicArn":ARN,"Message":complaint.to_string()}).to_string();
    post(&c, "/ingest/ses", body, Some("tok")).await;
    assert_eq!(c.events(id2).await, vec![("complained".into(), None)]);
    assert_eq!(
        c.suppression("mad@example.org").await.as_deref(),
        Some("complaint")
    );

    // subscription confirmation only ever follows an https SNS host
    let conf = json!({"Type":"SubscriptionConfirmation","TopicArn":ARN,"SubscribeURL":"http://127.0.0.1:9/confirm"}).to_string();
    assert_eq!(post(&c, "/ingest/ses", conf, Some("tok")).await.0, 400);
}

#[tokio::test]
async fn raw_endpoint_takes_a_dsn() {
    let Some(c) = setup().await else { return };
    let id = c.email("ghost@corp.example.org", None).await;
    let dsn = fixture(USER_UNKNOWN, id);
    assert_eq!(post(&c, "/ingest/raw", dsn.clone(), None).await.0, 401);
    let (s, b) = post(&c, "/ingest/raw", dsn, Some("tok")).await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(b["data"]["outcome"]["event"], "bounced");
    assert_eq!(
        c.suppression("ghost@corp.example.org").await.as_deref(),
        Some("hard_bounce")
    );
    // a report without a verified VERP token is ignored, never guessed
    let unsigned = USER_UNKNOWN
        .replace("{{VERP}}", &format!("bounce+{}@{HOST}", id.simple()))
        .replace("{{MSGID}}", "x");
    let (_, b) = post(&c, "/ingest/raw", unsigned, Some("tok")).await;
    assert_eq!(b["data"]["outcome"], Value::Null);
}
