//! axum HTTP API. `openapi.yaml` (repo root) is the single source of truth; routes here
//! must match it (CI diff check, SPEC section 7.6).
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use mailcraft_core::Error;
use serde_json::json;

const OPENAPI: &str = include_str!("../../../openapi.yaml");

/// Wrapper so `mailcraft_core::Error` renders as the standard envelope.
pub struct ApiError(pub Error);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.0.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(json!({ "ok": false, "error": self.0.body() }))).into_response()
    }
}

pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(|| async { Json(json!({ "ok": true })) }))
        .route(
            "/openapi.yaml",
            get(|| async { ([(header::CONTENT_TYPE, "application/yaml")], OPENAPI) }),
        )
        .route(
            "/v1/emails",
            post(|| async { ApiError(Error::not_implemented("POST /v1/emails")) }),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn call(method: &str, uri: &str) -> (StatusCode, serde_json::Value) {
        let res = router()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    #[tokio::test]
    async fn health_is_ok() {
        let (s, b) = call("GET", "/healthz").await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(b["ok"], true);
    }

    #[tokio::test]
    async fn unimplemented_route_returns_structured_error() {
        let (s, b) = call("POST", "/v1/emails").await;
        assert_eq!(s, StatusCode::NOT_IMPLEMENTED);
        assert_eq!(b["error"]["code"], "not_implemented");
        assert!(b["error"]["hint"].is_string());
    }
}
