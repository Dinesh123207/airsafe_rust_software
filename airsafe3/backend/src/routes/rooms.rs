use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::analysis::{analyze, Sample};
use crate::auth::{check_vertical_access, effective_vertical, AuthUser};
use crate::error::{ApiError, ApiResult};
use crate::models::{room_status, RoomRow, RoomStatus, ROOM_STATUS_SQL};
use crate::risk::compute_score;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ListQuery {
    pub vertical: Option<String>,
    pub threshold: Option<f64>,
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<i64>,
}

pub async fn fetch_rows(state: &AppState, vertical: Option<&str>, room_id: Option<&str>) -> ApiResult<Vec<RoomRow>> {
    Ok(sqlx::query_as::<_, RoomRow>(ROOM_STATUS_SQL)
        .bind(vertical)
        .bind(room_id)
        .fetch_all(&state.pool)
        .await?)
}

pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<RoomStatus>>> {
    let vertical = effective_vertical(&user, q.vertical)?;
    let rows = fetch_rows(&state, vertical.as_deref(), None).await?;
    let now = Utc::now();
    Ok(Json(rows.iter().map(|r| room_status(r, now)).collect()))
}

pub async fn get_one(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(room_id): Path<String>,
) -> ApiResult<Json<RoomStatus>> {
    let rows = fetch_rows(&state, None, Some(&room_id)).await?;
    let row = rows.first().ok_or_else(|| ApiError::not_found("Room not found"))?;
    check_vertical_access(&user, Some(&row.vertical))?;
    Ok(Json(room_status(row, Utc::now())))
}

pub async fn history(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(room_id): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let vertical: Option<String> = sqlx::query_scalar("SELECT vertical FROM rooms WHERE id = $1")
        .bind(&room_id)
        .fetch_optional(&state.pool)
        .await?;
    let vertical = vertical.ok_or_else(|| ApiError::not_found("Room not found"))?;
    check_vertical_access(&user, Some(&vertical))?;
    let limit = q.limit.unwrap_or(120).clamp(1, 2000);
    let mut rows: Vec<(DateTime<Utc>, f64, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT timestamp, co2_ppm, pm25_ugm3, diff_pressure_pa FROM sensor_readings
         WHERE room_id = $1 ORDER BY timestamp DESC, id DESC LIMIT $2",
    )
    .bind(&room_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    rows.reverse();
    Ok(Json(
        rows.into_iter()
            .map(|(ts, co2, pm25, dp)| {
                json!({ "timestamp": ts, "co2_ppm": co2, "pm25_ugm3": pm25, "score": compute_score(co2, pm25.unwrap_or(0.0), dp).score })
            })
            .collect(),
    ))
}

fn recommendation(s: &RoomStatus) -> &'static str {
    if s.rebreathed_fraction_pct.map(|f| f > 1.5).unwrap_or(false) {
        "Review ventilation/airflow conditions"
    } else if s.diff_pressure_pa.map(|d| d > -5.0).unwrap_or(false) {
        "Notify infection-control/HVAC team for assessment"
    } else if s.booked == Some(true) && s.occupancy == Some(0) {
        "Auto-release room after 10 min of no-show"
    } else {
        "Monitor"
    }
}

pub async fn alerts(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let threshold = q.threshold.unwrap_or(60.0);
    let vertical = effective_vertical(&user, q.vertical)?;
    let rows = fetch_rows(&state, vertical.as_deref(), None).await?;
    let now = Utc::now();
    let mut out: Vec<(f64, Value)> = Vec::new();
    for row in &rows {
        let s = room_status(row, now);
        let score = match s.score {
            Some(v) => v,
            None => continue,
        };
        let no_show = s.booked == Some(true) && s.occupancy == Some(0);
        if score >= threshold || no_show {
            let only_no_show = no_show && score < threshold;
            let detail = if no_show && (s.drivers.is_empty() || score < threshold) {
                "Booked, but no occupancy detected".to_string()
            } else {
                s.drivers.first().map(|d| format!("{}: {}", d.factor, d.value)).unwrap_or_default()
            };
            out.push((
                score,
                json!({
                    "room_id": s.id,
                    "room_name": s.name,
                    "vertical": s.vertical,
                    "score": score,
                    "status": if only_no_show { "No-Show".to_string() } else { s.status.clone().unwrap_or_default() },
                    "detail": detail,
                    "recommendation": recommendation(&s),
                    "timestamp": s.timestamp,
                }),
            ));
        }
    }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(Json(out.into_iter().map(|(_, v)| v).collect()))
}

#[derive(Deserialize)]
pub struct AnalysisQuery {
    pub minutes: Option<i64>,
}

type AnalysisRow = (
    DateTime<Utc>,
    f64,
    Option<f64>,
    Option<f64>,
    Option<f64>,
    Option<f64>,
    Option<f64>,
    Option<i32>,
    Option<f64>,
    Option<f64>,
    String,
);

/// Analysis of one room over the last N minutes (5 to 10080): statistics, time above CO2 / PM thresholds, risk bands,
/// ventilation (air changes per hour) estimated from empty-room CO2 decay, trend, sensor health and insights.
pub async fn analysis(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(room_id): Path<String>,
    Query(q): Query<AnalysisQuery>,
) -> ApiResult<Json<Value>> {
    let room: Option<(String, String, i32)> = sqlx::query_as("SELECT name, vertical, capacity FROM rooms WHERE id = $1")
        .bind(&room_id)
        .fetch_optional(&state.pool)
        .await?;
    let (name, vertical, capacity) = room.ok_or_else(|| ApiError::not_found("Room not found"))?;
    check_vertical_access(&user, Some(&vertical))?;

    let minutes = q.minutes.unwrap_or(60).clamp(5, 10080);
    let now = Utc::now();
    let since = now - chrono::Duration::minutes(minutes);
    let rows: Vec<AnalysisRow> = sqlx::query_as(
        "SELECT timestamp, co2_ppm, pm25_ugm3, pm10_ugm3, tvoc_ppb, temp_c, rh_pct, occupancy,
                diff_pressure_pa, air_velocity_ms, source
         FROM sensor_readings WHERE room_id = $1 AND timestamp >= $2
         ORDER BY timestamp ASC, id ASC LIMIT 20000",
    )
    .bind(&room_id)
    .bind(since)
    .fetch_all(&state.pool)
    .await?;

    let device_rows = rows.iter().filter(|r| r.10.starts_with("device:")).count();
    let samples: Vec<Sample> = rows
        .iter()
        .map(|r| Sample {
            t_ms: r.0.timestamp_millis(),
            co2: r.1,
            pm25: r.2,
            pm10: r.3,
            tvoc: r.4,
            temp: r.5,
            rh: r.6,
            occ: r.7,
            dp: r.8,
            air: r.9,
        })
        .collect();
    let mut out = analyze(&samples, minutes, now.timestamp_millis());
    out["room"] = json!({ "id": room_id, "name": name, "vertical": vertical, "capacity": capacity });
    out["source_mix"] = json!({ "device": device_rows, "simulator": rows.len() - device_rows });
    out["window_start"] = json!(since);
    Ok(Json(out))
}
