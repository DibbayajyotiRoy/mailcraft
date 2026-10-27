use anyhow::{bail, Context, Result};
use mailcraft_api::{audit, AppState, Config};
use mailcraft_core::crypto::SecretBox;

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

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
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
            let key = std::env::var("MAILCRAFT_SECRET_KEY")
                .context("MAILCRAFT_SECRET_KEY is required (openssl rand -hex 32)")?;
            let secrets =
                SecretBox::from_env_value(&key).map_err(|e| anyhow::anyhow!(e.message))?;
            let st = AppState::new(pool, connect_redis().await, secrets, Config::from_env());
            tokio::spawn(mailcraft_api::run_background(st.clone()));
            let addr = std::env::var("MAILCRAFT_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
            let listener = tokio::net::TcpListener::bind(&addr).await?;
            tracing::info!(%addr, "mailcraft-server listening");
            axum::serve(listener, mailcraft_api::router(st))
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
            Ok(())
        }
        Some(other) => bail!(
            "unknown command `{other}` (try: serve | bootstrap | audit verify [workspace-id])"
        ),
    }
}
