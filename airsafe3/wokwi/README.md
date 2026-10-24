# Test the AIRSAFE node in Wokwi (no hardware)

Virtual ESP32 running the real firmware -> USB serial -> `tools/wokwi_bridge.mjs` -> Rust API -> PostgreSQL -> dashboards (and the ledger).

## One-time setup
1. VS Code + extensions: **PlatformIO IDE** and **Wokwi Simulator** (run *Wokwi: Request a new License*).
2. Open the `wokwi/` folder in VS Code (not the repo root).
3. The stack from the repo root README is running (`docker compose up --build`, then http://localhost:8000).

## Run it
1. **Provision a virtual device:** http://localhost:8000/devices -> device ID `esp32-iso1-01`, room *Isolation 1*.
   Copy the API key (shown once).
2. **Build:** PlatformIO sidebar -> `wokwi` -> Build.
3. **Start the simulation:** F1 -> *Wokwi: Start Simulator*. The OLED and RGB LED come alive and the serial
   monitor prints `AIRSAFE_JSON {...}` lines every 5 s.
4. **Bridge** (plain Node, nothing to install), from the repo root:
   `node tools/wokwi_bridge.mjs --device-id esp32-iso1-01 --device-key <KEY>`
5. **Verify:**
   `node tools/verify_hardware.mjs --email <you> --password <pw> --device-id esp32-iso1-01 --watch`
   -> verdict **REAL** (it is the firmware's data, not the server's simulator). In the Hospital dashboard,
   *Isolation 1* is tagged HARDWARE and the header reads `LIVE · 1/22 ON HARDWARE`.

The firmware cycles empty -> occupied -> PM spike -> empty every 2 minutes (`SIM_PHASE_MS` in `config.h`),
so you can watch CO2, PM and the risk score move.

## What this does and does not prove
Proves: payload format, device auth, validation, ingest, risk engine, dashboards, stale detection
(stop the simulation and wait 2 minutes), and that the readings land in the verifiable ledger (open the room, press Verify).
The Wokwi build does not sign readings (serial path); use `tools/sim_device.mjs` to exercise device signatures.
Does not prove: real sensor drivers (`SIM_MODE=1` bypasses them), WiFi/HTTP code on the ESP32,
SD buffering, power, or any electrical behaviour. Those need the `esp32_real` build on a bench.

## If Wokwi complains about the diagram
`diagram.json` was written by hand. If a pin name is rejected, delete that wire and redraw it in the editor;
the wiring to match is: OLED SDA->21, SCL->22; LED R->25, G->33, B->32 (220 ohm each), COM->GND.
