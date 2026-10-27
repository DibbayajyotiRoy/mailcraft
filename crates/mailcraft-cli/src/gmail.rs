//! `connect gmail`: API OAuth start -> browser -> loopback redirect -> API complete.
use crate::{client::*, Out};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};

pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pull `code`/`state`/`error` out of `GET /callback?... HTTP/1.1`.
pub fn parse_callback(req: &str) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let target = req.lines().next()?.split_whitespace().nth(1)?;
    let (path, q) = target.split_once('?')?;
    if path != "/callback" {
        return None;
    }
    let get = |k: &str| {
        q.split('&').find_map(|p| {
            p.split_once('=')
                .filter(|(a, _)| *a == k)
                .map(|(_, v)| pct_decode(v))
        })
    };
    Some((get("code"), get("state"), get("error")))
}

pub fn connect(api: &Api, timeout: u64) -> Result<Out, CliErr> {
    let l = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| CliErr::new("loopback_failed", e.to_string(), exit::FAILURE))?;
    let port = l.local_addr().unwrap().port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let start = api.post(
        "/v1/transports/gmail/oauth/start",
        &serde_json::json!({"redirect_uri": redirect}),
        None,
    )?;
    let url = start.data()["auth_url"]
        .as_str()
        .ok_or_else(|| CliErr::new("bad_response", "no auth_url from API", exit::FAILURE))?;
    eprintln!("Open this URL to authorise Gmail sending (waiting on {redirect}):\n{url}");
    l.set_nonblocking(true).ok();
    let deadline = Instant::now() + Duration::from_secs(timeout);
    loop {
        match l.accept() {
            Ok((mut s, _)) => {
                s.set_nonblocking(false).ok();
                s.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let Some((code, state, err)) = parse_callback(&String::from_utf8_lossy(&buf[..n]))
                else {
                    let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                    continue;
                };
                let page = "<h1>mailcraft</h1><p>You can close this tab.</p>";
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
                if let Some(e) = err {
                    return Err(CliErr::new(
                        "oauth_denied",
                        format!("Google returned error: {e}"),
                        exit::FAILURE,
                    ));
                }
                let (Some(code), Some(state)) = (code, state) else {
                    return Err(CliErr::new(
                        "oauth_failed",
                        "callback lacked code/state",
                        exit::FAILURE,
                    ));
                };
                let r = api.post(
                    "/v1/transports/gmail/oauth/complete",
                    &json!({"state": state, "code": code, "redirect_uri": redirect}),
                    None,
                )?;
                return Ok(Out {
                    request_id: r.body["request_id"].as_str().map(String::from),
                    data: json!({"transport": r.data(), "note": "Gmail path is for test / low volume (~500/day, From = your address)"}),
                    exit: exit::OK,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err(CliErr::new(
                        "oauth_timeout",
                        "no browser redirect received",
                        exit::RETRYABLE,
                    )
                    .hint("Re-run `mailcraft connect gmail` and open the printed URL"));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(CliErr::new("loopback_failed", e.to_string(), exit::FAILURE)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_parse() {
        let r = parse_callback("GET /callback?code=4%2Fabc&state=s1 HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        assert_eq!(r, (Some("4/abc".into()), Some("s1".into()), None));
        assert!(parse_callback("GET /favicon.ico HTTP/1.1").is_none());
    }
}
