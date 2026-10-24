//! Room simulator: a single well-mixed zone per room, CO2 relaxing toward an occupancy-driven equilibrium
//! (first-order mass balance), plus meeting-room bookings with no-shows for corporate zones. Port of the Python
//! simulator, including its stand-down rule: a room with a provisioned device is owned by that device.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::Utc;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

use crate::risk::CO2_OUTDOOR_PPM;
use crate::seed::SeedRoom;
use crate::state::AppState;

const TICK_SECS: u64 = 5;

#[derive(Debug, Clone)]
pub struct RoomState {
    pub room_id: String,
    pub capacity: i32,
    pub ventilation_factor: f64,
    pub room_type: String,
    pub co2: f64,
    pub pm25: f64,
    pub pm10: f64,
    pub tvoc: f64,
    pub air_velocity: f64,
    pub temp: f64,
    pub rh: f64,
    pub occ: i32,
    pub dp: Option<f64>,
    pub occ_phase: f64,
    pub booked: Option<bool>,
    pub booked_timer: i32,
    pub is_no_show: bool,
}

impl RoomState {
    pub fn new(room: &SeedRoom, rng: &mut StdRng) -> Self {
        let pm25 = rng.gen_range(4.0..9.0);
        Self {
            room_id: room.id.clone(),
            capacity: room.capacity,
            ventilation_factor: room.ventilation_factor,
            room_type: room.room_type.clone(),
            co2: CO2_OUTDOOR_PPM + rng.gen_range(50.0..150.0),
            pm25,
            pm10: pm25 * 1.5,
            tvoc: 100.0,
            air_velocity: 0.2,
            temp: rng.gen_range(21.0..23.0),
            rh: rng.gen_range(40.0..48.0),
            occ: 0,
            dp: if room.room_type == "isolation" { Some(-5.0) } else { None },
            occ_phase: rng.gen_range(0.0..6.28),
            booked: if room.room_type == "meeting" { Some(false) } else { None },
            booked_timer: 0,
            is_no_show: false,
        }
    }

    fn update_booking(&mut self, rng: &mut StdRng) {
        if self.booked_timer <= 0 {
            let booked = rng.gen_bool(0.5);
            self.booked = Some(booked);
            self.booked_timer = rng.gen_range(20..=60); // roughly 100-300 s at a 5 s tick
            self.is_no_show = booked && rng.gen_bool(0.25);
        } else {
            self.booked_timer -= 1;
        }
    }

    pub fn step(&mut self, rng: &mut StdRng) {
        let meeting = self.room_type == "meeting";
        if meeting {
            self.update_booking(rng);
        }

        self.occ_phase += rng.gen_range(0.02..0.08);
        let base = (self.occ_phase.sin() + 1.0) / 2.0;
        let booked = self.booked.unwrap_or(false);
        let target: i32 = if meeting && booked && self.is_no_show {
            0 // booked, nobody shows
        } else if meeting && !booked {
            0
        } else {
            (base * self.capacity as f64 * rng.gen_range(0.6..1.0)).round() as i32
        };
        if target > self.occ {
            self.occ += 1;
        } else if target < self.occ {
            self.occ -= 1;
        }
        self.occ = self.occ.clamp(0, self.capacity.max(0));

        let per_person_load = 130.0;
        let equilibrium = CO2_OUTDOOR_PPM + (self.occ as f64 * per_person_load) / self.ventilation_factor.max(0.3);
        let relax = 0.06 * self.ventilation_factor;
        self.co2 += (equilibrium - self.co2) * relax + rng.gen_range(-6.0..6.0);
        self.co2 = self.co2.max(CO2_OUTDOOR_PPM);

        let busy = if self.occ as f64 > self.capacity as f64 * 0.7 { 0.15 } else { 0.0 };
        self.pm25 = (self.pm25 + rng.gen_range(-0.6..0.6) + busy).clamp(1.0, 60.0);
        self.temp = (self.temp + rng.gen_range(-0.08..0.08)).clamp(18.0, 27.0);
        self.rh = (self.rh + rng.gen_range(-0.4..0.4)).clamp(30.0, 68.0);

        self.pm10 = self.pm25 * rng.gen_range(1.3..1.8);
        self.tvoc = (self.pm25 * 15.0 + rng.gen_range(-30.0..30.0)).max(20.0);
        let load = self.occ as f64 / (self.capacity.max(1) as f64);
        self.air_velocity = (0.15 + load * 0.3 + rng.gen_range(-0.03..0.03)).max(0.02);
        if let Some(dp) = self.dp {
            self.dp = Some((dp + rng.gen_range(-0.3..0.3)).clamp(-12.0, 3.0));
        }
    }
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// Background loop. Rooms that have a device are skipped, so simulated and real readings never interleave.
pub async fn run(state: AppState) {
    let mut rng = StdRng::from_entropy();
    let mut states: HashMap<String, RoomState> = HashMap::new();
    let mut ticks: u64 = 0;
    loop {
        if let Err(e) = tick(&state, &mut rng, &mut states).await {
            tracing::error!("simulator tick failed: {e}");
        }
        ticks += 1;
        if ticks % 720 == 0 {
            // about hourly: keep the table from growing without bound
            let hours = state.cfg.sim_retention_hours.max(1);
            let res = sqlx::query(
                "DELETE FROM sensor_readings WHERE source = 'simulator' AND timestamp < now() - ($1 * interval '1 hour')",
            )
            .bind(hours as f64)
            .execute(&state.pool)
            .await;
            if let Err(e) = res {
                tracing::error!("simulator retention failed: {e}");
            }
        }
        tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
    }
}

async fn tick(state: &AppState, rng: &mut StdRng, states: &mut HashMap<String, RoomState>) -> Result<(), sqlx::Error> {
    if states.is_empty() {
        for room in crate::seed::rooms() {
            let st = RoomState::new(&room, rng);
            states.insert(room.id.clone(), st);
        }
    }
    let hardware: HashSet<String> = sqlx::query_scalar::<_, String>("SELECT DISTINCT room_id FROM devices")
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .collect();
    let now = Utc::now();
    let mut tx = state.pool.begin().await?;
    for (room_id, st) in states.iter_mut() {
        if hardware.contains(room_id) {
            continue;
        }
        st.step(rng);
        sqlx::query(
            "INSERT INTO sensor_readings
               (room_id, timestamp, co2_ppm, pm25_ugm3, pm10_ugm3, tvoc_ppb, air_velocity_ms,
                temp_c, rh_pct, occupancy, diff_pressure_pa, booked, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'simulator')",
        )
        .bind(room_id)
        .bind(now)
        .bind(r1(st.co2))
        .bind(r1(st.pm25))
        .bind(r1(st.pm10))
        .bind(r1(st.tvoc))
        .bind((st.air_velocity * 100.0).round() / 100.0)
        .bind(r1(st.temp))
        .bind(r1(st.rh))
        .bind(st.occ)
        .bind(st.dp.map(r1))
        .bind(st.booked)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_room_stays_in_physical_bounds() {
        let mut rng = StdRng::seed_from_u64(42);
        for room in crate::seed::rooms() {
            let mut s = RoomState::new(&room, &mut rng);
            for _ in 0..2000 {
                s.step(&mut rng);
                assert!(s.co2 >= CO2_OUTDOOR_PPM, "{} co2 {}", room.id, s.co2);
                assert!(s.occ >= 0 && s.occ <= room.capacity, "{} occ {}", room.id, s.occ);
                assert!((1.0..=60.0).contains(&s.pm25) && (18.0..=27.0).contains(&s.temp) && (30.0..=68.0).contains(&s.rh));
                match (room.room_type.as_str(), s.dp) {
                    ("isolation", Some(dp)) => assert!((-12.0..=3.0).contains(&dp)),
                    ("isolation", None) => panic!("isolation rooms have differential pressure"),
                    (_, dp) => assert!(dp.is_none()),
                }
            }
        }
    }

    #[test]
    fn co2_rises_when_occupied_and_decays_when_vacated() {
        let mut rng = StdRng::seed_from_u64(7);
        let room = SeedRoom {
            id: "x".into(),
            vertical: "hospital".into(),
            name: "x".into(),
            department: "x".into(),
            tier: "x".into(),
            room_type: "general".into(),
            capacity: 6,
            ventilation_factor: 1.0,
        };
        let mut s = RoomState::new(&room, &mut rng);
        s.occ_phase = 1.0;
        for _ in 0..25 {
            s.step(&mut rng);
        }
        let high = s.co2;
        assert!(high > 650.0, "expected CO2 to climb, got {high}");
        s.capacity = 0;
        for _ in 0..200 {
            s.step(&mut rng);
        }
        assert!(s.co2 < high - 200.0, "expected decay from {high}, got {}", s.co2);
    }
}
