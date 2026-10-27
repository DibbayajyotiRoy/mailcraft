//! Needs Postgres: MAILCRAFT_TEST_PG=postgres://postgres:x@127.0.0.1:55432/postgres (skipped when unset).
use mailcraft_llm::*;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;

#[tokio::test]
async fn atomic_cap_settle_and_isolation() {
    let url = std::env::var("MAILCRAFT_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres:x@127.0.0.1:55432/postgres".into());
    let pool = match PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect(&url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            assert!(
                std::env::var("MAILCRAFT_REQUIRE_DB").is_err(),
                "postgres required: {e}"
            );
            eprintln!("skipped: postgres unreachable ({e})");
            return;
        }
    };
    sqlx::migrate!("../../migrations").run(&pool).await.unwrap();
    let mut ws = vec![];
    for n in ["a", "b"] {
        let (id,): (uuid::Uuid,) =
            sqlx::query_as("INSERT INTO workspaces (name) VALUES ($1) RETURNING id")
                .bind(n)
                .fetch_one(&pool)
                .await
                .unwrap();
        ws.push(id.to_string());
    }
    let b = Arc::new(PgBudget::new(
        pool.clone(),
        BudgetLimits {
            max_tokens_per_day: 1000,
            max_cost_usd_per_day: 1.0,
        },
    ));

    // an estimate larger than the cap is refused even as the day's first charge
    assert!(b.reserve(&ws[0], 1001, 0.0).await.is_err());
    // concurrent reservations: exactly 10 x 100 fit in 1000, the other 10 are refused
    let mut hs = vec![];
    for _ in 0..20 {
        let (b, w) = (b.clone(), ws[0].clone());
        hs.push(tokio::spawn(async move {
            b.reserve(&w, 100, 0.01).await.is_ok()
        }));
    }
    let mut ok = 0;
    for h in hs {
        ok += h.await.unwrap() as u32;
    }
    assert_eq!(ok, 10);
    assert!(b.reserve(&ws[0], 1, 0.0).await.is_err());
    // other workspace unaffected
    b.reserve(&ws[1], 500, 0.1).await.unwrap();
    // settle refunds the difference
    b.settle(&ws[0], 100, 0.01, 40, 0.004).await;
    b.reserve(&ws[0], 60, 0.0).await.unwrap();
    assert!(b.reserve(&ws[0], 1, 0.0).await.is_err());
    // USD cap
    assert!(b.reserve(&ws[1], 1, 0.95).await.is_err());
    // non-uuid tenant fails closed
    assert!(b.reserve("t1", 1, 0.0).await.is_err());
    let (t,): (i64,) =
        sqlx::query_as("SELECT tokens FROM llm_budget_usage WHERE workspace_id = $1::uuid")
            .bind(&ws[0])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(t, 1000);
}
