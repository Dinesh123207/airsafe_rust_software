//! Sign-In with Ethereum (EIP-4361). Flow: POST nonce -> wallet signs the returned message (personal_sign) ->
//! POST verify. The server verifies the signature against the message it stored, marks the nonce used (single use,
//! 10 minute lifetime) and issues the same JWT as email login.
use axum::{extract::State, Json};
use chrono::{Duration, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{VALID_ROLES, VALID_VERTICALS};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::models::User;
use crate::routes::auth_routes::token_response;
use crate::state::AppState;
use crate::wallet::{checksum_address, parse_address, recover_address, siwe_message, SiweParams};

const NONCE_MINUTES: i64 = 10;

#[derive(Deserialize)]
pub struct NonceIn {
    pub address: String,
}

#[derive(Deserialize)]
pub struct VerifyIn {
    pub address: String,
    pub nonce: String,
    pub signature: String,
    /// Only used when the wallet has no account yet (self-registration, same open policy as the email form).
    pub role: Option<String>,
    pub vertical_access: Option<String>,
}

pub async fn nonce(State(state): State<AppState>, Json(p): Json<NonceIn>) -> ApiResult<Json<Value>> {
    let addr = parse_address(&p.address)
        .ok_or_else(|| ApiError::validation(vec![ApiError::field_error("address", "not a valid Ethereum address")]))?;
    let checksum = checksum_address(&addr);
    let nonce = hex::encode(rand::random::<[u8; 16]>());
    let now = Utc::now();
    let expires = now + Duration::minutes(NONCE_MINUTES);
    let issued_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let expiration = expires.to_rfc3339_opts(SecondsFormat::Millis, true);
    let message = siwe_message(&SiweParams {
        domain: &state.cfg.siwe_domain,
        address: &checksum,
        statement: "Sign in to AIRSAFE. This does not cost anything and does not authorise any transaction.",
        uri: &state.cfg.siwe_uri,
        chain_id: state.cfg.siwe_chain_id,
        nonce: &nonce,
        issued_at: &issued_at,
        expiration: &expiration,
    });
    sqlx::query("INSERT INTO wallet_nonces (nonce, address, message, expires_at) VALUES ($1,$2,$3,$4)")
        .bind(&nonce)
        .bind(checksum.to_lowercase())
        .bind(&message)
        .bind(expires)
        .execute(&state.pool)
        .await?;
    // opportunistic cleanup of old nonces
    let _ = sqlx::query("DELETE FROM wallet_nonces WHERE expires_at < now() - interval '1 day'")
        .execute(&state.pool)
        .await;
    Ok(Json(json!({ "nonce": nonce, "message": message, "address": checksum, "expires_at": expires })))
}

pub async fn verify(State(state): State<AppState>, Json(p): Json<VerifyIn>) -> ApiResult<Json<Value>> {
    let addr = parse_address(&p.address)
        .ok_or_else(|| ApiError::validation(vec![ApiError::field_error("address", "not a valid Ethereum address")]))?;
    let lower = checksum_address(&addr).to_lowercase();
    let bad = || ApiError::unauthorized("Invalid or expired sign-in request");

    // Atomically consume the nonce: one signature, one login.
    let stored: Option<(String,)> = sqlx::query_as(
        "UPDATE wallet_nonces SET used = true
         WHERE nonce = $1 AND address = $2 AND used = false AND expires_at > now()
         RETURNING message",
    )
    .bind(&p.nonce)
    .bind(&lower)
    .fetch_optional(&state.pool)
    .await?;
    let message = stored.ok_or_else(bad)?.0;

    let signer = recover_address(message.as_bytes(), &p.signature)
        .map_err(|_| ApiError::unauthorized("Signature could not be verified"))?;
    if checksum_address(&signer).to_lowercase() != lower {
        return Err(ApiError::unauthorized("Signature does not match the wallet address"));
    }

    let existing = sqlx::query_as::<_, User>("SELECT * FROM users WHERE wallet_address = $1")
        .bind(&lower)
        .fetch_optional(&state.pool)
        .await?;
    let user = match existing {
        Some(u) => u,
        None => {
            let role = match p.role.as_deref() {
                Some(r) if VALID_ROLES.contains(&r) => r.to_string(),
                Some(_) => return Err(ApiError::bad_request(format!("role must be one of {:?}", VALID_ROLES))),
                None => {
                    return Err(ApiError::not_found(
                        "No account for this wallet yet. Register it first (choose a role and vertical).",
                    ))
                }
            };
            let vertical = match p.vertical_access.as_deref() {
                Some(v) if VALID_VERTICALS.contains(&v) => v.to_string(),
                Some(_) => return Err(ApiError::bad_request(format!("vertical_access must be one of {:?}", VALID_VERTICALS))),
                None => "all".to_string(),
            };
            sqlx::query_as::<_, User>(
                "INSERT INTO users (wallet_address, role, vertical_access) VALUES ($1,$2,$3) RETURNING *",
            )
            .bind(&lower)
            .bind(&role)
            .bind(&vertical)
            .fetch_one(&state.pool)
            .await
            .map_err(|e| {
                if is_unique_violation(&e) {
                    ApiError::conflict("This wallet is already registered")
                } else {
                    ApiError::from(e)
                }
            })?
        }
    };
    token_response(&state, &user)
}
