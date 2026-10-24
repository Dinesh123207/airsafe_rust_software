use std::env;

#[derive(Clone, Debug)]
pub struct AnchorConfig {
    pub rpc_url: String,
    /// 0x-prefixed address of the deployed AirSafeAnchor contract.
    pub contract: String,
    /// Key of the funded account that pays for anchoring transactions.
    pub private_key: [u8; 32],
    pub chain_id: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub jwt_secret: String,
    pub sim_enabled: bool,
    pub sim_retention_hours: i64,
    /// Directory with the exported web app (Next.js `out/`). When set, the API serves it itself.
    pub static_dir: Option<String>,
    pub server_key_seed: Option<[u8; 32]>,
    pub siwe_domain: String,
    pub siwe_uri: String,
    pub siwe_chain_id: u64,
    pub anchor_interval_secs: u64,
    pub anchor: Option<AnchorConfig>,
}

fn get(name: &str) -> Option<String> {
    env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn parse_32(label: &str, value: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(value.trim_start_matches("0x")).map_err(|e| format!("{label}: {e}"))?;
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| format!("{label} must be 32 bytes (64 hex characters)"))
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let anchor = match (get("ANCHOR_RPC_URL"), get("ANCHOR_CONTRACT"), get("ANCHOR_PRIVATE_KEY")) {
            (Some(rpc_url), Some(contract), Some(key)) => Some(AnchorConfig {
                rpc_url,
                contract,
                private_key: parse_32("ANCHOR_PRIVATE_KEY", &key)?,
                chain_id: get("ANCHOR_CHAIN_ID").and_then(|v| v.parse().ok()),
            }),
            _ => None,
        };
        let server_key_seed = match get("SERVER_SIGNING_KEY") {
            Some(v) => Some(parse_32("SERVER_SIGNING_KEY", &v)?),
            None => None,
        };
        Ok(Self {
            port: get("PORT").and_then(|v| v.parse().ok()).unwrap_or(8000),
            database_url: get("DATABASE_URL").unwrap_or_else(|| "postgres://airsafe:airsafe@localhost:5432/airsafe".into()),
            jwt_secret: get("AIRSAFE_SECRET_KEY").unwrap_or_else(|| "dev-only-change-me-before-real-use".into()),
            sim_enabled: get("SIM_ENABLED").map(|v| v != "0").unwrap_or(true),
            sim_retention_hours: get("SIM_RETENTION_HOURS").and_then(|v| v.parse().ok()).unwrap_or(72),
            static_dir: get("STATIC_DIR"),
            server_key_seed,
            siwe_domain: get("SIWE_DOMAIN").unwrap_or_else(|| "localhost".into()),
            siwe_uri: get("SIWE_URI").unwrap_or_else(|| "http://localhost:8000".into()),
            siwe_chain_id: get("SIWE_CHAIN_ID").and_then(|v| v.parse().ok()).unwrap_or(31337),
            anchor_interval_secs: get("ANCHOR_INTERVAL_SECS").and_then(|v| v.parse().ok()).unwrap_or(300),
            anchor,
        })
    }
}
