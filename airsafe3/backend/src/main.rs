use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use ed25519_dalek::SigningKey;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tracing_subscriber::EnvFilter;

use airsafe_api::config::Config;
use airsafe_api::state::AppState;
use airsafe_api::{anchor, crypto, routes, seed, simulator};

/// The key that signs ledger checkpoints: from SERVER_SIGNING_KEY, else persisted in the database so old
/// checkpoints stay verifiable across restarts (a KMS/HSM-held key is the production answer).
async fn load_server_key(pool: &PgPool, cfg: &Config) -> Result<SigningKey> {
    if let Some(seed_bytes) = cfg.server_key_seed {
        return Ok(SigningKey::from_bytes(&seed_bytes));
    }
    let existing: Option<Vec<u8>> = sqlx::query_scalar("SELECT seed FROM server_key WHERE id = 1")
        .fetch_optional(pool)
        .await?;
    let seed_vec = match existing {
        Some(s) => s,
        None => {
            let fresh = rand::random::<[u8; 32]>().to_vec();
            sqlx::query("INSERT INTO server_key (id, seed) VALUES (1, $1) ON CONFLICT (id) DO NOTHING")
                .bind(&fresh)
                .execute(pool)
                .await?;
            sqlx::query_scalar("SELECT seed FROM server_key WHERE id = 1").fetch_one(pool).await?
        }
    };
    let seed_arr = <[u8; 32]>::try_from(seed_vec.as_slice()).context("stored server key has the wrong length")?;
    Ok(SigningKey::from_bytes(&seed_arr))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=info")))
        .init();

    let cfg = Config::from_env().map_err(|e| anyhow::anyhow!(e))?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&cfg.database_url)
        .await
        .context("cannot connect to PostgreSQL (is it running, and is DATABASE_URL right?)")?;

    sqlx::raw_sql(include_str!("../migrations/001_init.sql")).execute(&pool).await.context("migration failed")?;
    let seeded = seed::seed_rooms(&pool).await?;
    if seeded > 0 {
        tracing::info!("seeded {seeded} rooms");
    }

    let server_key = load_server_key(&pool, &cfg).await?;
    tracing::info!("ledger signing key: {}", crypto::did_key(&crypto::public_key_of(&server_key)));

    let state = AppState { pool, cfg: Arc::new(cfg), server_key: Arc::new(server_key) };

    if state.cfg.sim_enabled {
        tokio::spawn(simulator::run(state.clone()));
        tracing::info!("simulator on (rooms without a device)");
    } else {
        tracing::info!("simulator off (SIM_ENABLED=0)");
    }
    tokio::spawn(anchor::run(state.clone()));
    match &state.cfg.anchor {
        Some(a) => tracing::info!("on-chain anchoring enabled: contract {} via {}", a.contract, a.rpc_url),
        None => tracing::info!("on-chain anchoring disabled (batches are still sealed and signed)"),
    }

    let app = routes::build(state.clone());
    let addr = SocketAddr::from(([0, 0, 0, 0], state.cfg.port));
    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| format!("cannot bind {addr}"))?;
    tracing::info!("AIRSAFE API on http://{addr} (reachable from the LAN)");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}
