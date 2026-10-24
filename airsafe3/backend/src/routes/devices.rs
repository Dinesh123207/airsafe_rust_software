use axum::{
    body::Bytes,
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{check_vertical_access, AuthUser};
use crate::crypto;
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::merkle;
use crate::models::Device;
use crate::state::AppState;

pub const DEVICE_OFFLINE_AFTER_SECONDS: i64 = 90; // 3x the ~30 s publish interval
const MAX_BACKFILL_MS: i64 = 7 * 24 * 3600 * 1000; // older device timestamps are treated as a bad clock
const MAX_FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;

/// Use the device's own sample time when plausible (SD-buffered readings keep their real time); otherwise the
/// server receive time. `ts` is unix SECONDS from the device, the result is unix MILLISECONDS.
pub fn resolve_reading_time(ts: Option<i64>, now_ms: i64) -> (i64, bool) {
    match ts {
        Some(secs) if secs > 0 => {
            let t = secs.saturating_mul(1000);
            if t > now_ms + MAX_FUTURE_SKEW_MS || t < now_ms - MAX_BACKFILL_MS {
                (now_ms, false)
            } else {
                (t, true)
            }
        }
        _ => (now_ms, false),
    }
}

#[derive(Debug, Deserialize)]
pub struct ReadingIn {
    pub co2_ppm: Option<f64>,
    pub pm25_ugm3: Option<f64>,
    pub temp_c: Option<f64>,
    pub rh_pct: Option<f64>,
    pub occupancy: Option<i64>,
    pub pm10_ugm3: Option<f64>,
    pub tvoc_ppb: Option<f64>,
    pub air_velocity_ms: Option<f64>,
    pub diff_pressure_pa: Option<f64>,
    pub firmware_version: Option<String>,
    pub ts: Option<i64>,
}

pub struct ValidReading {
    pub co2: f64,
    pub pm25: Option<f64>,
    pub temp: Option<f64>,
    pub rh: Option<f64>,
    pub occupancy: Option<i32>,
    pub pm10: Option<f64>,
    pub tvoc: Option<f64>,
    pub air_velocity: Option<f64>,
    pub diff_pressure: Option<f64>,
    pub firmware_version: Option<String>,
    pub ts: Option<i64>,
}

fn required(name: &str, v: Option<f64>, min: f64, max: f64, errs: &mut Vec<Value>) -> f64 {
    match v {
        None => {
            errs.push(ApiError::field_error(name, "Field required"));
            0.0
        }
        Some(x) if !x.is_finite() || x < min || x > max => {
            errs.push(ApiError::field_error(name, &format!("must be between {min} and {max}")));
            0.0
        }
        Some(x) => x,
    }
}

fn optional(name: &str, v: Option<f64>, min: f64, max: f64, errs: &mut Vec<Value>) -> Option<f64> {
    match v {
        None => None,
        Some(x) if !x.is_finite() || x < min || x > max => {
            errs.push(ApiError::field_error(name, &format!("must be between {min} and {max}")));
            None
        }
        Some(x) => Some(x),
    }
}

/// Only CO2 is essential (the risk score is built on it). Everything else is optional so that a node with one failed or
/// not-yet-wired sensor still reports what it can; missing values show as "-" in the app and are listed in the analysis
/// sensor-health section. Ranges are deliberately wide: they reject garbage (65535 ppm, -999 C), not judge air quality.
/// A 422 is a PERMANENT rejection, which tells the firmware to drop that reading instead of retrying it forever.
pub fn validate_reading(r: ReadingIn) -> Result<ValidReading, Vec<Value>> {
    let mut errs = Vec::new();
    let co2 = required("co2_ppm", r.co2_ppm, 300.0, 10000.0, &mut errs);
    let pm25 = optional("pm25_ugm3", r.pm25_ugm3, 0.0, 1000.0, &mut errs);
    let temp = optional("temp_c", r.temp_c, -40.0, 85.0, &mut errs);
    let rh = optional("rh_pct", r.rh_pct, 0.0, 100.0, &mut errs);
    let occupancy = match r.occupancy {
        None => None,
        Some(o) if !(0..=500).contains(&o) => {
            errs.push(ApiError::field_error("occupancy", "must be between 0 and 500"));
            None
        }
        Some(o) => Some(o as i32),
    };
    let pm10 = optional("pm10_ugm3", r.pm10_ugm3, 0.0, 1500.0, &mut errs);
    let tvoc = optional("tvoc_ppb", r.tvoc_ppb, 0.0, 60000.0, &mut errs);
    let air_velocity = optional("air_velocity_ms", r.air_velocity_ms, 0.0, 50.0, &mut errs);
    let diff_pressure = optional("diff_pressure_pa", r.diff_pressure_pa, -2000.0, 2000.0, &mut errs);
    if !errs.is_empty() {
        return Err(errs);
    }
    Ok(ValidReading { co2, pm25, temp, rh, occupancy, pm10, tvoc, air_velocity, diff_pressure, firmware_version: r.firmware_version, ts: r.ts })
}

#[derive(Deserialize)]
pub struct DeviceListQuery {
    pub vertical: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<DeviceListQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    if !user.is_admin() {
        return Err(ApiError::forbidden("Only admins can view devices"));
    }
    let mut vertical = q.vertical;
    if user.vertical_access != "all" {
        check_vertical_access(&user, vertical.as_deref())?;
        vertical = Some(user.vertical_access.clone());
    }
    let rows: Vec<(Device, String, String)> = {
        let devices = sqlx::query_as::<_, Device>(
            "SELECT d.* FROM devices d JOIN rooms r ON r.id = d.room_id
             WHERE ($1::text IS NULL OR r.vertical = $1) ORDER BY d.created_at",
        )
        .bind(vertical.as_deref())
        .fetch_all(&state.pool)
        .await?;
        let mut out = Vec::with_capacity(devices.len());
        for d in devices {
            let (name, vert): (String, String) = sqlx::query_as("SELECT name, vertical FROM rooms WHERE id = $1")
                .bind(&d.room_id)
                .fetch_one(&state.pool)
                .await?;
            out.push((d, name, vert));
        }
        out
    };
    let now = Utc::now();
    Ok(Json(
        rows.into_iter()
            .map(|(d, room_name, vert)| {
                let online = d
                    .last_seen_at
                    .map(|t| (now - t).num_seconds() < DEVICE_OFFLINE_AFTER_SECONDS)
                    .unwrap_or(false);
                json!({
                    "id": d.id, "room_id": d.room_id, "room_name": room_name, "vertical": vert, "label": d.label,
                    "firmware_version": d.firmware_version, "last_seen_at": d.last_seen_at, "online": online,
                    "did": d.did, "has_public_key": d.public_key.is_some(), "require_signature": d.require_signature,
                })
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct ProvisionIn {
    pub device_id: String,
    pub room_id: String,
    pub label: Option<String>,
    /// Optional Ed25519 public key (64 hex characters or a did:key). The private key never leaves the device.
    pub public_key: Option<String>,
    #[serde(default)]
    pub require_signature: bool,
}

// Provisioning is a human action: a logged-in admin registers a device against a room and gets its API key ONCE
// (only the hash is stored). Paste it into firmware/airsafe_node/config.h immediately.
pub async fn provision(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(p): Json<ProvisionIn>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::forbidden("Only admins can provision devices"));
    }
    if p.device_id.trim().is_empty() || p.device_id.len() > 64 || p.device_id.contains(['|', '\n', ' ']) {
        return Err(ApiError::validation(vec![ApiError::field_error(
            "device_id",
            "1-64 characters, no spaces or '|'",
        )]));
    }
    let vertical: Option<String> = sqlx::query_scalar("SELECT vertical FROM rooms WHERE id = $1")
        .bind(&p.room_id)
        .fetch_optional(&state.pool)
        .await?;
    let vertical = vertical.ok_or_else(|| ApiError::not_found("Room not found"))?;
    if user.vertical_access != "all" && vertical != user.vertical_access {
        return Err(ApiError::forbidden("You can't provision a device outside your assigned vertical"));
    }
    let (public_key, did): (Option<Vec<u8>>, Option<String>) = match p.public_key.as_deref() {
        Some(k) if !k.trim().is_empty() => {
            let key = crypto::parse_public_key(k)
                .map_err(|e| ApiError::validation(vec![ApiError::field_error("public_key", &e)]))?;
            (Some(key.to_vec()), Some(crypto::did_key(&key)))
        }
        _ => (None, None),
    };
    if p.require_signature && public_key.is_none() {
        return Err(ApiError::bad_request("require_signature needs a public_key"));
    }
    let api_key = crypto::generate_api_key();
    sqlx::query(
        "INSERT INTO devices (id, room_id, api_key_hash, label, public_key, did, require_signature)
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(&p.device_id)
    .bind(&p.room_id)
    .bind(crypto::sha256_hex(api_key.as_bytes()))
    .bind(p.label.as_deref())
    .bind(public_key.as_deref())
    .bind(did.as_deref())
    .bind(p.require_signature)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        if is_unique_violation(&e) {
            ApiError::conflict("A device with this ID is already provisioned")
        } else {
            ApiError::from(e)
        }
    })?;
    Ok(Json(json!({
        "device_id": p.device_id, "room_id": p.room_id, "api_key": api_key,
        "did": did, "require_signature": p.require_signature,
    })))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.trim()).filter(|s| !s.is_empty())
}

/// What real hardware calls. Auth: X-Device-Id + X-Device-Key. Optional X-Device-Signature: base64url Ed25519
/// signature over `AIRSAFE-READING-V1\n{device_id}\n{exact body}`. Writes the same row shape the simulator writes, so
/// the risk engine and dashboards never need to know where a reading came from; additionally every device reading
/// gets a ledger leaf (see docs/PROTOCOL.md).
pub async fn ingest(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Value>> {
    let unauthorized = || ApiError::unauthorized("Unknown device or invalid device key");
    let device_id = header_str(&headers, "x-device-id").ok_or_else(unauthorized)?.to_string();
    let key = header_str(&headers, "x-device-key").ok_or_else(unauthorized)?;
    let device = sqlx::query_as::<_, Device>("SELECT * FROM devices WHERE id = $1")
        .bind(&device_id)
        .fetch_optional(&state.pool)
        .await?;
    let given = crypto::sha256_hex(key.as_bytes());
    let want = device.as_ref().map(|d| d.api_key_hash.clone()).unwrap_or_else(|| "0".repeat(64));
    let device = match device {
        Some(d) if crypto::ct_eq(given.as_bytes(), want.as_bytes()) => d,
        _ => return Err(unauthorized()),
    };

    // Device identity (web3): optional Ed25519 signature over the exact body.
    let sig_header = header_str(&headers, "x-device-signature").map(|s| s.to_string());
    let mut attested = false;
    let mut stored_signature: Option<String> = None;
    if let Some(pk) = device.public_key.as_deref() {
        match sig_header.as_deref() {
            Some(sig) => {
                let public = <[u8; 32]>::try_from(pk).map_err(|_| ApiError::internal())?;
                let sig_bytes = crypto::b64u_decode(sig).ok_or_else(|| ApiError::unauthorized("Invalid device signature"))?;
                let msg = crypto::reading_sig_message(&device.id, &body);
                if !crypto::verify_ed25519(&public, &msg, &sig_bytes) {
                    return Err(ApiError::unauthorized("Invalid device signature"));
                }
                attested = true;
                stored_signature = Some(sig.to_string());
            }
            None if device.require_signature => {
                return Err(ApiError::unauthorized("This device must sign its readings (X-Device-Signature)"));
            }
            None => {}
        }
    }

    let text = String::from_utf8(body.to_vec())
        .map_err(|_| ApiError::validation(vec![ApiError::field_error("body", "must be UTF-8 JSON")]))?;
    let parsed: ReadingIn = serde_json::from_str(&text)
        .map_err(|e| ApiError::validation(vec![ApiError::field_error("body", &format!("invalid JSON reading: {e}"))]))?;
    let r = validate_reading(parsed).map_err(ApiError::validation)?;

    let now = Utc::now();
    let (reading_ms, used_device_ts) = resolve_reading_time(r.ts, now.timestamp_millis());
    let reading_time: DateTime<Utc> = Utc.timestamp_millis_opt(reading_ms).single().unwrap_or(now);

    let input = crypto::leaf_input(&device.id, reading_ms, text.as_bytes(), stored_signature.as_deref());
    let leaf = merkle::leaf_hash(&input);

    let reading_id: i64 = sqlx::query_scalar(
        "INSERT INTO sensor_readings
           (room_id, timestamp, co2_ppm, pm25_ugm3, pm10_ugm3, tvoc_ppb, air_velocity_ms,
            temp_c, rh_pct, occupancy, diff_pressure_pa, source,
            device_id, reading_ms, raw_body, signature, leaf_hash, attested)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id",
    )
    .bind(&device.room_id)
    .bind(reading_time)
    .bind(r.co2)
    .bind(r.pm25)
    .bind(r.pm10)
    .bind(r.tvoc)
    .bind(r.air_velocity)
    .bind(r.temp)
    .bind(r.rh)
    .bind(r.occupancy)
    .bind(r.diff_pressure)
    .bind(format!("device:{}", device.id))
    .bind(&device.id)
    .bind(reading_ms)
    .bind(&text)
    .bind(stored_signature.as_deref())
    .bind(leaf.to_vec())
    .bind(attested)
    .fetch_one(&state.pool)
    .await?;

    // Liveness is always server time, never the device clock.
    sqlx::query("UPDATE devices SET last_seen_at = $2, firmware_version = COALESCE($3, firmware_version) WHERE id = $1")
        .bind(&device.id)
        .bind(now)
        .bind(r.firmware_version.as_deref())
        .execute(&state.pool)
        .await?;

    Ok(Json(json!({
        "status": "ok",
        "room_id": device.room_id,
        "received_at": now,
        "reading_time": reading_time,
        "used_device_ts": used_device_ts,
        "reading_id": reading_id,
        "attested": attested,
        "leaf_hash": hex::encode(leaf),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_760_000_000_000;

    #[test]
    fn reading_time_rules() {
        assert_eq!(resolve_reading_time(None, NOW), (NOW, false));
        assert_eq!(resolve_reading_time(Some(0), NOW), (NOW, false));
        let ten_min_ago = NOW / 1000 - 600;
        assert_eq!(resolve_reading_time(Some(ten_min_ago), NOW), (ten_min_ago * 1000, true));
        assert_eq!(resolve_reading_time(Some(NOW / 1000 + 3600), NOW), (NOW, false)); // clock in the future
        assert_eq!(resolve_reading_time(Some(NOW / 1000 - 30 * 86400), NOW), (NOW, false)); // 30 days old
    }

    fn good() -> ReadingIn {
        ReadingIn {
            co2_ppm: Some(800.0),
            pm25_ugm3: Some(10.0),
            temp_c: Some(23.0),
            rh_pct: Some(45.0),
            occupancy: Some(1),
            pm10_ugm3: None,
            tvoc_ppb: None,
            air_velocity_ms: None,
            diff_pressure_pa: None,
            firmware_version: None,
            ts: None,
        }
    }

    #[test]
    fn validation_accepts_good_and_rejects_garbage() {
        assert!(validate_reading(good()).is_ok());
        for bad in [
            ReadingIn { co2_ppm: Some(65535.0), ..good() },
            ReadingIn { temp_c: Some(-999.0), ..good() },
            ReadingIn { rh_pct: Some(150.0), ..good() },
            ReadingIn { pm25_ugm3: Some(-1.0), ..good() },
            ReadingIn { occupancy: Some(501), ..good() },
            ReadingIn { co2_ppm: None, ..good() },
            ReadingIn { co2_ppm: Some(f64::NAN), ..good() },
        ] {
            assert!(validate_reading(bad).is_err());
        }
    }

    #[test]
    fn a_node_with_missing_sensors_may_still_report_co2() {
        let partial = ReadingIn { pm25_ugm3: None, temp_c: None, rh_pct: None, occupancy: None, ..good() };
        let v = validate_reading(partial).unwrap();
        assert_eq!((v.pm25, v.temp, v.rh, v.occupancy), (None, None, None, None));
    }
}
