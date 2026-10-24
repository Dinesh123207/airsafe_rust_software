//! The Rust analysis engine must reproduce the JavaScript reference (tools/lib/analysis.mjs) on the golden scenarios:
//! occupied-then-empty room with a known ventilation rate, busy room, missing sensors, stuck CO2, empty window.
use airsafe_api::analysis::{analyze, Sample};
use serde_json::Value;

fn opt(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}

fn digits_to_hash(s: &str) -> String {
    let mut out = String::new();
    let mut in_num = false;
    for c in s.chars() {
        if c.is_ascii_digit() || (in_num && c == '.') {
            if !in_num {
                out.push('#');
                in_num = true;
            }
        } else {
            in_num = false;
            out.push(c);
        }
    }
    out
}

/// Numbers match within one unit of the second decimal (the two languages round exact ties differently);
/// strings match once their numbers are masked; structure must be identical.
fn approx(path: &str, got: &Value, want: &Value) {
    match (got, want) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!((a - b).abs() <= 0.011 + 1e-9 * b.abs(), "{path}: {a} vs {b}");
        }
        (Value::String(a), Value::String(b)) => assert_eq!(digits_to_hash(a), digits_to_hash(b), "{path}: {a:?} vs {b:?}"),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length");
            for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
                approx(&format!("{path}[{i}]"), x, y);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut ka: Vec<&String> = a.keys().collect();
            let mut kb: Vec<&String> = b.keys().collect();
            ka.sort();
            kb.sort();
            assert_eq!(ka, kb, "{path}: object keys");
            for k in b.keys() {
                approx(&format!("{path}.{k}"), &a[k], &b[k]);
            }
        }
        (a, b) => assert_eq!(a, b, "{path}"),
    }
}

#[test]
fn matches_the_javascript_reference() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../fixtures/analysis_vectors.json")).unwrap();
    assert_eq!(cases.len(), 5);
    for case in &cases {
        let samples: Vec<Sample> = case["samples"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| Sample {
                t_ms: s["t_ms"].as_i64().unwrap(),
                co2: s["co2"].as_f64().unwrap(),
                pm25: opt(s, "pm25"),
                pm10: opt(s, "pm10"),
                tvoc: opt(s, "tvoc"),
                temp: opt(s, "temp"),
                rh: opt(s, "rh"),
                occ: s.get("occ").and_then(|x| x.as_i64()).map(|x| x as i32),
                dp: opt(s, "dp"),
                air: opt(s, "air"),
            })
            .collect();
        let got = analyze(&samples, case["window_minutes"].as_i64().unwrap(), case["now_ms"].as_i64().unwrap());
        approx(case["name"].as_str().unwrap(), &got, &case["expected"]);
    }
}

#[test]
fn recovers_a_known_ventilation_rate() {
    // 40 min occupied then 40 min empty with exact exponential decay at 4 air changes per hour
    let mut samples = Vec::new();
    let (mut co2, mut t) = (440.0_f64, 1_760_000_000_000_i64);
    for k in 0..160 {
        let occupied = k < 80;
        if occupied {
            co2 += (425.0 + 1100.0 - co2) * 0.05;
        } else {
            co2 = 425.0 + (co2 - 425.0) * (-4.0 * 30.0 / 3600.0_f64).exp();
        }
        samples.push(Sample { t_ms: t, co2, pm25: Some(8.0), pm10: None, tvoc: None, temp: Some(22.5), rh: Some(44.0), occ: Some(if occupied { 5 } else { 0 }), dp: None, air: None });
        t += 30_000;
    }
    let a = analyze(&samples, 90, t);
    let ach = a["ventilation"]["estimated_ach"].as_f64().expect("an estimate");
    assert!((ach - 4.0).abs() / 4.0 < 0.08, "estimated {ach}");
}
