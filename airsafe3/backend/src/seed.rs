use serde::Deserialize;
use sqlx::PgPool;

#[derive(Debug, Clone, Deserialize)]
pub struct SeedRoom {
    pub id: String,
    pub vertical: String,
    pub name: String,
    pub department: String,
    pub tier: String,
    pub room_type: String,
    pub capacity: i32,
    pub ventilation_factor: f64,
}

pub fn rooms() -> Vec<SeedRoom> {
    serde_json::from_str(include_str!("../data/rooms.json")).expect("data/rooms.json is valid")
}

/// Inserts the 62 rooms (22 hospital, 24 hotel, 16 corporate) on first start. Returns how many were inserted.
pub async fn seed_rooms(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rooms").fetch_one(pool).await?;
    if existing > 0 {
        return Ok(0);
    }
    let list = rooms();
    let mut tx = pool.begin().await?;
    for r in &list {
        sqlx::query(
            "INSERT INTO rooms (id, vertical, name, department, tier, room_type, capacity, ventilation_factor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
        )
        .bind(&r.id)
        .bind(&r.vertical)
        .bind(&r.name)
        .bind(&r.department)
        .bind(&r.tier)
        .bind(&r.room_type)
        .bind(r.capacity)
        .bind(r.ventilation_factor)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(list.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_has_62_rooms_in_three_verticals() {
        let r = rooms();
        let n = |v: &str| r.iter().filter(|x| x.vertical == v).count();
        assert_eq!((n("hospital"), n("hotel"), n("corporate"), r.len()), (22, 24, 16, 62));
    }
}
