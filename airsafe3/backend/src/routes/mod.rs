pub mod auth_routes;
pub mod devices;
pub mod ledger;
pub mod methodology;
pub mod rooms;
pub mod wallet_routes;

use axum::{
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};

use crate::state::AppState;

async fn status() -> Json<Value> {
    Json(json!({
        "service": "AIRSAFE API",
        "status": "running",
        "stack": "rust (axum) + postgresql",
        "verticals": ["hospital", "hotel", "corporate"],
        "methodology": "/api/methodology",
        "ledger": "/api/ledger/summary",
        "note": "Readings with source=simulator are simulated; source=device:<id> comes from provisioned hardware. \
                 Device readings are hashed into a Merkle ledger and can be anchored on an EVM chain."
    }))
}

/// Liveness + readiness for people and tools (`tools/connect_hardware.mjs`, Docker): database reachable, device activity.
async fn health(axum::extract::State(state): axum::extract::State<AppState>) -> (axum::http::StatusCode, Json<Value>) {
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.pool).await.is_ok();
    let (devices, last_seen): (i64, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT COUNT(*), MAX(last_seen_at) FROM devices")
            .fetch_one(&state.pool)
            .await
            .unwrap_or((0, None));
    let age = last_seen.map(|t| (chrono::Utc::now() - t).num_seconds());
    let code = if db_ok { axum::http::StatusCode::OK } else { axum::http::StatusCode::SERVICE_UNAVAILABLE };
    (
        code,
        Json(json!({
            "ok": db_ok,
            "database": db_ok,
            "version": env!("CARGO_PKG_VERSION"),
            "devices": devices,
            "newest_device_report_age_s": age,
            "simulator": state.cfg.sim_enabled,
            "anchoring": state.cfg.anchor.is_some(),
            "time": chrono::Utc::now(),
        })),
    )
}

pub fn build(state: AppState) -> Router {
    let static_dir = state.cfg.static_dir.clone();
    let api = Router::new()
        .route("/status", get(status))
        .route("/health", get(health))
        .route("/auth/register", post(auth_routes::register))
        .route("/auth/login", post(auth_routes::login))
        .route("/auth/me", get(auth_routes::me))
        .route("/auth/wallet/nonce", post(wallet_routes::nonce))
        .route("/auth/wallet/verify", post(wallet_routes::verify))
        .route("/rooms", get(rooms::list))
        .route("/rooms/:room_id", get(rooms::get_one))
        .route("/rooms/:room_id/history", get(rooms::history))
        .route("/rooms/:room_id/analysis", get(rooms::analysis))
        .route("/alerts", get(rooms::alerts))
        .route("/devices", get(devices::list))
        .route("/devices/provision", post(devices::provision))
        .route("/ingest/reading", post(devices::ingest))
        .route("/methodology", get(methodology::get_methodology))
        .route("/ledger/summary", get(ledger::summary))
        .route("/ledger/server-key", get(ledger::server_key))
        .route("/ledger/batches", get(ledger::batches))
        .route("/ledger/batches/:batch_id", get(ledger::batch))
        .route("/ledger/proof/:reading_id", get(ledger::proof))
        .route("/ledger/seal", post(ledger::seal_now))
        .with_state(state);

    let mut app = Router::new().nest("/api", api);
    app = match static_dir {
        // One process serves API and web app (like the original Python build).
        Some(dir) => app.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true)),
        None => app.route("/", get(status)),
    };
    app.layer(CorsLayer::permissive()).layer(TraceLayer::new_for_http())
}
