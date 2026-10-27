//! HTTP client, config file and error/exit-code mapping (SPEC 7.2).
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};

/// Stable exit codes.
pub mod exit {
    pub const OK: u8 = 0;
    pub const FAILURE: u8 = 1;
    pub const USAGE: u8 = 2;
    pub const AUTH: u8 = 3;
    pub const POLICY: u8 = 4;
    pub const RETRYABLE: u8 = 5;
    pub const NOT_FOUND: u8 = 6;
    pub const CHECK_FAILED: u8 = 7;
}

#[derive(Debug, Clone)]
pub struct CliErr {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    pub retryable: bool,
    pub exit: u8,
}

impl CliErr {
    pub fn new(code: &str, message: impl Into<String>, exit: u8) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
            retryable: exit == exit::RETRYABLE,
            exit,
        }
    }
    pub fn hint(mut self, h: &str) -> Self {
        self.hint = Some(h.into());
        self
    }
    pub fn usage(msg: impl Into<String>) -> Self {
        Self::new("invalid_request", msg, exit::USAGE)
    }
    pub fn to_json(&self) -> Value {
        json!({"code": self.code, "message": self.message, "hint": self.hint, "retryable": self.retryable})
    }
}

/// Map an API error (status + stable code) to an exit code.
pub fn exit_for(status: u16, code: &str) -> u8 {
    match code {
        "pending_approval"
        | "blocked_by_policy"
        | "recipient_not_allowed"
        | "send_cap_exceeded"
        | "kill_switch_active"
        | "test_key_live_recipient"
        | "domain_not_verified"
        | "recipient_suppressed" => return exit::POLICY,
        "unauthenticated" | "forbidden_scope" => return exit::AUTH,
        "not_found" => return exit::NOT_FOUND,
        "rate_limited" | "llm_unavailable" => return exit::RETRYABLE,
        "invalid_request" => return exit::USAGE,
        _ => {}
    }
    match status {
        401 | 403 => exit::AUTH,
        404 => exit::NOT_FOUND,
        429 | 502..=504 => exit::RETRYABLE,
        _ => exit::FAILURE,
    }
}

#[derive(Default, Clone)]
pub struct Config {
    pub base_url: Option<String>,
    /// Key of the selected profile (env `MAILCRAFT_API_KEY` wins on load).
    pub api_key: Option<String>,
    /// Selected profile name (`default` unless `--profile` / `MAILCRAFT_PROFILE`).
    pub profile: String,
}

pub fn config_path() -> PathBuf {
    let dir = std::env::var_os("MAILCRAFT_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(|p| PathBuf::from(p).join("mailcraft"))
                .or_else(|| {
                    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/mailcraft"))
                })
                .unwrap_or_else(|| PathBuf::from(".mailcraft"))
        });
    dir.join("config.json")
}

fn read_file_json() -> Value {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

impl Config {
    /// File shape: `{"base_url", "profiles": {"default": key, "admin": key}}`. A legacy top-level
    /// `api_key` still reads as the `default` profile.
    pub fn load(profile: Option<&str>) -> Config {
        let file = read_file_json();
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let profile = profile
            .map(String::from)
            .or_else(|| env("MAILCRAFT_PROFILE"))
            .unwrap_or_else(|| "default".into());
        let from_file = file["profiles"][profile.as_str()]
            .as_str()
            .or_else(|| {
                (profile == "default")
                    .then(|| file["api_key"].as_str())
                    .flatten()
            })
            .map(String::from);
        Config {
            base_url: env("MAILCRAFT_API_URL").or(file["base_url"].as_str().map(String::from)),
            api_key: env("MAILCRAFT_API_KEY").or(from_file),
            profile,
        }
    }

    /// Write base URL + `extra` profiles + the selected profile's key, keeping other profiles in
    /// the file; mode 0600 on unix.
    pub fn save(&self, extra: &[(&str, &str)]) -> Result<PathBuf, CliErr> {
        let p = config_path();
        let io =
            |e: std::io::Error| CliErr::new("config_write_failed", e.to_string(), exit::FAILURE);
        fs::create_dir_all(p.parent().unwrap()).map_err(io)?;
        let mut profiles = read_file_json()["profiles"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        if let Some(k) = &self.api_key {
            profiles.insert(self.profile.clone(), json!(k));
        }
        for (n, k) in extra {
            profiles.insert((*n).into(), json!(k));
        }
        let body =
            serde_json::to_string_pretty(&json!({"base_url": self.base_url, "profiles": profiles}))
                .unwrap();
        #[cfg(unix)]
        {
            use std::{io::Write, os::unix::fs::OpenOptionsExt, os::unix::fs::PermissionsExt};
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&p)
                .map_err(io)?;
            f.write_all(body.as_bytes()).map_err(io)?;
            // an existing file keeps its old mode through open(); force it
            fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).map_err(io)?;
        }
        #[cfg(not(unix))]
        fs::write(&p, body).map_err(io)?;
        Ok(p)
    }
}

pub struct Response {
    pub body: Value,
}

impl Response {
    pub fn data(&self) -> &Value {
        &self.body["data"]
    }
}

pub struct Api {
    pub base: String,
    key: Option<String>,
    http: reqwest::blocking::Client,
}

impl Api {
    pub fn new(base: &str, key: Option<String>) -> Self {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client");
        Api {
            base: base.trim_end_matches('/').to_string(),
            key,
            http,
        }
    }

    pub fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        idem: Option<&str>,
    ) -> Result<Response, CliErr> {
        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut rb = self.http.request(m, format!("{}{}", self.base, path));
        if let Some(k) = &self.key {
            rb = rb.bearer_auth(k);
        }
        if let Some(i) = idem {
            rb = rb.header("Idempotency-Key", i);
        }
        if let Some(b) = body {
            rb = rb.json(b);
        }
        let resp = rb.send().map_err(|e| {
            CliErr::new(
                "api_unreachable",
                format!("cannot reach {}: {e}", self.base),
                exit::RETRYABLE,
            )
            .hint("Is the server up? `docker compose up -d`, or pass --url / set MAILCRAFT_API_URL")
        })?;
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if (200..300).contains(&status) && body["ok"] != json!(false) {
            return Ok(Response { body });
        }
        let e = &body["error"];
        let code = e["code"].as_str().unwrap_or(if status == 501 {
            "not_implemented"
        } else {
            "http_error"
        });
        let msg = e["message"].as_str().map(String::from).unwrap_or_else(|| {
            format!(
                "HTTP {status}: {}",
                text.chars().take(200).collect::<String>()
            )
        });
        let mut err = CliErr::new(code, msg, exit_for(status, code));
        err.hint = e["hint"].as_str().map(String::from);
        err.retryable = e["retryable"]
            .as_bool()
            .unwrap_or(err.exit == exit::RETRYABLE);
        Err(err)
    }

    pub fn get(&self, path: &str) -> Result<Response, CliErr> {
        self.call("GET", path, None, None)
    }
    pub fn post(&self, path: &str, body: &Value, idem: Option<&str>) -> Result<Response, CliErr> {
        self.call("POST", path, Some(body), idem)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exit_mapping() {
        assert_eq!(exit_for(403, "forbidden_scope"), 3);
        assert_eq!(exit_for(202, "pending_approval"), 4);
        assert_eq!(exit_for(404, "x"), 6);
        assert_eq!(exit_for(429, "rate_limited"), 5);
        assert_eq!(exit_for(503, "x"), 5);
        assert_eq!(exit_for(501, "not_implemented"), 1);
        assert_eq!(exit_for(400, "invalid_request"), 2);
    }
}
