#pragma once

// tools/connect_hardware.mjs writes config_local.h next to this file with your WiFi, API address, device id,
// key and (optionally) signing seed. Anything defined there wins; every setting below is only a default.
#if __has_include("config_local.h")
#include "config_local.h"
#endif

// ---------------- Device identity (optional, web3) ----------------
// 1 = sign every reading with an Ed25519 key that never leaves this device (header X-Device-Signature).
// The server then marks readings "attested" and the ledger proves WHICH device produced each value.
//   - needs the library  rweather/Crypto  (see wokwi/platformio.ini, env esp32_real)
//   - generate the seed:   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   - at boot the device prints its PUBLIC key (hex): paste it into "Device public key" when provisioning
//   - never commit a real seed to git
#ifndef DEVICE_SIGNING
#define DEVICE_SIGNING 0
#endif
#ifndef DEVICE_SIGNING_SEED_HEX
#define DEVICE_SIGNING_SEED_HEX "0000000000000000000000000000000000000000000000000000000000000000"
#endif

// ---------------- Test / simulation switches ----------------
// Normally set by the build (see wokwi/platformio.ini), not edited here.
//   SIM_MODE=1          -> generate fake sensor values (Wokwi, or a bench with no sensors yet)
//   TRANSPORT_SERIAL=1  -> print "AIRSAFE_JSON {...}" lines on USB serial for
//                          tools/wokwi_bridge.mjs instead of using WiFi/HTTP
#ifndef SIM_MODE
#define SIM_MODE 0
#endif
#ifndef TRANSPORT_SERIAL
#define TRANSPORT_SERIAL 0
#endif

// ---------------- WiFi ----------------
#ifndef WIFI_SSID
#define WIFI_SSID       "your-wifi-name"        // 2.4 GHz network (the ESP32 cannot use 5 GHz)
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD   "your-wifi-password"
#endif

// ---------------- AIRSAFE backend ----------------
// Point this at the AIRSAFE API (backend/, port 8000). On your dev machine this is
// http://<your-pc-LAN-IP>:8000 -- NOT "localhost", because "localhost"
// on the ESP32 means the ESP32 itself, not your PC. Find your PC's LAN
// IP with `ipconfig` (Windows) and make sure both devices are on the
// same WiFi network/subnet.
#ifndef API_BASE_URL
#define API_BASE_URL    "http://192.168.1.50:8000"
#endif

// ---------------- Device identity ----------------
// Set these from the response of POST /api/devices/provision (see
// the Devices page of the web app, or the README). The API
// key is shown ONCE at provisioning time -- copy it here immediately,
// it cannot be retrieved again afterward.
#ifndef DEVICE_ID
#define DEVICE_ID       "esp32-iso1-01"
#endif
#ifndef DEVICE_API_KEY
#define DEVICE_API_KEY  "paste-the-provisioned-key-here"
#endif

// ---------------- Real-hardware safety switches ----------------
// Warm-up: the MH-Z19B needs about 3 minutes after power-on before its CO2 value means anything. Until then the node
// shows a countdown and does NOT publish, so wrong numbers never reach the analysis. 0 = publish immediately (bench only).
#ifndef WARMUP_MS
#define WARMUP_MS 180000
#endif
// These two sensors are UNVERIFIED in this firmware, so they are OFF by default and never published until you enable them:
//  - XGZP6847A: the register layout and full-scale range are guessed (confirm against YOUR part's datasheet, test against
//    a known pressure). A wrong value would also distort the isolation-room risk score.
//  - Air velocity: the volts-to-m/s curve is a placeholder (needs your sensor's calibration table).
#ifndef ENABLE_DIFF_PRESSURE
#define ENABLE_DIFF_PRESSURE 0
#endif
#ifndef ENABLE_AIR_VELOCITY
#define ENABLE_AIR_VELOCITY 0
#endif

// ---------------- Timing ----------------
#if SIM_MODE
#define READING_INTERVAL_MS   5000    // fast cadence so simulated scenarios are watchable
#else
#define READING_INTERVAL_MS   30000   // how often to read sensors + publish
#endif
#define WIFI_RETRY_MS         10000

// ---------------- HLK-LD2410 occupancy sensor ----------------
// IMPORTANT: this sensor ships at 256000 baud by default, which is too
// fast for a reliable software-serial connection on the pins in the
// wiring diagram (GPIO26/27 -- all 3 ESP32 hardware UARTs are already
// spoken for by USB/debug, the CO2 sensor, and the PM sensor). Before
// first use, connect the LD2410 to a spare hardware UART ONE TIME and
// send its AT command to drop the baud rate to 9600, matching the
// value below. See firmware/airsafe_node/README.md "UART Resource Conflict" section.
#define LD2410_BAUD     9600

// ---------------- Simulation scenario (SIM_MODE only) ----------------
// Cycles: empty -> occupied -> PM spike -> empty. One phase lasts this long.
#define SIM_PHASE_MS    120000
