use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let addr = std::env::var("MAILCRAFT_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    if let Ok(url) = std::env::var("DATABASE_URL") {
        // Migrations are embedded; the container is self-contained (SPEC 19).
        let pool = sqlx::PgPool::connect(&url).await?;
        sqlx::migrate!("../../migrations").run(&pool).await?;
        tracing::info!("migrations applied");
    } else {
        tracing::warn!("DATABASE_URL not set: running without a database (scaffold mode)");
    }
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "mailcraft-server listening");
    axum::serve(listener, mailcraft_api::router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
