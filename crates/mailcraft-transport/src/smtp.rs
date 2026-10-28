use crate::{ClassifiedTransport, Outbound, SendReceipt, TransportError};
use lettre::{
    address::Envelope,
    transport::smtp::{authentication::Credentials, client::Tls},
    Address, AsyncSmtpTransport, AsyncTransport, Tokio1Executor,
};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    /// Plaintext. Test sinks only; never expose to users as a production choice.
    None,
    /// Connect plain, upgrade with STARTTLS (587/2525/25), fail if the server does not offer it.
    StartTls,
    /// TLS from the first byte (465).
    Implicit,
}

#[derive(Debug, Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub tls: TlsMode,
    pub username: Option<String>,
    pub password: Option<String>,
    pub timeout: Duration,
    /// Mailbox relays (Zoho, Gmail/Workspace SMTP, Outlook) only accept the signed-in address
    /// as MAIL FROM, so send with `username` as the envelope sender instead of the VERP
    /// return path. Bounces then land in that mailbox rather than in mailcraft.
    pub mailbox_sender: bool,
}

/// Verified (V) against provider docs on 2026-10-27, or (M) from memory: check before shipping.
/// name, host template (`{region}` for SES), port, tls, username rule.
pub const PRESETS: &[(&str, &str, u16, TlsMode, &str)] = &[
    // (V) smtp.postmarkapp.com 25/2525/587 STARTTLS; user=Server API token or SMTP access key, pass=token/secret key
    (
        "postmark",
        "smtp.postmarkapp.com",
        587,
        TlsMode::StartTls,
        "server API token (user and password)",
    ),
    // (V) smtp.mailgun.org 587 STARTTLS, 465 implicit; per-domain SMTP credentials (postmaster@domain)
    (
        "mailgun",
        "smtp.mailgun.org",
        587,
        TlsMode::StartTls,
        "per-domain SMTP credential",
    ),
    // (V) smtp.resend.com user "resend", pass = API key; 465/2465 implicit, 587/2587 STARTTLS
    (
        "resend",
        "smtp.resend.com",
        465,
        TlsMode::Implicit,
        "user `resend`, password = API key",
    ),
    // (M) smtp-relay.brevo.com 587 STARTTLS; user = account login, pass = SMTP key (not API key)
    (
        "brevo",
        "smtp-relay.brevo.com",
        587,
        TlsMode::StartTls,
        "account login + SMTP key",
    ),
    // (M) mail.smtp2go.com 587/2525 STARTTLS, 465 implicit; per-user SMTP credentials
    (
        "smtp2go",
        "mail.smtp2go.com",
        587,
        TlsMode::StartTls,
        "SMTP user created in dashboard",
    ),
    // (V) 25/587/2587 STARTTLS, 465/2465 implicit; host (M) email-smtp.<region>.amazonaws.com;
    // credentials are SMTP-specific, derived from IAM secret, not the access key itself
    (
        "ses",
        "email-smtp.{region}.amazonaws.com",
        587,
        TlsMode::StartTls,
        "IAM-derived SMTP credentials",
    ),
];

impl SmtpConfig {
    /// `region` is only used by the `ses` preset.
    pub fn from_preset(
        name: &str,
        username: &str,
        password: &str,
        region: Option<&str>,
    ) -> Option<Self> {
        let (_, host, port, tls, _) = PRESETS.iter().find(|p| p.0 == name)?;
        let host = host.replace("{region}", region.unwrap_or("us-east-1"));
        Some(Self {
            host,
            port: *port,
            tls: *tls,
            username: Some(username.into()),
            password: Some(password.into()),
            timeout: Duration::from_secs(30),
            mailbox_sender: false,
        })
    }
}

pub struct SmtpRelay {
    mailer: AsyncSmtpTransport<Tokio1Executor>,
    envelope_from: Option<String>,
}

impl SmtpRelay {
    pub fn new(cfg: &SmtpConfig) -> Result<Self, TransportError> {
        let b = match cfg.tls {
            TlsMode::None => Ok(
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host).tls(Tls::None),
            ),
            TlsMode::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host),
            TlsMode::Implicit => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host),
        }
        .map_err(|e| TransportError::Permanent(format!("smtp config: {e}")))?;
        let mut b = b.port(cfg.port).timeout(Some(cfg.timeout));
        if let (Some(u), Some(p)) = (&cfg.username, &cfg.password) {
            b = b.credentials(Credentials::new(u.clone(), p.clone()));
        }
        Ok(Self {
            mailer: b.build(),
            envelope_from: cfg.username.clone().filter(|_| cfg.mailbox_sender),
        })
    }
}

/// Map an SMTP reply code (+ optional text, which may carry an enhanced status like `4.7.0`) to a class.
/// Pure so it is table-tested.
pub fn classify_smtp(code: u16, text: &str) -> TransportError {
    let msg = format!("{code} {text}");
    let enhanced_47 = text.contains("4.7.") || text.contains("5.7.1") && code == 450; // throttling / policy deferrals
    let lower = text.to_ascii_lowercase();
    match code {
        530 | 534 | 535 | 538 => TransportError::Auth(msg),
        // 421 + 4.7.x is Gmail/Outlook style "too many / rate limited" deferral.
        421 | 450 | 451 | 452 | 454
            if enhanced_47 || lower.contains("rate") || lower.contains("too many") =>
        {
            TransportError::RateLimited {
                msg,
                retry_after: None,
            }
        }
        452 if lower.contains("quota") => TransportError::RateLimited {
            msg,
            retry_after: None,
        },
        400..=499 => TransportError::Temporary(msg),
        500..=599 => TransportError::Permanent(msg),
        _ => TransportError::Temporary(msg),
    }
}

fn classify_lettre(e: lettre::transport::smtp::Error) -> TransportError {
    if let Some(code) = e.status() {
        let n = (code.severity as u16) * 100 + (code.category as u16) * 10 + code.detail as u16;
        return classify_smtp(n, &e.to_string());
    }
    // No SMTP reply: connection/TLS/IO problem. Retry.
    TransportError::Temporary(format!("smtp: {e}"))
}

crate::impl_transport!(SmtpRelay, "smtp-relay");

#[async_trait::async_trait]
impl ClassifiedTransport for SmtpRelay {
    async fn submit_all(
        &self,
        msg: &Outbound,
        rcpts: &[String],
    ) -> Result<SendReceipt, TransportError> {
        let parse = |s: &str| {
            s.parse::<Address>()
                .map_err(|e| TransportError::Permanent(format!("bad address {s}: {e}")))
        };
        let env = Envelope::new(
            Some(parse(
                self.envelope_from.as_deref().unwrap_or(&msg.mail_from),
            )?),
            rcpts
                .iter()
                .map(|r| parse(r))
                .collect::<Result<Vec<_>, _>>()?,
        )
        .map_err(|e| TransportError::Permanent(format!("envelope: {e}")))?;
        let resp = self
            .mailer
            .send_raw(&env, &msg.raw)
            .await
            .map_err(classify_lettre)?;
        let text = resp.message().collect::<Vec<_>>().join(" ");
        Ok(SendReceipt {
            provider_message_id: if text.is_empty() { None } else { Some(text) },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{sample, ErrorClass::*};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    #[test]
    fn error_class_table() {
        for (code, text, want) in [
            (535, "5.7.8 bad credentials", Auth),
            (534, "5.7.9 app password required", Auth),
            (421, "4.7.0 too many connections", RateLimited),
            (450, "4.7.1 greylisted", RateLimited),
            (451, "4.3.0 local error", Temporary),
            (452, "4.2.2 mailbox full", Temporary),
            (550, "5.1.1 no such user", Permanent),
            (554, "5.7.1 spam", Permanent),
        ] {
            assert_eq!(classify_smtp(code, text).class(), want, "{code} {text}");
        }
    }

    #[test]
    fn presets_resolve() {
        let c = SmtpConfig::from_preset("ses", "u", "p", Some("eu-west-1")).unwrap();
        assert_eq!(c.host, "email-smtp.eu-west-1.amazonaws.com");
        assert_eq!((c.port, c.tls), (587, TlsMode::StartTls));
        assert_eq!(
            SmtpConfig::from_preset("resend", "resend", "k", None)
                .unwrap()
                .tls,
            TlsMode::Implicit
        );
        assert!(SmtpConfig::from_preset("nope", "", "", None).is_none());
        for p in PRESETS {
            assert!(SmtpConfig::from_preset(p.0, "u", "p", None).is_some());
        }
    }

    /// Tiny in-process SMTP sink. `reject` makes RCPT fail with the given line.
    async fn sink(
        reject_rcpt: Option<&'static str>,
    ) -> (u16, tokio::task::JoinHandle<(Vec<String>, String)>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let (r, mut w) = s.into_split();
            let mut r = BufReader::new(r);
            w.write_all(b"220 sink ESMTP\r\n").await.unwrap();
            let (mut cmds, mut data, mut line) = (vec![], String::new(), String::new());
            loop {
                line.clear();
                if r.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let up = line.trim_end().to_ascii_uppercase();
                cmds.push(line.trim_end().to_string());
                if up.starts_with("EHLO") {
                    w.write_all(b"250-sink\r\n250 AUTH PLAIN LOGIN\r\n")
                        .await
                        .unwrap();
                } else if up.starts_with("AUTH") {
                    w.write_all(b"235 2.7.0 ok\r\n").await.unwrap();
                } else if let (true, Some(rej)) = (up.starts_with("RCPT"), reject_rcpt) {
                    w.write_all(format!("{rej}\r\n").as_bytes()).await.unwrap();
                } else if up == "DATA" {
                    w.write_all(b"354 go\r\n").await.unwrap();
                    loop {
                        line.clear();
                        r.read_line(&mut line).await.unwrap();
                        if line == ".\r\n" {
                            break;
                        }
                        data.push_str(&line);
                    }
                    w.write_all(b"250 2.0.0 Ok: queued as SINK123\r\n")
                        .await
                        .unwrap();
                } else if up == "QUIT" {
                    w.write_all(b"221 bye\r\n").await.unwrap();
                    break;
                } else {
                    w.write_all(b"250 ok\r\n").await.unwrap();
                }
            }
            (cmds, data)
        });
        (port, h)
    }

    fn cfg(port: u16) -> SmtpConfig {
        SmtpConfig {
            host: "127.0.0.1".into(),
            port,
            tls: TlsMode::None,
            username: Some("u".into()),
            password: Some("p".into()),
            timeout: Duration::from_secs(5),
            mailbox_sender: false,
        }
    }

    #[tokio::test]
    async fn mailbox_sender_uses_the_login_as_envelope_from() {
        let (port, h) = sink(None).await;
        let t = SmtpRelay::new(&SmtpConfig {
            username: Some("dev@example.com".into()),
            mailbox_sender: true,
            ..cfg(port)
        })
        .unwrap();
        t.submit(&sample()).await.unwrap();
        let (cmds, _) = h.await.unwrap();
        assert!(
            cmds.contains(&"MAIL FROM:<dev@example.com>".to_string()),
            "{cmds:?}"
        );
    }

    #[tokio::test]
    async fn sends_message_to_plaintext_sink() {
        let (port, h) = sink(None).await;
        let t = SmtpRelay::new(&cfg(port)).unwrap();
        let rc = t.submit(&sample()).await.unwrap();
        assert!(rc
            .provider_message_id
            .unwrap()
            .contains("queued as SINK123"));
        let (cmds, data) = h.await.unwrap();
        assert!(cmds.iter().any(|c| c.starts_with("AUTH")));
        // envelope comes from Outbound (VERP return path), not from the headers
        assert!(
            cmds.contains(&"MAIL FROM:<bounce+abc@bounce.example.com>".to_string()),
            "{cmds:?}"
        );
        assert!(cmds.contains(&"RCPT TO:<bob@example.org>".to_string()));
        assert!(data.contains("Subject: Hello") && data.contains("plain body"));
        assert!(data.contains("List-Unsubscribe-Post: List-Unsubscribe=One-Click"));
    }

    #[tokio::test]
    async fn every_envelope_recipient_gets_a_rcpt_and_bcc_stays_out_of_headers() {
        let (port, h) = sink(None).await;
        let t = SmtpRelay::new(&cfg(port)).unwrap();
        let rcpts = [
            "bob@example.org",
            "cc@example.org",
            "hidden-bcc@example.net",
        ]
        .map(String::from);
        t.submit_all(&sample(), &rcpts).await.unwrap();
        let (cmds, data) = h.await.unwrap();
        for r in &rcpts {
            assert!(
                cmds.contains(&format!("RCPT TO:<{r}>")),
                "{r} missing: {cmds:?}"
            );
        }
        assert!(!data.contains("hidden-bcc@example.net") && !data.contains("Bcc:"));
    }

    #[tokio::test]
    async fn rcpt_rejection_is_permanent() {
        let (port, _h) = sink(Some("550 5.1.1 no such user")).await;
        let t = SmtpRelay::new(&cfg(port)).unwrap();
        assert_eq!(t.submit(&sample()).await.unwrap_err().class(), Permanent);
    }

    #[tokio::test]
    async fn connection_refused_is_temporary() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let t = SmtpRelay::new(&cfg(port)).unwrap();
        assert_eq!(t.submit(&sample()).await.unwrap_err().class(), Temporary);
    }
}
