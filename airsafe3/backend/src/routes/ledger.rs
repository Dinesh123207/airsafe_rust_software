//! Read side of the verifiable ledger: summary, batches, the server's public key and per-reading inclusion proofs.
use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::anchor;
use crate::auth::{check_vertical_access, AuthUser};
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::merkle;
use crate::state::AppState;

#[derive(Debug, FromRow)]
struct BatchRow {
    id: i64,
    root: Vec<u8>,
    leaf_count: i32,
    from_ms: i64,
    to_ms: i64,
    first_reading_id: i64,
    last_reading_id: i64,
    checkpoint_sig: Option<String>,
    created_at: DateTime<Utc>,
    anchor_chain_id: Option<i64>,
    anchor_contract: Option<String>,
    anchor_tx: Option<String>,
    anchor_block: Option<i64>,
    anchored_at: Option<DateTime<Utc>>,
}

fn batch_json(b: &BatchRow) -> Value {
    let anchor = match &b.anchor_tx {
        Some(tx) => json!({
            "chain_id": b.anchor_chain_id, "contract": b.anchor_contract, "tx_hash": tx,
            "block_number": b.anchor_block, "anchored_at": b.anchored_at,
        }),
        None => Value::Null,
    };
    json!({
        "id": b.id,
        "root": hex::encode(&b.root),
        "leaf_count": b.leaf_count,
        "from_ms": b.from_ms,
        "to_ms": b.to_ms,
        "first_reading_id": b.first_reading_id,
        "last_reading_id": b.last_reading_id,
        "checkpoint_signature": b.checkpoint_sig,
        "created_at": b.created_at,
        "status": if b.anchor_tx.is_some() { "anchored" } else { "sealed" },
        "anchor": anchor,
    })
}

fn server_key_json(state: &AppState) -> Value {
    let public = crypto::public_key_of(&state.server_key);
    json!({ "algorithm": "Ed25519", "did": crypto::did_key(&public), "public_key_hex": hex::encode(public) })
}

pub async fn server_key(State(state): State<AppState>) -> Json<Value> {
    Json(server_key_json(&state))
}

pub async fn summary(State(state): State<AppState>, AuthUser(_user): AuthUser) -> ApiResult<Json<Value>> {
    let (ledgered, pending, attested): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE batch_id IS NULL), COUNT(*) FILTER (WHERE attested)
         FROM sensor_readings WHERE leaf_hash IS NOT NULL",
    )
    .fetch_one(&state.pool)
    .await?;
    let (batches, anchored): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COUNT(*) FILTER (WHERE anchor_tx IS NOT NULL) FROM ledger_batches")
            .fetch_one(&state.pool)
            .await?;
    let anchor_cfg = state.cfg.anchor.as_ref().map(|a| {
        json!({ "rpc_url_configured": true, "contract": a.contract, "chain_id": a.chain_id })
    });
    Ok(Json(json!({
        "ledgered_readings": ledgered,
        "pending_readings": pending,
        "attested_readings": attested,
        "batches": batches,
        "anchored_batches": anchored,
        "seal_interval_secs": state.cfg.anchor_interval_secs,
        "anchoring_enabled": state.cfg.anchor.is_some(),
        "anchor": anchor_cfg,
        "server_key": server_key_json(&state),
    })))
}

#[derive(Deserialize)]
pub struct BatchesQuery {
    pub limit: Option<i64>,
}

pub async fn batches(
    State(state): State<AppState>,
    AuthUser(_user): AuthUser,
    Query(q): Query<BatchesQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<_, BatchRow>("SELECT * FROM ledger_batches ORDER BY id DESC LIMIT $1")
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(rows.iter().map(batch_json).collect()))
}

pub async fn batch(
    State(state): State<AppState>,
    AuthUser(_user): AuthUser,
    Path(batch_id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query_as::<_, BatchRow>("SELECT * FROM ledger_batches WHERE id = $1")
        .bind(batch_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("Batch not found"))?;
    Ok(Json(batch_json(&row)))
}

#[derive(Debug, FromRow)]
struct ProofReading {
    id: i64,
    room_id: String,
    vertical: String,
    device_id: Option<String>,
    reading_ms: Option<i64>,
    raw_body: Option<String>,
    signature: Option<String>,
    leaf_hash: Option<Vec<u8>>,
    attested: bool,
    batch_id: Option<i64>,
    batch_index: Option<i32>,
    device_public_key: Option<Vec<u8>>,
    device_did: Option<String>,
}

/// Inclusion proof for one reading. A client needs nothing else to verify it independently: the raw body, the leaf
/// input, the audit path, the signed checkpoint and (if anchored) the transaction that wrote the root on chain.
pub async fn proof(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(reading_id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let r = sqlx::query_as::<_, ProofReading>(
        "SELECT s.id, s.room_id, rm.vertical, s.device_id, s.reading_ms, s.raw_body, s.signature, s.leaf_hash,
                s.attested, s.batch_id, s.batch_index,
                d.public_key AS device_public_key, d.did AS device_did
         FROM sensor_readings s
         JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN devices d ON d.id = s.device_id
         WHERE s.id = $1",
    )
    .bind(reading_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Reading not found"))?;
    check_vertical_access(&user, Some(&r.vertical))?;

    let (device_id, reading_ms, body, leaf_hash) = match (&r.device_id, r.reading_ms, &r.raw_body, &r.leaf_hash) {
        (Some(d), Some(ms), Some(b), Some(l)) => (d.clone(), ms, b.clone(), l.clone()),
        _ => return Err(ApiError::not_found("This reading is not in the ledger (simulated data is never ledgered)")),
    };
    let leaf_input = String::from_utf8_lossy(&crypto::leaf_input(&device_id, reading_ms, body.as_bytes(), r.signature.as_deref()))
        .to_string();
    let reading = json!({
        "id": r.id, "room_id": r.room_id, "device_id": device_id, "reading_ms": reading_ms, "body": body,
        "signature": r.signature, "attested": r.attested,
        "device_did": r.device_did, "device_public_key": r.device_public_key.as_ref().map(hex::encode),
    });

    let (batch_id, index) = match (r.batch_id, r.batch_index) {
        (Some(b), Some(i)) => (b, i as usize),
        _ => {
            return Ok(Json(json!({
                "status": "pending", "reading": reading, "leaf_input": leaf_input, "leaf_hash": hex::encode(&leaf_hash),
                "batch": null, "server_key": server_key_json(&state),
                "note": "Not sealed into a batch yet; this happens every few minutes (or use Seal now)."
            })));
        }
    };

    let batch_row = sqlx::query_as::<_, BatchRow>("SELECT * FROM ledger_batches WHERE id = $1")
        .bind(batch_id)
        .fetch_one(&state.pool)
        .await?;
    let hashes: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT leaf_hash FROM sensor_readings WHERE batch_id = $1 ORDER BY batch_index")
            .bind(batch_id)
            .fetch_all(&state.pool)
            .await?;
    let mut leaves: Vec<merkle::Hash> = Vec::with_capacity(hashes.len());
    for h in &hashes {
        leaves.push(<[u8; 32]>::try_from(h.as_slice()).map_err(|_| ApiError::internal())?);
    }
    if index >= leaves.len() {
        return Err(ApiError::internal());
    }
    let path: Vec<String> = merkle::audit_path(index, &leaves).iter().map(hex::encode).collect();
    let status = if batch_row.anchor_tx.is_some() { "anchored" } else { "sealed" };
    Ok(Json(json!({
        "status": status,
        "reading": reading,
        "leaf_input": leaf_input,
        "leaf_hash": hex::encode(&leaf_hash),
        "index": index,
        "tree_size": leaves.len(),
        "audit_path": path,
        "root": hex::encode(&batch_row.root),
        "batch": batch_json(&batch_row),
        "server_key": server_key_json(&state),
    })))
}

/// Seal pending readings into a batch now and push any unanchored batches to the chain (master admins only).
pub async fn seal_now(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    if user.role != "master_admin" {
        return Err(ApiError::forbidden("Only master admins can seal the ledger"));
    }
    let sealed = anchor::seal_batch(&state).await.map_err(ApiError::from)?;
    let (anchoring, error) = if state.cfg.anchor.is_some() {
        match anchor::anchor_pending(&state).await {
            Ok(()) => ("enabled", None),
            Err(e) => ("enabled", Some(format!("{e:#}"))),
        }
    } else {
        ("disabled", None)
    };
    Ok(Json(json!({ "sealed_batch_id": sealed, "anchoring": anchoring, "anchor_error": error })))
}
