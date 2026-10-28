//! Minimal inbound SMTP receiver for the bounce (VERP) and mailto-unsubscribe addresses.
//! Accepts only local, verified recipients (never relays); no STARTTLS. Hand-rolled because the
//! SMTP-server crates are sync/stale and RCPT needs an async DB lookup. Enabled by
//! `MAILCRAFT_INBOUND_SMTP_BIND`. See docs/inbound.md.
use std::{sync::Arc, time::Duration};

use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
    time::timeout,
};

use crate::{ingest, ingest::Rcpt, state::AppState};

const LINE_MAX: u64 = 8192;
const IDLE: Duration = Duration::from_secs(60);
const DATA_MAX_TIME: Duration = Duration::from_secs(300);
const MAX_RCPT: usize = 20;
const MAX_CONN: usize = 64;

pub async fn serve(
    st: AppState,
    l: TcpListener,
    max_bytes: usize,
    mut stop: watch::Receiver<bool>,
) {
    let slots = Arc::new(Semaphore::new(MAX_CONN));
    loop {
        let (sock, _) = tokio::select! {
            r = l.accept() => match r { Ok(x) => x, Err(_) => continue },
            _ = stop.changed() => return,
        };
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            continue;
        }; // full: drop, sender retries
        let st = st.clone();
        tokio::spawn(async move {
            let _ = session(st, sock, max_bytes).await;
            drop(permit);
        });
    }
}

async fn say(w: &mut (impl AsyncWrite + Unpin), s: &str) -> std::io::Result<()> {
    w.write_all(format!("{s}\r\n").as_bytes()).await
}

/// Next line (CRLF kept) or `None` on EOF / timeout / over-long line.
async fn line(r: &mut (impl AsyncBufReadExt + Unpin), buf: &mut Vec<u8>) -> Option<()> {
    buf.clear();
    let n = timeout(IDLE, r.take(LINE_MAX).read_until(b'\n', buf))
        .await
        .ok()?
        .ok()?;
    (n > 0 && buf.ends_with(b"\n")).then_some(())
}

/// `<addr>` from `TO:<addr> PARAMS`.
fn angle(arg: &str) -> &str {
    let a = arg.split_once(':').map_or("", |x| x.1).trim();
    a.strip_prefix('<')
        .and_then(|a| a.split_once('>'))
        .map_or(a, |x| x.0)
}

async fn session(st: AppState, sock: TcpStream, max_bytes: usize) -> std::io::Result<()> {
    let (r, mut w) = sock.into_split();
    let mut r = BufReader::new(r);
    say(&mut w, "220 mailcraft ESMTP").await?;
    let (mut from_seen, mut rcpts, mut buf) = (false, Vec::<Rcpt>::new(), Vec::new());
    while line(&mut r, &mut buf).await.is_some() {
        let s = String::from_utf8_lossy(&buf).trim().to_string();
        let (verb, arg) = s.split_once(' ').unwrap_or((&s, ""));
        match verb.to_ascii_uppercase().as_str() {
            "HELO" => say(&mut w, "250 mailcraft").await?,
            "EHLO" => {
                say(
                    &mut w,
                    &format!("250-mailcraft\r\n250-SIZE {max_bytes}\r\n250 8BITMIME"),
                )
                .await?
            }
            "MAIL" if arg.to_ascii_uppercase().starts_with("FROM:") => {
                (from_seen, rcpts) = (true, Vec::new());
                say(&mut w, "250 2.1.0 ok").await?
            }
            "RCPT" if !from_seen => say(&mut w, "503 5.5.1 MAIL first").await?,
            "RCPT" if rcpts.len() >= MAX_RCPT => {
                say(&mut w, "452 4.5.3 too many recipients").await?
            }
            "RCPT" if arg.to_ascii_uppercase().starts_with("TO:") => {
                match ingest::classify_rcpt(&st, angle(arg)).await {
                    Ok(Some(x)) => {
                        rcpts.push(x);
                        say(&mut w, "250 2.1.5 ok").await?
                    }
                    Ok(None) => say(&mut w, "550 5.1.1 no such mailbox").await?,
                    Err(e) => {
                        tracing::error!(error = %e, "inbound rcpt lookup");
                        say(&mut w, "451 4.3.0 try again later").await?
                    }
                }
            }
            "DATA" if rcpts.is_empty() => say(&mut w, "503 5.5.1 RCPT first").await?,
            "DATA" => {
                say(&mut w, "354 end with <CRLF>.<CRLF>").await?;
                let Some(raw) = data(&mut r, max_bytes).await else {
                    say(&mut w, "552 5.3.4 message too large or timed out").await?;
                    return Ok(());
                };
                let mut ok = true;
                for x in std::mem::take(&mut rcpts) {
                    let res = match x {
                        Rcpt::Bounce(id) => ingest::from_raw(&st, &raw, Some(id)).await.map(drop),
                        Rcpt::Unsub(a) => ingest::mailto_unsubscribe(&st, &a).await,
                    };
                    if let Err(e) = res {
                        tracing::error!(error = %e, "inbound processing");
                        ok = false;
                    }
                }
                from_seen = false;
                // Unparseable / unmappable mail is accepted and dropped (no backscatter); only a DB error asks for a retry.
                say(
                    &mut w,
                    if ok {
                        "250 2.0.0 accepted"
                    } else {
                        "451 4.3.0 try again later"
                    },
                )
                .await?
            }
            "RSET" => {
                (from_seen, rcpts) = (false, Vec::new());
                say(&mut w, "250 2.0.0 ok").await?
            }
            "NOOP" => say(&mut w, "250 2.0.0 ok").await?,
            "QUIT" => return say(&mut w, "221 2.0.0 bye").await,
            _ => say(&mut w, "502 5.5.1 not implemented").await?,
        }
    }
    Ok(())
}

/// Dot-unstuffed body up to the terminating `.`; `None` when over `max` or too slow.
async fn data(r: &mut (impl AsyncBufReadExt + Unpin), max: usize) -> Option<Vec<u8>> {
    timeout(DATA_MAX_TIME, async {
        let (mut out, mut buf) = (Vec::new(), Vec::new());
        loop {
            line(r, &mut buf).await?;
            if buf == b".\r\n" || buf == b".\n" {
                return Some(out);
            }
            out.extend_from_slice(buf.strip_prefix(b".").unwrap_or(&buf));
            if out.len() > max {
                return None;
            }
        }
    })
    .await
    .ok()
    .flatten()
}
