//! The Rust risk engine must reproduce the original Python engine on 504 generated cases.
use airsafe_api::risk::{compute_score, status_label};
use serde_json::Value;

fn near(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => (x - y).abs() <= 0.11, // tolerance for rounding ties (Python rounds half to even)
        _ => false,
    }
}

#[test]
fn matches_python_on_all_cases() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../fixtures/risk_parity.json")).unwrap();
    assert_eq!(cases.len(), 504);
    for c in &cases {
        let co2 = c["co2"].as_f64().unwrap();
        let pm25 = c["pm25"].as_f64().unwrap();
        let dp = c["dp"].as_f64();
        let got = compute_score(co2, pm25, dp);
        let ctx = c.to_string();
        assert!(near(Some(got.score), c["score"].as_f64()), "score for {ctx}: {}", got.score);
        assert!(near(Some(got.rebreathed_fraction_pct), c["rebreathed"].as_f64()), "rebreathed for {ctx}");
        assert!(near(Some(got.co2_component), c["co2c"].as_f64()), "co2 component for {ctx}");
        assert!(near(Some(got.pm25_penalty), c["pmp"].as_f64()), "pm penalty for {ctx}");
        assert!(near(got.pressure_penalty, c["pp"].as_f64()), "pressure penalty for {ctx}");
        assert_eq!(got.drivers.len() as u64, c["drivers"].as_u64().unwrap(), "driver count for {ctx}");
        if (got.score - c["score"].as_f64().unwrap()).abs() < 0.01 {
            assert_eq!(status_label(got.score), c["status"].as_str().unwrap(), "status for {ctx}");
        }
    }
}
