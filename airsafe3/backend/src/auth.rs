use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{extract::FromRequestParts, http::request::Parts};
use jsonwebtoken::{decode, encode, errors::ErrorKind, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::models::User;
use crate::state::AppState;

pub const TOKEN_HOURS: i64 = 12;
pub const VALID_ROLES: [&str; 3] = ["master_admin", "property_admin", "staff"];
pub const VALID_VERTICALS: [&str; 4] = ["all", "hospital", "hotel", "corporate"];

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub role: String,
    pub vertical_access: String,
    pub exp: usize,
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

pub fn create_token(secret: &str, user: &User) -> Result<String, jsonwebtoken::errors::Error> {
    let exp = (chrono::Utc::now() + chrono::Duration::hours(TOKEN_HOURS)).timestamp() as usize;
    let claims = Claims {
        sub: user.id.to_string(),
        role: user.role.clone(),
        vertical_access: user.vertical_access.clone(),
        exp,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
}

pub fn decode_token(secret: &str, token: &str) -> Result<Claims, String> {
    let validation = Validation::new(Algorithm::HS256);
    decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &validation)
        .map(|d| d.claims)
        .map_err(|e| match e.kind() {
            ErrorKind::ExpiredSignature => "Token expired, please log in again".to_string(),
            _ => "Invalid authentication token".to_string(),
        })
}

/// A user whose bearer token is valid AND who still exists.
pub struct AuthUser(pub User);

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .ok_or_else(|| ApiError::unauthorized("Not authenticated"))?;
        let claims = decode_token(&state.cfg.jwt_secret, token).map_err(ApiError::unauthorized)?;
        let uid: i32 = claims.sub.parse().map_err(|_| ApiError::unauthorized("Invalid authentication token"))?;
        let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
            .bind(uid)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::unauthorized("User no longer exists"))?;
        Ok(AuthUser(user))
    }
}

/// `vertical_access = 'all'` may read everything; otherwise only the account's own vertical.
pub fn check_vertical_access(user: &User, requested: Option<&str>) -> Result<(), ApiError> {
    if user.vertical_access == "all" {
        return Ok(());
    }
    match requested {
        Some(v) if v != user.vertical_access => Err(ApiError::forbidden(format!(
            "Your account only has access to '{}'",
            user.vertical_access
        ))),
        _ => Ok(()),
    }
}

/// Master admins may query any vertical or none (the unfiltered query IS the master view); everyone else is pinned
/// to their own vertical whatever they pass.
pub fn effective_vertical(user: &User, requested: Option<String>) -> Result<Option<String>, ApiError> {
    if user.vertical_access == "all" {
        return Ok(requested);
    }
    check_vertical_access(user, requested.as_deref())?;
    Ok(Some(user.vertical_access.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(vertical: &str) -> User {
        User {
            id: 1,
            email: Some("a@b.co".into()),
            password_hash: None,
            wallet_address: None,
            role: "property_admin".into(),
            vertical_access: vertical.into(),
            created_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn password_round_trip() {
        let h = hash_password("correct-horse-1").unwrap();
        assert!(verify_password("correct-horse-1", &h));
        assert!(!verify_password("wrong-password", &h));
    }

    #[test]
    fn token_round_trip_and_tamper() {
        let t = create_token("secret", &user("hotel")).unwrap();
        let c = decode_token("secret", &t).unwrap();
        assert_eq!((c.sub.as_str(), c.vertical_access.as_str()), ("1", "hotel"));
        assert!(decode_token("other-secret", &t).is_err());
        assert!(decode_token("secret", "garbage").is_err());
    }

    #[test]
    fn vertical_scoping() {
        let hotel = user("hotel");
        assert!(check_vertical_access(&hotel, Some("hotel")).is_ok());
        assert!(check_vertical_access(&hotel, Some("hospital")).is_err());
        assert_eq!(effective_vertical(&hotel, None).unwrap(), Some("hotel".to_string()));
        assert!(effective_vertical(&hotel, Some("hospital".into())).is_err());
        assert_eq!(effective_vertical(&user("all"), None).unwrap(), None);
    }
}
