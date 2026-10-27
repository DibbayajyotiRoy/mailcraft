use anyhow::{bail, Context, Result};
use mailcraft_api::audit;

async fn connect_redis() -> Option<redis::aio::ConnectionManager> {
    let url = std::env::var("REDIS_URL").ok()?;
    match redis::Client::open(url) {
        Ok(c) => match c.get_connection_manager().await {
            Ok(m) => Some(m),
            Err(e) => {
                tracing::warn!(error = %e, "redis unavailable: caps fall back to Postgres");
                None
            }
        },
        Err(e) => {
            tracing::warn!(error = %e, "invalid REDIS_URL");
            None
        }
    }
}

/// `MAILCRAFT_SECRET_KEY`, or a key generated on first boot and kept in `$MAILCRAFT_DATA_DIR/secret.key`
/// (the compose volume), so `docker compose up -d` needs no setup. Losing the file loses every
/// encrypted transport / DKIM key; back the volume up.
fn secret_key() -> Result<String> {
    if let Some(k) = std::env::var("MAILCRAFT_SECRET_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
    {
        return Ok(k);
    }
    let dir = std::path::PathBuf::from(std::env::var("MAILCRAFT_DATA_DIR").context(
        "MAILCRAFT_SECRET_KEY (openssl rand -hex 32) or MAILCRAFT_DATA_DIR is required",
    )?);
    let file = dir.join("secret.key");
    if let Ok(k) = std::fs::read_to_string(&file) {
        return Ok(k.trim().to_string());
    }
    std::fs::create_dir_all(&dir)?;
    let k = mailcraft_core::crypto::hex(&mailcraft_core::crypto::random_bytes::<32>());
    {
        use std::io::Write;
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        o.open(&file)?.write_all(k.as_bytes())?;
    }
    tracing::warn!(file = %file.display(), "generated MAILCRAFT_SECRET_KEY on first boot; back this file up");
    Ok(k)
}

/// Container healthcheck (the image has no shell or curl): exit 0 when /readyz answers 200.
async fn healthcheck() -> Result<()> {
    let addr = std::env::var("MAILCRAFT_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let port = addr.rsplit(':').next().unwrap_or("8080");
    let r = reqwest::get(format!("http://127.0.0.1:{port}/readyz")).await?;
    if r.status().is_success() {
        Ok(())
    } else {
        bail!("readyz returned {}", r.status())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("healthcheck") {
        return healthcheck().await;
    }
    let url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let pool = sqlx::PgPool::connect(&url).await?;
    // Migrations are embedded; the container is self-contained (SPEC 19).
    sqlx::migrate!("../../migrations").run(&pool).await?;

    match args.first().map(String::as_str) {
        Some("bootstrap") => {
            let (ws, token) = mailcraft_api::bootstrap(&pool, "default").await?;
            println!("workspace: {ws}\nadmin key (shown once): {token}");
            Ok(())
        }
        Some("audit") if args.get(1).map(String::as_str) == Some("verify") => {
            let ws = match args.get(2) {
                Some(w) => w.parse()?,
                None => {
                    sqlx::query_scalar("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")
                        .fetch_one(&pool)
                        .await?
                }
            };
            let rep = audit::verify(&pool, ws)
                .await
                .map_err(|e| anyhow::anyhow!(e.0.message))?;
            println!("{}", serde_json::to_string_pretty(&rep)?);
            if !rep.ok {
                std::process::exit(7);
            }
            Ok(())
        }
        None | Some("serve") => {
            let key = secret_key()?;
            // Everything that derives from the key (config.unsub_secret, SecretBox) reads this one value.
            std::env::set_var("MAILCRAFT_SECRET_KEY", &key);
            let addr = std::env::var("MAILCRAFT_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
            mailcraft_api::wiring::serve(pool, connect_redis().await, &key, &addr).await
        }
        Some(other) => bail!(
            "unknown command `{other}` (try: serve | bootstrap | audit verify [workspace-id])"
        ),
    }
}
