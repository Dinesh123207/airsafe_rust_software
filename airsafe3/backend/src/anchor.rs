//! Ledger worker. Every `ANCHOR_INTERVAL_SECS`:
//!   1. seal: gather every device reading not yet in a batch, build an RFC 6962 Merkle tree over their leaf hashes,
//!      store the batch and sign a checkpoint with the server's Ed25519 key;
//!   2. anchor: write each unanchored batch root to the AirSafeAnchor contract on an EVM chain (if configured).
//! Sealing needs no blockchain; anchoring only adds a public, third-party timestamp that even the operator of this
//! server cannot alter afterwards.
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

use crate::crypto;
use crate::evm::{self, LegacyTx, Rpc};
use crate::merkle;
use crate::state::AppState;
use crate::wallet;

const MAX_BATCH: i64 = 4096;
const ADVISORY_LOCK_KEY: i64 = 727_274;

pub async fn run(state: AppState) {
    let every = Duration::from_secs(state.cfg.anchor_interval_secs.max(5));
    loop {
        tokio::time::sleep(every).await;
        if let Err(e) = seal_batch(&state).await {
            tracing::error!("ledger seal failed: {e:#}");
        }
        if let Err(e) = anchor_pending(&state).await {
            tracing::error!("ledger anchoring failed: {e:#}");
        }
    }
}

/// Seals pending device readings into a new batch. Returns the batch id, or None if there was nothing to seal.
pub async fn seal_batch(state: &AppState) -> Result<Option<i64>> {
    let mut tx = state.pool.begin().await?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
        .bind(ADVISORY_LOCK_KEY)
        .fetch_one(&mut *tx)
        .await?;
    if !locked {
        return Ok(None); // another instance is sealing right now
    }
    let rows: Vec<(i64, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT id, reading_ms, leaf_hash FROM sensor_readings
         WHERE leaf_hash IS NOT NULL AND batch_id IS NULL ORDER BY id LIMIT $1",
    )
    .bind(MAX_BATCH)
    .fetch_all(&mut *tx)
    .await?;
    if rows.is_empty() {
        return Ok(None);
    }

    let mut leaves: Vec<merkle::Hash> = Vec::with_capacity(rows.len());
    for r in &rows {
        leaves.push(<[u8; 32]>::try_from(r.2.as_slice()).map_err(|_| anyhow!("stored leaf hash has the wrong length"))?);
    }
    let root = merkle::root(&leaves);
    let from_ms = rows.iter().map(|r| r.1).min().unwrap_or(0);
    let to_ms = rows.iter().map(|r| r.1).max().unwrap_or(0);
    let first_id = rows.first().map(|r| r.0).unwrap_or(0);
    let last_id = rows.last().map(|r| r.0).unwrap_or(0);

    let batch_id: i64 = sqlx::query_scalar(
        "INSERT INTO ledger_batches (root, leaf_count, from_ms, to_ms, first_reading_id, last_reading_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    )
    .bind(root.to_vec())
    .bind(leaves.len() as i32)
    .bind(from_ms)
    .bind(to_ms)
    .bind(first_id)
    .bind(last_id)
    .fetch_one(&mut *tx)
    .await?;

    let message = crypto::checkpoint_message(batch_id, &hex::encode(root), leaves.len() as i64, from_ms, to_ms);
    let signature = crypto::b64u(&crypto::sign_ed25519(&state.server_key, &message));
    sqlx::query("UPDATE ledger_batches SET checkpoint_sig = $1 WHERE id = $2")
        .bind(&signature)
        .bind(batch_id)
        .execute(&mut *tx)
        .await?;

    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    let idx: Vec<i32> = (0..rows.len() as i32).collect();
    sqlx::query(
        "UPDATE sensor_readings s SET batch_id = $1, batch_index = u.idx
         FROM UNNEST($2::bigint[], $3::int[]) AS u(id, idx) WHERE s.id = u.id",
    )
    .bind(batch_id)
    .bind(ids)
    .bind(idx)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    tracing::info!("sealed ledger batch {batch_id}: {} readings, root {}", leaves.len(), hex::encode(root));
    Ok(Some(batch_id))
}

/// Writes every batch that is not yet on chain to the contract. Stops at the first failure and retries next time.
pub async fn anchor_pending(state: &AppState) -> Result<()> {
    let cfg = match state.cfg.anchor.as_ref() {
        Some(c) => c,
        None => return Ok(()),
    };
    let batches: Vec<(i64, Vec<u8>, i32, i64, i64)> = sqlx::query_as(
        "SELECT id, root, leaf_count, from_ms, to_ms FROM ledger_batches WHERE anchor_tx IS NULL ORDER BY id LIMIT 20",
    )
    .fetch_all(&state.pool)
    .await?;
    if batches.is_empty() {
        return Ok(());
    }

    let key = evm::signing_key(&cfg.private_key)?;
    let from_addr = evm::hex0x(&evm::address_of(&key));
    let to = wallet::parse_address(&cfg.contract).ok_or_else(|| anyhow!("ANCHOR_CONTRACT is not a valid address"))?;
    let to_hex = evm::hex0x(&to);
    let rpc = Rpc::new(&cfg.rpc_url);
    let chain_id = match cfg.chain_id {
        Some(c) => c,
        None => rpc.chain_id().await?,
    };

    for (id, root, leaf_count, from_ms, to_ms) in batches {
        let root32 = <[u8; 32]>::try_from(root.as_slice()).map_err(|_| anyhow!("stored root has the wrong length"))?;
        let data = evm::encode_anchor_call(&root32, id as u64, leaf_count as u64, from_ms as u64, to_ms as u64);
        let nonce = rpc.nonce(&from_addr).await?;
        let gas_price = rpc.gas_price().await?;
        let estimate = rpc.estimate_gas(&from_addr, &to_hex, &data).await.unwrap_or(200_000);
        let tx = LegacyTx {
            nonce,
            gas_price: gas_price.saturating_mul(12) / 10,
            gas_limit: estimate.saturating_mul(13) / 10 + 10_000,
            to,
            value: 0,
            data,
            chain_id,
        };
        let signed = evm::sign_legacy(&tx, &key)?;
        let tx_hash = rpc.send_raw(&signed.raw).await?;
        let (block, ok) = rpc.wait_receipt(&tx_hash, 90).await?;
        if !ok {
            bail!("anchor transaction {tx_hash} for batch {id} reverted");
        }
        sqlx::query(
            "UPDATE ledger_batches SET anchor_chain_id = $1, anchor_contract = $2, anchor_tx = $3,
             anchor_block = $4, anchored_at = now() WHERE id = $5",
        )
        .bind(chain_id as i64)
        .bind(&cfg.contract)
        .bind(&tx_hash)
        .bind(block as i64)
        .bind(id)
        .execute(&state.pool)
        .await?;
        tracing::info!("anchored batch {id} on chain {chain_id} in tx {tx_hash} (block {block})");
    }
    Ok(())
}
