use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::risk::{compute_score, status_label, Driver};

#[derive(Debug, Clone, FromRow)]
pub struct User {
    pub id: i32,
    pub email: Option<String>,
    pub password_hash: Option<String>,
    pub wallet_address: Option<String>,
    pub role: String,
    pub vertical_access: String,
    pub created_at: DateTime<Utc>,
}

impl User {
    pub fn public(&self) -> Value {
        json!({
            "id": self.id,
            "email": self.email,
            "wallet_address": self.wallet_address,
            "role": self.role,
            "vertical_access": self.vertical_access,
        })
    }
    pub fn is_admin(&self) -> bool {
        self.role == "master_admin" || self.role == "property_admin"
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct Device {
    pub id: String,
    pub room_id: String,
    pub api_key_hash: String,
    pub label: Option<String>,
    pub firmware_version: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub public_key: Option<Vec<u8>>,
    pub did: Option<String>,
    pub require_signature: bool,
}

#[derive(Debug, Clone, FromRow)]
pub struct RoomRow {
    pub id: String,
    pub vertical: String,
    pub name: String,
    pub department: String,
    pub tier: String,
    pub room_type: String,
    pub capacity: i32,
    pub ventilation_factor: f64,
    pub has_device: bool,
    pub r_id: Option<i64>,
    pub r_timestamp: Option<DateTime<Utc>>,
    pub r_co2_ppm: Option<f64>,
    pub r_pm25_ugm3: Option<f64>,
    pub r_pm10_ugm3: Option<f64>,
    pub r_tvoc_ppb: Option<f64>,
    pub r_air_velocity_ms: Option<f64>,
    pub r_temp_c: Option<f64>,
    pub r_rh_pct: Option<f64>,
    pub r_occupancy: Option<i32>,
    pub r_diff_pressure_pa: Option<f64>,
    pub r_booked: Option<bool>,
    pub r_source: Option<String>,
    pub r_attested: Option<bool>,
}

/// Latest reading per room, joined to the room. `$1` = vertical filter, `$2` = room id filter (either may be NULL).
pub const ROOM_STATUS_SQL: &str = "
SELECT r.id, r.vertical, r.name, r.department, r.tier, r.room_type, r.capacity, r.ventilation_factor,
       EXISTS (SELECT 1 FROM devices d WHERE d.room_id = r.id) AS has_device,
       lr.id AS r_id, lr.timestamp AS r_timestamp, lr.co2_ppm AS r_co2_ppm, lr.pm25_ugm3 AS r_pm25_ugm3,
       lr.pm10_ugm3 AS r_pm10_ugm3, lr.tvoc_ppb AS r_tvoc_ppb, lr.air_velocity_ms AS r_air_velocity_ms,
       lr.temp_c AS r_temp_c, lr.rh_pct AS r_rh_pct, lr.occupancy AS r_occupancy,
       lr.diff_pressure_pa AS r_diff_pressure_pa, lr.booked AS r_booked, lr.source AS r_source,
       lr.attested AS r_attested
FROM rooms r
LEFT JOIN LATERAL (
  SELECT * FROM sensor_readings s WHERE s.room_id = r.id ORDER BY s.timestamp DESC, s.id DESC LIMIT 1
) lr ON true
WHERE ($1::text IS NULL OR r.vertical = $1) AND ($2::text IS NULL OR r.id = $2)
ORDER BY r.position";

pub const STALE_AFTER_SECONDS: i64 = 120;

#[derive(Debug, Clone, Serialize)]
pub struct RoomStatus {
    pub id: String,
    pub vertical: String,
    pub name: String,
    pub department: String,
    pub tier: String,
    pub room_type: String,
    pub capacity: i32,
    pub reading_id: Option<i64>,
    pub timestamp: Option<DateTime<Utc>>,
    pub co2_ppm: Option<f64>,
    pub pm25_ugm3: Option<f64>,
    pub pm10_ugm3: Option<f64>,
    pub tvoc_ppb: Option<f64>,
    pub air_velocity_ms: Option<f64>,
    pub temp_c: Option<f64>,
    pub rh_pct: Option<f64>,
    pub occupancy: Option<i32>,
    pub diff_pressure_pa: Option<f64>,
    pub booked: Option<bool>,
    pub est_ach: Option<f64>,
    pub score: Option<f64>,
    pub status: Option<String>,
    pub rebreathed_fraction_pct: Option<f64>,
    pub source: Option<String>,
    pub attested: Option<bool>,
    pub stale: Option<bool>,
    pub drivers: Vec<Driver>,
}

/// A room with a provisioned device is "stale" unless fresh DEVICE data is arriving (never reported, gone silent,
/// or the newest row is an old simulated one).
pub fn is_stale(row: &RoomRow, now: DateTime<Utc>) -> bool {
    if !row.has_device {
        return false;
    }
    let from_device = row.r_source.as_deref().map(|s| s.starts_with("device:")).unwrap_or(false);
    if !from_device {
        return true;
    }
    match row.r_timestamp {
        Some(ts) => (now - ts).num_seconds() > STALE_AFTER_SECONDS,
        None => true,
    }
}

pub fn room_status(row: &RoomRow, now: DateTime<Utc>) -> RoomStatus {
    let mut status = RoomStatus {
        id: row.id.clone(),
        vertical: row.vertical.clone(),
        name: row.name.clone(),
        department: row.department.clone(),
        tier: row.tier.clone(),
        room_type: row.room_type.clone(),
        capacity: row.capacity,
        reading_id: None,
        timestamp: None,
        co2_ppm: None,
        pm25_ugm3: None,
        pm10_ugm3: None,
        tvoc_ppb: None,
        air_velocity_ms: None,
        temp_c: None,
        rh_pct: None,
        occupancy: None,
        diff_pressure_pa: None,
        booked: None,
        est_ach: None,
        score: None,
        status: None,
        rebreathed_fraction_pct: None,
        source: None,
        attested: None,
        stale: None,
        drivers: Vec::new(),
    };
    let (ts, co2) = match (row.r_timestamp, row.r_co2_ppm) {
        (Some(ts), Some(co2)) => (ts, co2),
        _ => return status,
    };
    // PM2.5 is optional: with no PM sensor the PM penalty is simply not applied.
    let result = compute_score(co2, row.r_pm25_ugm3.unwrap_or(0.0), row.r_diff_pressure_pa);
    status.reading_id = row.r_id;
    status.timestamp = Some(ts);
    status.co2_ppm = Some(co2);
    status.pm25_ugm3 = row.r_pm25_ugm3;
    status.pm10_ugm3 = row.r_pm10_ugm3;
    status.tvoc_ppb = row.r_tvoc_ppb;
    status.air_velocity_ms = row.r_air_velocity_ms;
    status.temp_c = row.r_temp_c;
    status.rh_pct = row.r_rh_pct;
    status.occupancy = row.r_occupancy;
    status.diff_pressure_pa = row.r_diff_pressure_pa;
    status.booked = row.r_booked;
    status.est_ach = Some((row.ventilation_factor * 12.0 * 10.0).round() / 10.0);
    status.score = Some(result.score);
    status.status = Some(status_label(result.score).to_string());
    status.rebreathed_fraction_pct = Some(result.rebreathed_fraction_pct);
    status.source = row.r_source.clone();
    status.attested = row.r_attested;
    status.stale = Some(is_stale(row, now));
    status.drivers = result.drivers;
    status
}
