use std::sync::Arc;

use ed25519_dalek::SigningKey;
use sqlx::PgPool;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub cfg: Arc<Config>,
    /// Signs ledger checkpoints. Its public half is published at /api/ledger/server-key.
    pub server_key: Arc<SigningKey>,
}
