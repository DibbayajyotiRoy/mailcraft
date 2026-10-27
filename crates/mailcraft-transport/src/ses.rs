//! SES v2 `SendEmail` with `Content.Raw`, signed with a minimal SigV4.
//! Chosen over `aws-sdk-sesv2`: we call exactly one operation, the SDK drags in ~100+ transitive crates
//! (aws-config, smithy runtime, its own HTTP stack) and a second TLS/HTTP client next to reqwest.
//! SigV4 for one POST is ~60 lines on `hmac`+`sha2`. Ceiling: no credential-provider chain
//! (IMDS/SSO/profile); the operator supplies keys. Upgrade to the SDK if that chain is wanted.
use crate::{error::retry_after, ClassifiedTransport, Outbound, SendReceipt, TransportError};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct SesCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

pub struct SesV2 {
    http: reqwest::Client,
    creds: SesCredentials,
    region: String,
    endpoint: String,
    configuration_set: Option<String>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).unwrap();
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k = hmac(format!("AWS4{secret}").as_bytes(), date);
    let k = hmac(&k, region);
    let k = hmac(&k, service);
    hmac(&k, "aws4_request")
}

/// `amz_date` = `YYYYMMDDTHHMMSSZ`.
pub fn amz_date(unix: i64) -> String {
    let t = time::OffsetDateTime::from_unix_timestamp(unix).unwrap();
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        t.year(),
        t.month() as u8,
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

/// Returns the `Authorization` header value. Signed headers: content-type, host, x-amz-date[, x-amz-security-token].
pub fn authorization(
    c: &SesCredentials,
    region: &str,
    host: &str,
    path: &str,
    amz_date: &str,
    body: &[u8],
) -> String {
    let date = &amz_date[..8];
    let mut hdrs = vec![
        ("content-type", "application/json".to_string()),
        ("host", host.to_string()),
        ("x-amz-date", amz_date.to_string()),
    ];
    if let Some(t) = &c.session_token {
        hdrs.push(("x-amz-security-token", t.clone()));
    }
    let canon_hdrs: String = hdrs.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed = hdrs.iter().map(|h| h.0).collect::<Vec<_>>().join(";");
    let canon = format!(
        "POST\n{path}\n\n{canon_hdrs}\n{signed}\n{}",
        hex(&Sha256::digest(body))
    );
    let scope = format!("{date}/{region}/ses/aws4_request");
    let sts = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex(&Sha256::digest(canon.as_bytes()))
    );
    let sig = hex(&hmac(
        &signing_key(&c.secret_access_key, date, region, "ses"),
        &sts,
    ));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={sig}",
        c.access_key_id
    )
}

impl SesV2 {
    pub fn new(creds: SesCredentials, region: &str) -> Self {
        Self::with_endpoint(
            creds,
            region,
            &format!("https://email.{region}.amazonaws.com"),
        )
    }
    pub fn with_endpoint(creds: SesCredentials, region: &str, endpoint: &str) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            creds,
            region: region.into(),
            endpoint: endpoint.trim_end_matches('/').into(),
            configuration_set: None,
        }
    }
    pub fn configuration_set(mut self, name: &str) -> Self {
        self.configuration_set = Some(name.into());
        self
    }
}

/// SES v2 error mapping. Type comes from `x-amzn-ErrorType` (may look like `Foo:http://...` or `ns#Foo`)
/// or the body `__type`/`message`.
pub fn classify_ses_error(
    status: u16,
    error_type: &str,
    retry: Option<Duration>,
    body: &str,
) -> TransportError {
    let ty = error_type
        .split(':')
        .next()
        .unwrap_or("")
        .rsplit('#')
        .next()
        .unwrap_or("");
    let msg = format!("ses {status} {ty}: {body}");
    match ty {
        "TooManyRequestsException"
        | "LimitExceededException"
        | "Throttling"
        | "ThrottlingException" => TransportError::RateLimited {
            msg,
            retry_after: retry,
        },
        "UnrecognizedClientException"
        | "InvalidSignatureException"
        | "ExpiredTokenException"
        | "AccessDeniedException"
        | "InvalidClientTokenId"
        | "MissingAuthenticationToken"
        | "SignatureDoesNotMatch" => TransportError::Auth(msg),
        // Account-level conditions: nothing this message can do about it; operator must fix. Auth class pauses the transport.
        "AccountSuspendedException" | "SendingPausedException" => TransportError::Auth(msg),
        "MessageRejected"
        | "MailFromDomainNotVerifiedException"
        | "BadRequestException"
        | "NotFoundException" => TransportError::Permanent(msg),
        _ => match status {
            429 => TransportError::RateLimited {
                msg,
                retry_after: retry,
            },
            401 | 403 => TransportError::Auth(msg),
            500..=599 => TransportError::Temporary(msg),
            _ => TransportError::Permanent(msg),
        },
    }
}

crate::impl_transport!(SesV2, "ses");

#[async_trait::async_trait]
impl ClassifiedTransport for SesV2 {
    async fn submit(&self, msg: &Outbound) -> Result<SendReceipt, TransportError> {
        // One row per recipient: the envelope is exactly `rcpt_to`.
        let mut j = serde_json::json!({
            "Content": { "Raw": { "Data": STANDARD.encode(&msg.raw) } },
            "Destination": { "ToAddresses": [&msg.rcpt_to] },
        });
        if let Some(c) = &self.configuration_set {
            j["ConfigurationSetName"] = c.clone().into();
        }
        let body = serde_json::to_vec(&j).unwrap();
        let url = reqwest::Url::parse(&format!("{}/v2/email/outbound-emails", self.endpoint))
            .map_err(|e| TransportError::Permanent(format!("bad endpoint: {e}")))?;
        let host = match url.port() {
            Some(p) => format!("{}:{p}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_string(),
        };
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let date = amz_date(now);
        let auth = authorization(&self.creds, &self.region, &host, url.path(), &date, &body);

        let mut req = self
            .http
            .post(url)
            .header("content-type", "application/json")
            .header("x-amz-date", &date)
            .header("authorization", auth);
        if let Some(t) = &self.creds.session_token {
            req = req.header("x-amz-security-token", t);
        }
        let r = req.body(body).send().await?;
        let status = r.status().as_u16();
        if r.status().is_success() {
            let v: serde_json::Value = r.json().await?;
            return Ok(SendReceipt {
                provider_message_id: v["MessageId"].as_str().map(str::to_owned),
            });
        }
        let ra = retry_after(r.headers());
        let et = r
            .headers()
            .get("x-amzn-errortype")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = r.text().await.unwrap_or_default();
        let et = if et.is_empty() {
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["__type"].as_str().map(str::to_owned))
                .unwrap_or_default()
        } else {
            et
        };
        Err(classify_ses_error(status, &et, ra, &text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{sample, ErrorClass::*};
    use wiremock::{matchers::*, Mock, MockServer, ResponseTemplate};

    #[test]
    fn signing_key_matches_aws_documented_example() {
        // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html (derived-key example)
        let k = signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20150830",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            hex(&k),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }

    #[test]
    fn amz_date_format() {
        assert_eq!(amz_date(1_440_892_800), "20150830T000000Z");
    }

    fn ses(s: &MockServer) -> SesV2 {
        SesV2::with_endpoint(
            SesCredentials {
                access_key_id: "AKIDEXAMPLE".into(),
                secret_access_key: "sek".into(),
                session_token: Some("tok".into()),
            },
            "eu-west-1",
            &s.uri(),
        )
    }

    #[tokio::test]
    async fn sends_raw_signed_and_returns_message_id() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/email/outbound-emails"))
            .and(header_exists("x-amz-date"))
            .and(header("x-amz-security-token", "tok"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"MessageId":"0100abc"})),
            )
            .expect(1)
            .mount(&s)
            .await;
        let rc = ses(&s).submit(&sample()).await.unwrap();
        assert_eq!(rc.provider_message_id.as_deref(), Some("0100abc"));

        let req = &s.received_requests().await.unwrap()[0];
        let a = req
            .headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            a.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"),
            "{a}"
        );
        assert!(a.contains("/eu-west-1/ses/aws4_request"));
        assert!(a.contains("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token"));
        // Re-sign independently from what the server saw: must match byte for byte.
        let d = req.headers.get("x-amz-date").unwrap().to_str().unwrap();
        let host = req
            .headers
            .get("host")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let creds = SesCredentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "sek".into(),
            session_token: Some("tok".into()),
        };
        assert_eq!(
            a,
            authorization(
                &creds,
                "eu-west-1",
                &host,
                "/v2/email/outbound-emails",
                d,
                &req.body
            )
        );

        let v: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        let raw = String::from_utf8(
            STANDARD
                .decode(v["Content"]["Raw"]["Data"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(raw.contains("List-Unsubscribe:"));
        assert_eq!(v["Destination"]["ToAddresses"][0], "bob@example.org");
    }

    #[tokio::test]
    async fn error_types_map_from_header() {
        for (status, ty, want) in [
            (400, "MessageRejected", Permanent),
            (400, "MailFromDomainNotVerifiedException", Permanent),
            (429, "TooManyRequestsException", RateLimited),
            (400, "LimitExceededException", RateLimited),
            (403, "UnrecognizedClientException", Auth),
            (400, "AccountSuspendedException", Auth),
            (500, "InternalFailure", Temporary),
        ] {
            let s = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(
                    ResponseTemplate::new(status)
                        .insert_header(
                            "x-amzn-ErrorType",
                            format!("{ty}:http://internal.amazon.com/coral/").as_str(),
                        )
                        .set_body_json(serde_json::json!({"message":"m"})),
                )
                .mount(&s)
                .await;
            assert_eq!(
                ses(&s).submit(&sample()).await.unwrap_err().class(),
                want,
                "{ty}"
            );
        }
    }

    #[test]
    fn untyped_status_fallbacks() {
        assert_eq!(classify_ses_error(503, "", None, "").class(), Temporary);
        assert_eq!(classify_ses_error(403, "", None, "").class(), Auth);
        assert_eq!(classify_ses_error(404, "", None, "").class(), Permanent);
    }
}
