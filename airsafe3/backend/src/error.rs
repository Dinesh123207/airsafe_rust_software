use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

/// API error. The body is always `{"detail": ...}`, the shape the web app, firmware and tools already read.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: Value,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self { status, detail: Value::String(msg.into()) }
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, msg)
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, msg)
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, msg)
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, msg)
    }
    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    }
    /// 422 with a list of `{loc, msg, type}` entries (same shape as the Python/FastAPI version).
    pub fn validation(errors: Vec<Value>) -> Self {
        Self { status: StatusCode::UNPROCESSABLE_ENTITY, detail: Value::Array(errors) }
    }
    pub fn field_error(field: &str, msg: &str) -> Value {
        json!({ "loc": ["body", field], "msg": msg, "type": "value_error" })
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "detail": self.detail }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!("database error: {e}");
        Self::internal()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!("internal error: {e:#}");
        Self::internal()
    }
}

pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(db) => db.code().as_deref() == Some("23505"),
        _ => false,
    }
}
