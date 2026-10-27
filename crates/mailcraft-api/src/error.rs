//! Structured errors + the response envelope (SPEC 4.1, 4.3) and per-request ids.
use axum::{
    extract::{FromRequest, Request},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use mailcraft_core::Error;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

tokio::task_local! {
    pub static REQUEST_ID: String;
}

pub fn request_id() -> String {
    REQUEST_ID.try_with(|r| r.clone()).unwrap_or_default()
}

pub type ApiResult<T = Response> = Result<T, ApiError>;

/// Wrapper so `mailcraft_core::Error` renders as the standard envelope.
#[derive(Debug)]
pub struct ApiError(pub Error);

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        // Never leak driver text to clients.
        tracing::error!(error = %e, request_id = %request_id(), "database error");
        Self(Error::new("internal_error", 500, "internal error").retryable())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.0.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut res = (
            status,
            Json(json!({ "ok": false, "error": self.0.body(), "request_id": request_id() })),
        )
            .into_response();
        if self.0.code == "rate_limited" || self.0.code == "send_cap_exceeded" && self.0.retryable {
            res.headers_mut()
                .insert(header::RETRY_AFTER, "60".parse().unwrap());
        }
        res
    }
}

pub fn err(code: &'static str, status: u16, msg: impl Into<String>) -> ApiError {
    ApiError(Error::new(code, status, msg))
}

pub fn invalid(msg: impl Into<String>) -> ApiError {
    err("invalid_request", 400, msg)
}

pub fn not_found(what: &str) -> ApiError {
    err("not_found", 404, format!("{what} not found"))
}

pub fn forbidden_scope(scope: &str) -> ApiError {
    ApiError(
        Error::new(
            "forbidden_scope",
            403,
            format!("this key lacks the `{scope}` scope"),
        )
        .hint("use a key with the required scope; agent keys never hold `admin`"),
    )
}

pub fn envelope(status: StatusCode, data: impl Serialize) -> Response {
    (
        status,
        Json(json!({ "ok": true, "data": data, "request_id": request_id() })),
    )
        .into_response()
}

pub fn envelope_list(items: impl Serialize, next_cursor: Option<String>) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "data": items, "next_cursor": next_cursor, "request_id": request_id() })),
    )
        .into_response()
}

/// JSON body extractor whose failures use the structured error envelope.
pub struct ApiJson<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiError;
    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        match Json::<Value>::from_request(req, state).await {
            Ok(Json(v)) => serde_json::from_value(v).map(ApiJson).map_err(|e| {
                invalid(e.to_string()).hint_in("see openapi.yaml for the request schema")
            }),
            Err(e) => Err(invalid(format!("invalid JSON body: {}", e.body_text()))),
        }
    }
}

impl ApiError {
    pub fn hint_in(mut self, h: &str) -> Self {
        self.0 = self.0.hint(h);
        self
    }
    pub fn field(mut self, f: &str) -> Self {
        self.0 = self.0.field(f);
        self
    }
}

/// Optional JSON bodies: an empty body means "all defaults".
pub fn json_or_default<T: DeserializeOwned + Default>(b: &[u8]) -> Result<T, ApiError> {
    if b.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(b)
        .map_err(|e| invalid(e.to_string()).hint_in("see openapi.yaml for the request schema"))
}
