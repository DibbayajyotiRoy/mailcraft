//! Idempotent record sync against the Cloudflare v4 DNS API.
use crate::dns::plan::{RType, Record};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const CF_API: &str = "https://api.cloudflare.com/client/v4";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Create,
    Update,
    Unchanged,
}

#[derive(Debug, Clone, Serialize)]
pub struct Change {
    pub action: Action,
    pub name: String,
    pub rtype: RType,
    pub value: String,
    /// What was there before (Update only).
    pub previous: Option<String>,
}

pub struct Cloudflare {
    base: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct Envelope {
    success: bool,
    #[serde(default)]
    errors: Vec<Value>,
    #[serde(default)]
    result: Value,
}

/// Strip the quoting/splitting Cloudflare may echo back on TXT content.
fn norm(s: &str) -> String {
    s.replace("\" \"", "").trim_matches('"').to_string()
}

impl Cloudflare {
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_base(CF_API, token)
    }
    pub fn with_base(base: &str, token: impl Into<String>) -> Self {
        Self {
            base: base.trim_end_matches('/').into(),
            token: token.into(),
            http: reqwest::Client::new(),
        }
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut rq = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            rq = rq.json(&b);
        }
        let resp = rq.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let env: Envelope = resp
            .json()
            .await
            .map_err(|e| format!("HTTP {status}: unreadable response: {e}"))?;
        if !env.success {
            return Err(format!(
                "Cloudflare HTTP {status}: {}",
                serde_json::to_string(&env.errors).unwrap_or_default()
            ));
        }
        Ok(env.result)
    }

    /// Find the zone id by trying the longest suffix of `domain` first (mail.example.com, example.com).
    pub async fn find_zone(&self, domain: &str) -> Result<String, String> {
        let labels: Vec<&str> = domain.split('.').collect();
        for i in 0..labels.len().saturating_sub(1) {
            let cand = labels[i..].join(".");
            let r = self
                .call(reqwest::Method::GET, &format!("/zones?name={cand}"), None)
                .await?;
            if let Some(id) = r.get(0).and_then(|z| z["id"].as_str()) {
                return Ok(id.into());
            }
        }
        Err(format!(
            "no Cloudflare zone for {domain} visible to this token"
        ))
    }

    /// Create/update records so the zone matches `records`. With `dry_run` nothing is written.
    pub async fn sync(
        &self,
        zone: &str,
        records: &[Record],
        dry_run: bool,
    ) -> Result<Vec<Change>, String> {
        let mut out = Vec::new();
        for r in records {
            let t = r.rtype.as_str();
            let existing = self
                .call(
                    reqwest::Method::GET,
                    &format!("/zones/{zone}/dns_records?type={t}&name={}", r.name),
                    None,
                )
                .await?;
            let list = existing.as_array().cloned().unwrap_or_default();
            let same = |e: &Value| {
                norm(e["content"].as_str().unwrap_or_default()) == norm(&r.value)
                    && (r.rtype != RType::Mx || e["priority"].as_u64() == r.priority.map(u64::from))
            };
            let mut ch = Change {
                action: Action::Create,
                name: r.name.clone(),
                rtype: r.rtype,
                value: r.value.clone(),
                previous: None,
            };
            let mut body = json!({"type": t, "name": r.name, "content": r.value, "ttl": 1});
            if r.rtype == RType::Cname {
                body["proxied"] = json!(false); // DKIM/MTA-STS CNAMEs must resolve to the target, not CF's proxy
            }
            if let Some(p) = r.priority {
                body["priority"] = json!(p);
            }
            let target_id = if list.iter().any(&same) {
                ch.action = Action::Unchanged;
                None
            } else if let Some(e) = list.first() {
                // ponytail: multiple same-name records -> overwrite the first. SPF/DMARC/DKIM are
                // single-valued, and the bounce subdomain is ours; revisit if MX sets get shared.
                ch.action = Action::Update;
                ch.previous = e["content"].as_str().map(str::to_owned);
                e["id"].as_str().map(str::to_owned)
            } else {
                None
            };
            if !dry_run {
                match (&ch.action, target_id) {
                    (Action::Create, _) => {
                        self.call(
                            reqwest::Method::POST,
                            &format!("/zones/{zone}/dns_records"),
                            Some(body),
                        )
                        .await?;
                    }
                    (Action::Update, Some(id)) => {
                        self.call(
                            reqwest::Method::PUT,
                            &format!("/zones/{zone}/dns_records/{id}"),
                            Some(body),
                        )
                        .await?;
                    }
                    _ => {}
                }
            }
            out.push(ch);
        }
        Ok(out)
    }
}

pub fn render_changes(c: &[Change], dry_run: bool) -> String {
    let verb = |a: Action| match (a, dry_run) {
        (Action::Create, true) => "would create",
        (Action::Create, false) => "created",
        (Action::Update, true) => "would update",
        (Action::Update, false) => "updated",
        (Action::Unchanged, _) => "unchanged",
    };
    c.iter()
        .map(|x| {
            let prev = x
                .previous
                .as_ref()
                .map(|p| format!(" (was: {p})"))
                .unwrap_or_default();
            format!(
                "{:<12} {:<5} {}{prev}\n",
                verb(x.action),
                x.rtype.as_str(),
                x.name
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dns::plan::Purpose;
    use httpmock::prelude::*;

    fn txt(name: &str, v: &str) -> Record {
        Record {
            name: name.into(),
            rtype: RType::Txt,
            value: v.into(),
            priority: None,
            purpose: Purpose::Dmarc,
            note: String::new(),
        }
    }
    fn ok(result: Value) -> Value {
        json!({"success": true, "errors": [], "result": result})
    }

    #[tokio::test]
    async fn zone_walk_finds_parent() {
        let s = MockServer::start();
        s.mock(|w, t| {
            w.method(GET)
                .path("/zones")
                .query_param("name", "mail.example.com")
                .header("authorization", "Bearer tok");
            t.json_body(ok(json!([])));
        });
        s.mock(|w, t| {
            w.method(GET)
                .path("/zones")
                .query_param("name", "example.com");
            t.json_body(ok(json!([{"id": "z1"}])));
        });
        let cf = Cloudflare::with_base(&s.base_url(), "tok");
        assert_eq!(cf.find_zone("mail.example.com").await.unwrap(), "z1");
    }

    #[tokio::test]
    async fn creates_updates_and_skips() {
        let s = MockServer::start();
        let list = |s: &MockServer, name: &'static str, res: Value| {
            s.mock(move |w, t| {
                w.method(GET)
                    .path("/zones/z/dns_records")
                    .query_param("name", name);
                t.json_body(ok(res));
            });
        };
        list(&s, "new.example.com", json!([]));
        list(
            &s,
            "same.example.com",
            json!([{"id": "a", "content": "\"v=x\""}]),
        ); // CF echoes quotes
        list(
            &s,
            "old.example.com",
            json!([{"id": "b", "content": "v=old"}]),
        );
        let post = s.mock(|w, t| {
            w.method(POST)
                .path("/zones/z/dns_records")
                .body_includes(r#""name":"new.example.com""#)
                .body_includes(r#""content":"v=x""#);
            t.json_body(ok(json!({})));
        });
        let put = s.mock(|w, t| {
            w.method(PUT)
                .path("/zones/z/dns_records/b")
                .body_includes(r#""content":"v=x""#);
            t.json_body(ok(json!({})));
        });
        let recs = [
            txt("new.example.com", "v=x"),
            txt("same.example.com", "v=x"),
            txt("old.example.com", "v=x"),
        ];
        let cf = Cloudflare::with_base(&s.base_url(), "tok");
        let ch = cf.sync("z", &recs, false).await.unwrap();
        assert_eq!(
            ch.iter().map(|c| c.action).collect::<Vec<_>>(),
            [Action::Create, Action::Unchanged, Action::Update]
        );
        assert_eq!(ch[2].previous.as_deref(), Some("v=old"));
        post.assert_calls(1);
        put.assert_calls(1);
        // second run against a zone that now matches would be all Unchanged: covered by the "same" case.
    }

    #[tokio::test]
    async fn dry_run_writes_nothing_and_cname_not_proxied() {
        let s = MockServer::start();
        s.mock(|w, t| {
            w.method(GET).path("/zones/z/dns_records");
            t.json_body(ok(json!([])));
        });
        let post = s.mock(|w, t| {
            w.method(POST);
            t.json_body(ok(json!({})));
        });
        let cf = Cloudflare::with_base(&s.base_url(), "tok");
        let r = Record {
            rtype: RType::Cname,
            ..txt("k._domainkey.mail.example.com", "k.dkim.x.net")
        };
        let ch = cf.sync("z", std::slice::from_ref(&r), true).await.unwrap();
        assert_eq!(ch[0].action, Action::Create);
        post.assert_calls(0);
        assert!(render_changes(&ch, true).starts_with("would create"));
        let s = MockServer::start();
        s.mock(|w, t| {
            w.method(GET).path("/zones/z/dns_records");
            t.json_body(ok(json!([])));
        });
        let cf = Cloudflare::with_base(&s.base_url(), "tok");
        let post2 = s.mock(|w, t| {
            w.method(POST).body_includes(r#""proxied":false"#);
            t.json_body(ok(json!({})));
        });
        cf.sync("z", &[r], false).await.unwrap();
        post2.assert_calls(1);
    }

    #[tokio::test]
    async fn api_errors_surface() {
        let s = MockServer::start();
        s.mock(|w, t| { w.method(GET); t.status(403).json_body(json!({"success": false, "errors": [{"code": 9109, "message": "Invalid access token"}]})); });
        let err = Cloudflare::with_base(&s.base_url(), "bad")
            .find_zone("example.com")
            .await
            .unwrap_err();
        assert!(
            err.contains("Invalid access token") && err.contains("403"),
            "{err}"
        );
    }
}
