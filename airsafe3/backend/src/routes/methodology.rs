use axum::Json;
use serde_json::{json, Value};

use crate::risk::{CO2_CALIBRATION, CO2_EXHALED_PPM, CO2_OUTDOOR_PPM, PM25_WHO_24H_UGM3};

pub async fn get_methodology() -> Json<Value> {
    let points: Vec<Value> = CO2_CALIBRATION
        .iter()
        .map(|(co2, idx)| json!({ "co2_ppm": co2, "index_score": idx }))
        .collect();
    Json(json!({
        "model": "CO2 rebreathed-air-fraction risk index",
        "primary_citation": "Rudnick SN, Milton DK. Risk of indoor airborne infection transmission estimated from carbon dioxide concentration. Indoor Air. 2003;13(3):237-245.",
        "formula": "f = (CO2_room - CO2_outdoor) / (CO2_exhaled - CO2_outdoor)",
        "calibration_points": points,
        "constants": {
            "co2_outdoor_ppm": CO2_OUTDOOR_PPM,
            "co2_outdoor_source": "ASHRAE Position Document on Indoor Carbon Dioxide (2025)",
            "co2_exhaled_ppm": CO2_EXHALED_PPM,
            "co2_exhaled_source": "Rudnick & Milton (2003)",
            "pm25_24h_guideline_ugm3": PM25_WHO_24H_UGM3,
            "pm25_source": "WHO Global Air Quality Guidelines (2021)"
        },
        "caveats": [
            "This index estimates ventilation-driven airborne transmission risk. It is an environmental indicator, not a clinical diagnosis or pathogen detector.",
            "The full Rudnick-Milton / Wells-Riley equation can express a literal infection probability, but only if you supply a pathogen-specific quanta generation rate (q). That value is not measurable by any sensor and varies enormously by disease -- this system deliberately does not assume one, so it reports a relative ventilation-risk index (0-100) rather than a fabricated infection probability.",
            "Differential-pressure thresholds are illustrative facility defaults, not a specific cited regulatory standard -- replace with your facility's validated commissioning target before clinical use.",
            "Readings marked source=simulator are simulated; readings with source=device:<id> come from provisioned hardware."
        ],
        "data_integrity": {
            "summary": "Device readings are hashed into an RFC 6962 Merkle ledger. Batches are signed with the server's Ed25519 key and can be anchored on an EVM chain, so stored readings cannot be silently altered afterwards. Devices that hold an Ed25519 key additionally sign every reading, proving which device produced it.",
            "what_it_proves": "That a reading existed, unchanged, no later than the anchor time; and (for signed readings) that the holder of the device key produced it.",
            "what_it_does_not_prove": "That the sensor measured the real world correctly. A faulty, miscalibrated or physically tampered sensor produces correctly signed wrong values.",
            "protocol": "docs/PROTOCOL.md"
        }
    }))
}
