use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{
    create_token, hash_password, verify_password, AuthUser, VALID_ROLES, VALID_VERTICALS,
};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::models::User;
use crate::state::AppState;

fn default_role() -> String {
    "property_admin".to_string()
}
fn default_vertical() -> String {
    "all".to_string()
}

#[derive(Deserialize)]
pub struct RegisterIn {
    pub email: String,
    pub password: String,
    #[serde(default = "default_role")]
    pub role: String,
    #[serde(default = "default_vertical")]
    pub vertical_access: String,
}

#[derive(Deserialize)]
pub struct LoginIn {
    pub email: String,
    pub password: String,
}

fn looks_like_email(s: &str) -> bool {
    let parts: Vec<&str> = s.split('@').collect();
    s.len() <= 254 && parts.len() == 2 && !parts[0].is_empty() && parts[1].contains('.') && !s.contains(' ')
}

pub fn token_response(state: &AppState, user: &User) -> ApiResult<Json<Value>> {
    let token = create_token(&state.cfg.jwt_secret, user).map_err(|_| ApiError::internal())?;
    Ok(Json(json!({ "access_token": token, "token_type": "bearer", "user": user.public() })))
}

// NOTE: like the original demo, anyone can self-register as master_admin so a first login works.
// Lock this down (admin-created accounts or a one-time setup) before exposing the API publicly.
pub async fn register(State(state): State<AppState>, Json(p): Json<RegisterIn>) -> ApiResult<Json<Value>> {
    if !looks_like_email(p.email.trim()) {
        return Err(ApiError::validation(vec![ApiError::field_error("email", "value is not a valid email address")]));
    }
    if !VALID_ROLES.contains(&p.role.as_str()) {
        return Err(ApiError::bad_request(format!("role must be one of {:?}", VALID_ROLES)));
    }
    if !VALID_VERTICALS.contains(&p.vertical_access.as_str()) {
        return Err(ApiError::bad_request(format!("vertical_access must be one of {:?}", VALID_VERTICALS)));
    }
    if p.password.chars().count() < 8 {
        return Err(ApiError::bad_request("Password must be at least 8 characters"));
    }
    if p.password.len() > 128 {
        return Err(ApiError::bad_request("Password must be at most 128 bytes"));
    }
    let email = p.email.trim().to_lowercase();
    let exists: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_some() {
        return Err(ApiError::conflict("An account with this email already exists"));
    }
    let password = p.password.clone();
    let hash = tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|_| ApiError::internal())?
        .map_err(|e| {
            tracing::error!("password hashing failed: {e}");
            ApiError::internal()
        })?;
    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (email, password_hash, role, vertical_access) VALUES ($1,$2,$3,$4) RETURNING *",
    )
    .bind(&email)
    .bind(&hash)
    .bind(&p.role)
    .bind(&p.vertical_access)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        if is_unique_violation(&e) {
            ApiError::conflict("An account with this email already exists")
        } else {
            ApiError::from(e)
        }
    })?;
    token_response(&state, &user)
}

pub async fn login(State(state): State<AppState>, Json(p): Json<LoginIn>) -> ApiResult<Json<Value>> {
    let email = p.email.trim().to_lowercase();
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?;
    let bad = || ApiError::unauthorized("Incorrect email or password");
    let user = user.ok_or_else(bad)?;
    let hash = user.password_hash.clone().ok_or_else(bad)?;
    let password = p.password.clone();
    let ok = tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .map_err(|_| ApiError::internal())?;
    if !ok {
        return Err(bad());
    }
    token_response(&state, &user)
}

pub async fn me(AuthUser(user): AuthUser) -> Json<Value> {
    Json(user.public())
}
