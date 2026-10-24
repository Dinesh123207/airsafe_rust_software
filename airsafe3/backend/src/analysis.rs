//! Room analysis over a time window: statistics, time above thresholds, risk bands, ventilation (air changes per hour)
//! estimated from CO2 decay while the room is empty, trend, sensor health and plain-language insights.
//! Port of tools/lib/analysis.mjs; tests/analysis_vectors.rs checks it against vectors produced by that reference.
use serde_json::{json, Map, Value};

use crate::risk::{compute_score, status_label, CO2_OUTDOOR_PPM, PM25_WHO_24H_UGM3};

pub const MAX_GAP_MS: i64 = 5 * 60 * 1000; // a gap longer than this is "no data", not "the same value"
const MIN_EPISODE_MS: i64 = 10 * 60 * 1000;
const MIN_EPISODE_SAMPLES: usize = 5;
const MIN_DROP_PPM: f64 = 150.0;
const MIN_R2: f64 = 0.9;
const STUCK_RUN: usize = 10;

#[derive(Debug, Clone)]
pub struct Sample {
    pub t_ms: i64,
    pub co2: f64,
    pub pm25: Option<f64>,
    pub pm10: Option<f64>,
    pub tvoc: Option<f64>,
    pub temp: Option<f64>,
    pub rh: Option<f64>,
    pub occ: Option<i32>,
    pub dp: Option<f64>,
    pub air: Option<f64>,
}

fn r(x: f64, d: i32) -> f64 {
    let m = 10f64.powi(d);
    (x * m).round() / m
}

fn rv(x: Option<f64>, d: i32) -> Value {
    match x {
        Some(v) if v.is_finite() => json!(r(v, d)),
        _ => Value::Null,
    }
}

fn mean(a: &[f64]) -> Option<f64> {
    if a.is_empty() {
        None
    } else {
        Some(a.iter().sum::<f64>() / a.len() as f64)
    }
}

fn sorted(a: &[f64]) -> Vec<f64> {
    let mut s = a.to_vec();
    s.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    s
}

fn median(a: &[f64]) -> Option<f64> {
    if a.is_empty() {
        return None;
    }
    let s = sorted(a);
    let m = s.len() / 2;
    Some(if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 })
}

fn p95(a: &[f64]) -> Option<f64> {
    if a.is_empty() {
        return None;
    }
    let s = sorted(a);
    let idx = ((0.95 * s.len() as f64).ceil() as usize).saturating_sub(1);
    Some(s[idx.min(s.len() - 1)])
}

fn stats(values: &[Option<f64>], d: i32) -> Value {
    let v: Vec<f64> = values.iter().filter_map(|x| *x).collect();
    if v.is_empty() {
        return json!({ "min": null, "max": null, "mean": null, "p95": null, "samples": 0 });
    }
    let min = v.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    json!({ "min": r(min, d), "max": r(max, d), "mean": rv(mean(&v), d), "p95": rv(p95(&v), d), "samples": v.len() })
}

/// Least-squares line y = a + b*x; returns (b, r2).
fn linfit(xs: &[f64], ys: &[f64]) -> (f64, f64) {
    let n = xs.len();
    let mx = mean(xs).unwrap_or(0.0);
    let my = mean(ys).unwrap_or(0.0);
    let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
    for i in 0..n {
        sxx += (xs[i] - mx).powi(2);
        sxy += (xs[i] - mx) * (ys[i] - my);
        syy += (ys[i] - my).powi(2);
    }
    if sxx == 0.0 {
        return (0.0, 0.0);
    }
    let b = sxy / sxx;
    (b, if syy == 0.0 { 1.0 } else { (sxy * sxy) / (sxx * syy) })
}

fn num(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// `samples` must be ascending by time.
pub fn analyze(samples: &[Sample], window_minutes: i64, now_ms: i64) -> Value {
    let n = samples.len();
    let mut insights: Vec<String> = Vec::new();
    let mut flags: Vec<String> = Vec::new();
    if n == 0 {
        insights.push("No readings in this window yet.".to_string());
        return json!({
            "window_minutes": window_minutes, "sample_count": 0, "insights": insights, "flags": flags,
            "last_age_s": null, "median_interval_s": null, "co2": null, "pm25": null, "temperature": null,
            "humidity": null, "occupancy": null, "risk": null, "ventilation": null, "trend": null, "completeness": null
        });
    }

    let gaps: Vec<f64> = (1..n).map(|i| (samples[i].t_ms - samples[i - 1].t_ms) as f64).collect();
    let med_gap = median(&gaps).unwrap_or(30000.0);
    let dt: Vec<f64> = (0..n)
        .map(|i| {
            if i < n - 1 {
                ((samples[i + 1].t_ms - samples[i].t_ms) as f64).min(MAX_GAP_MS as f64)
            } else {
                med_gap.min(MAX_GAP_MS as f64)
            }
        })
        .collect();
    let minutes_where = |pred: &dyn Fn(&Sample) -> bool| -> f64 {
        let total: f64 = samples.iter().enumerate().map(|(i, s)| if pred(s) { dt[i] } else { 0.0 }).sum();
        r(total / 60000.0, 1)
    };

    let last_age_s = r((now_ms - samples[n - 1].t_ms) as f64 / 1000.0, 0);
    let co2_vals: Vec<Option<f64>> = samples.iter().map(|s| Some(s.co2)).collect();
    let m800 = minutes_where(&|s| s.co2 > 800.0);
    let m1000 = minutes_where(&|s| s.co2 > 1000.0);
    let m1500 = minutes_where(&|s| s.co2 > 1500.0);
    let mut co2 = stats(&co2_vals, 1);
    co2["minutes_above_800"] = json!(m800);
    co2["minutes_above_1000"] = json!(m1000);
    co2["minutes_above_1500"] = json!(m1500);

    let pm_vals: Vec<Option<f64>> = samples.iter().map(|s| s.pm25).collect();
    let m_who = minutes_where(&|s| s.pm25.map(|p| p > PM25_WHO_24H_UGM3).unwrap_or(false));
    let mut pm25 = stats(&pm_vals, 1);
    pm25["minutes_above_who"] = json!(m_who);

    let temperature = stats(&samples.iter().map(|s| s.temp).collect::<Vec<_>>(), 1);
    let humidity = stats(&samples.iter().map(|s| s.rh).collect::<Vec<_>>(), 1);

    let occ: Vec<Option<i32>> = samples.iter().map(|s| s.occ).collect();
    let occ_known: Vec<f64> = occ.iter().filter_map(|o| o.map(|v| v as f64)).collect();
    let occupancy = json!({
        "max": if occ_known.is_empty() { Value::Null } else { json!(occ_known.iter().cloned().fold(f64::NEG_INFINITY, f64::max)) },
        "mean": rv(mean(&occ_known), 2),
        "minutes_occupied": minutes_where(&|s| s.occ.map(|o| o > 0).unwrap_or(false)),
    });

    // risk index per sample, minutes in each band
    let scores: Vec<f64> = samples.iter().map(|s| compute_score(s.co2, s.pm25.unwrap_or(0.0), s.dp).score).collect();
    let mut bands: Vec<(&str, f64)> = vec![("Safe", 0.0), ("Low", 0.0), ("Moderate", 0.0), ("High", 0.0), ("Critical", 0.0)];
    for (i, sc) in scores.iter().enumerate() {
        let label = status_label(*sc);
        for b in bands.iter_mut() {
            if b.0 == label {
                b.1 += dt[i] / 60000.0;
            }
        }
    }
    let mut band_map = Map::new();
    for (k, v) in &bands {
        band_map.insert((*k).to_string(), json!(r(*v, 1)));
    }
    let band_high = r(bands[3].1, 1) + r(bands[4].1, 1);
    let risk_max = scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let risk = json!({ "mean": rv(mean(&scores), 1), "max": r(risk_max, 1), "minutes_by_band": Value::Object(band_map) });

    // ventilation: first-order CO2 decay while the room is empty
    let mut episodes: Vec<Value> = Vec::new();
    let mut ach_values: Vec<f64> = Vec::new();
    let mut reason: Option<String> = None;
    if occ_known.is_empty() {
        reason = Some("No occupancy data, so empty-room CO2 decay cannot be identified.".to_string());
    } else {
        let mut i = 0usize;
        while i < n {
            if samples[i].occ != Some(0) {
                i += 1;
                continue;
            }
            let mut j = i;
            while j + 1 < n && samples[j + 1].occ == Some(0) && samples[j + 1].t_ms - samples[j].t_ms <= MAX_GAP_MS {
                j += 1;
            }
            let mut peak = i;
            for k in i..=j {
                if samples[k].co2 > samples[peak].co2 {
                    peak = k;
                }
            }
            let seg = &samples[peak..=j];
            let span = seg[seg.len() - 1].t_ms - seg[0].t_ms;
            if seg.len() >= MIN_EPISODE_SAMPLES && span >= MIN_EPISODE_MS && seg[0].co2 - CO2_OUTDOOR_PPM >= MIN_DROP_PPM {
                let xs: Vec<f64> = seg.iter().map(|s| (s.t_ms - seg[0].t_ms) as f64 / 1000.0).collect();
                let ys: Vec<f64> = seg.iter().map(|s| (s.co2 - CO2_OUTDOOR_PPM).max(1.0).ln()).collect();
                let (b, r2) = linfit(&xs, &ys);
                let ach = -b * 3600.0;
                if b < 0.0 && r2 >= MIN_R2 && (0.05..=60.0).contains(&ach) {
                    ach_values.push(r(ach, 2));
                    episodes.push(json!({
                        "start_ms": seg[0].t_ms, "end_ms": seg[seg.len() - 1].t_ms, "minutes": r(span as f64 / 60000.0, 1),
                        "start_co2": r(seg[0].co2, 1), "end_co2": r(seg[seg.len() - 1].co2, 1), "ach": r(ach, 2), "r2": r(r2, 3)
                    }));
                }
            }
            i = j + 1;
        }
        if episodes.is_empty() {
            reason = Some("No clean empty-room CO2 decay of 10+ minutes in this window (needs the room to empty out after being occupied).".to_string());
        }
    }
    let estimated_ach = median(&ach_values);
    let ventilation = json!({ "estimated_ach": rv(estimated_ach, 2), "episodes": episodes, "note": reason });

    // trend over the last 15 minutes
    let last_t = samples[n - 1].t_ms;
    let recent: Vec<&Sample> = samples.iter().filter(|s| s.t_ms >= last_t - 15 * 60000).collect();
    let mut trend = Value::Null;
    let mut trend_slope = 0.0;
    let mut trend_minutes = 0.0;
    if recent.len() >= 3 && recent[recent.len() - 1].t_ms > recent[0].t_ms {
        let xs: Vec<f64> = recent.iter().map(|s| (s.t_ms - recent[0].t_ms) as f64 / 60000.0).collect();
        let ys: Vec<f64> = recent.iter().map(|s| s.co2).collect();
        let (b, _) = linfit(&xs, &ys);
        trend_slope = r(b, 2);
        trend_minutes = r((recent[recent.len() - 1].t_ms - recent[0].t_ms) as f64 / 60000.0, 1);
        trend = json!({ "co2_ppm_per_min": trend_slope, "minutes_used": trend_minutes });
        let _ = &trend;
    }
    let has_trend = !trend.is_null();

    // sensor health
    let pct = |f: &dyn Fn(&Sample) -> bool| -> f64 { r(samples.iter().filter(|s| f(s)).count() as f64 / n as f64 * 100.0, 1) };
    let c_pm25 = pct(&|s| s.pm25.is_some());
    let c_pm10 = pct(&|s| s.pm10.is_some());
    let c_tvoc = pct(&|s| s.tvoc.is_some());
    let c_temp = pct(&|s| s.temp.is_some());
    let c_rh = pct(&|s| s.rh.is_some());
    let c_occ = pct(&|s| s.occ.is_some());
    let c_air = pct(&|s| s.air.is_some());
    let c_dp = pct(&|s| s.dp.is_some());
    let completeness = json!({
        "pm25": c_pm25, "pm10": c_pm10, "tvoc": c_tvoc, "temperature": c_temp, "humidity": c_rh,
        "occupancy": c_occ, "air_velocity": c_air, "diff_pressure": c_dp
    });

    let mut best = 1usize;
    let mut run = 1usize;
    for k in 1..n {
        if samples[k].co2 == samples[k - 1].co2 {
            run += 1;
            best = best.max(run);
        } else {
            run = 1;
        }
    }
    if best >= STUCK_RUN {
        flags.push(format!("CO2 reading identical for {best} samples in a row: sensor may be stuck or still warming up."));
    }
    if n > 1 && c_pm25 < 50.0 {
        flags.push("PM2.5 is missing from most readings: check the PM sensor wiring.".to_string());
    }
    if n > 1 && c_occ < 50.0 {
        flags.push("Occupancy is missing from most readings: check the occupancy sensor (LD2410 baud rate).".to_string());
    }
    if n > 1 && c_temp < 50.0 {
        flags.push("Temperature/humidity are missing from most readings: check the SHT31.".to_string());
    }
    if last_age_s > 120.0 {
        flags.push(format!("Newest reading is {last_age_s} s old: the device may be offline."));
    }

    // plain-language insights
    insights.push(format!("CO2 averaged {} ppm (peak {} ppm).", num(&co2, "mean"), num(&co2, "max")));
    if m1000 > 0.0 {
        let extra = if m1500 > 0.0 { format!(" ({m1500} min above 1500 ppm)") } else { String::new() };
        insights.push(format!("CO2 was above 1000 ppm for {m1000} min{extra}: indicates poor ventilation for the occupancy."));
    } else if m800 > 0.0 {
        insights.push(format!("CO2 was above 800 ppm for {m800} min: acceptable, but ventilation margin is small."));
    } else {
        insights.push("CO2 stayed below 800 ppm: ventilation is keeping up.".to_string());
    }
    if num(&pm25, "samples") > 0.0 && m_who > 0.0 {
        insights.push(format!(
            "PM2.5 exceeded the WHO 24 h guideline ({} µg/m³) for {m_who} min (peak {} µg/m³).",
            PM25_WHO_24H_UGM3,
            num(&pm25, "max")
        ));
    }
    match estimated_ach {
        Some(a) => insights.push(format!(
            "Estimated ventilation about {} air changes/hour from {} empty-room CO2 decay episode(s). Compare with your facility's specification.",
            r(a, 2),
            episodes_len(&ventilation)
        )),
        None => insights.push(format!(
            "Ventilation rate could not be estimated: {}",
            ventilation["note"].as_str().unwrap_or("")
        )),
    }
    if has_trend && trend_slope > 5.0 {
        insights.push(format!("CO2 is rising about {trend_slope} ppm/min over the last {trend_minutes} min."));
    }
    if band_high > 0.0 {
        insights.push(format!(
            "Risk index was High or Critical for {} min (peak {}/100).",
            r(band_high, 1),
            r(risk_max, 1)
        ));
    }

    json!({
        "window_minutes": window_minutes, "sample_count": n, "insights": insights, "flags": flags,
        "last_age_s": last_age_s, "median_interval_s": r(med_gap / 1000.0, 1),
        "co2": co2, "pm25": pm25, "temperature": temperature, "humidity": humidity, "occupancy": occupancy,
        "risk": risk, "ventilation": ventilation, "trend": trend, "completeness": completeness
    })
}

fn episodes_len(v: &Value) -> usize {
    v["episodes"].as_array().map(|a| a.len()).unwrap_or(0)
}
