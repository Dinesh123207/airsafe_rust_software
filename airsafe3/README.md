# AIRSAFE: Rust · PostgreSQL · Next.js · verifiable data on-chain

Indoor-air transmission-risk monitoring across hospital, hotel and corporate spaces, where **the sensor data itself is
tamper-evident**: device readings are signed by the device, hashed into a Merkle ledger, signed by the server, and
anchored on an EVM chain. Anyone can re-verify a reading in the browser or with a CLI, without trusting the operator.

```
ESP32 node ──HTTP POST /api/ingest/reading (API key + optional Ed25519 signature)──►  Rust API (Axum, :8000) ◄── Next.js app
 (firmware/)   Wokwi virtual node ─serial─► tools/wokwi_bridge.mjs ─────────────────►     │  serves the web app itself
                                                                                           ▼
 wallet (MetaMask…) ── Sign-In with Ethereum ──►                                     PostgreSQL
                                                                                           │ every few min: seal batch,
 anyone ◄── proof ── browser / tools/verify_proof.mjs ◄── Merkle root + signed checkpoint ─┘ sign, anchor
                                                                                           ▼
                                                                    AirSafeAnchor contract on an EVM chain (Anvil locally)
```

| Folder | What it is |
|---|---|
| `backend/` | Rust API: Axum, sqlx, JWT + argon2, risk engine, simulator, ledger worker, EVM client (no web3 library) |
| `contracts/` | `AirSafeAnchor.sol` (Foundry): public registry of Merkle roots |
| `web/` | Next.js 14: login (email or wallet), overview, devices, ledger, three themed dashboards with in-browser proof verification |
| `firmware/` | ESP32 firmware (Arduino/C++), optional Ed25519 signing |
| `wokwi/` | Wokwi + PlatformIO project: test the firmware without hardware |
| `tools/` | `connect_hardware` (setup / watch / doctor), `sim_device`, `verify_proof`, `wokwi_bridge`, `verify_hardware`, JS reference implementation of the crypto and the analysis |
| `scripts/` | one-command start (Windows PowerShell, bash) and the firewall rule |
| `docs/` | `HARDWARE_BRINGUP.md` (step by step), `PROTOCOL.md` (the integrity protocol), `INTEGRATION_NOTES.md` (feature parity, verification status, first run), simulation guide (PDF) |

## Run everything (Docker)
```bash
docker compose up --build        # PostgreSQL, local EVM chain (Anvil) + contract deploy, API serving the web app
```
Open http://localhost:8000, **Register** (email or wallet), then:
1. `node tools/sim_device.mjs --email you@x.com --password '...' --device-id sim-1 --room iso1 --count 8 --interval 2`
   provisions a virtual device with its own `did:key` and sends signed readings.
2. **Ledger** page -> *Seal now* (otherwise it seals every minute in this setup).
3. Hospital dashboard -> *Isolation 1* -> **Verify this reading**: the browser recomputes the leaf, checks the device
   signature, the Merkle proof and the server checkpoint.
4. `node tools/verify_proof.mjs --email you@x.com --password '...' --reading <id> --rpc http://localhost:8545` also asks the
   chain whether that exact root is anchored.

## Develop without Docker for the app
```bash
docker compose up -d db chain deploy          # database + local chain + contract
cd backend && cargo run                        # needs env, see backend/.env.example (DATABASE_URL etc.)
cd web && npm install && npm run dev           # http://localhost:3000, proxies /api to :8000
```

## What is web3 here, and why
| Concept | Used for |
|---|---|
| Sign-In with Ethereum (EIP-4361/EIP-191) | passwordless operator login; the server verifies the secp256k1 signature itself |
| `did:key` device identity (Ed25519) | each device holds a key that never leaves it; readings are attributable to it |
| Merkle tree (RFC 6962) + signed checkpoints | one 32-byte root commits to thousands of readings; any single reading has a short inclusion proof |
| On-chain anchoring (EVM, EIP-155 tx signed in Rust) | a public timestamp the operator cannot rewrite, at the cost of one small transaction per batch |
| Client-side verification (WebCrypto) | users check data integrity without trusting the server |
It does **not** prove a sensor read the real world correctly (see `docs/PROTOCOL.md` section 7). Simulated data is never ledgered.

## Every feature of the original Python version is kept
Auth with roles and vertical scoping, 62 rooms in three verticals, the cited Rudnick-Milton risk engine (parity-tested
against 504 cases from the Python code), alerts and history, device provisioning with hashed keys, the mass-balance simulator
that stands down where a real device exists, stale-device detection, the honest LIVE / SIMULATED badge, firmware with SD
store-and-forward, `verify_hardware`, and one process serving API and web app. Table: `docs/INTEGRATION_NOTES.md`.

## Connect your hardware (full procedure: `docs/HARDWARE_BRINGUP.md`)
```bash
.\scripts\start-windows.ps1                        # or ./scripts/start.sh : starts everything, opens the app
.\scripts\open-firewall.ps1                        # Windows, once, as Administrator
node tools/connect_hardware.mjs setup --email you@x.com --password '...' --room iso1 --wifi-ssid 'WiFi' --wifi-pass '...' --sign
cd wokwi && pio run -e esp32_real -t upload        # flash; read the SELF-TEST in the serial monitor
node tools/connect_hardware.mjs watch --email you@x.com --password '...' --room iso1     # live analysis
node tools/connect_hardware.mjs doctor ...         # if anything does not show up: tells you exactly why
```
`setup` writes `firmware/airsafe_node/config_local.h` for you (WiFi, API address, device id, key, signing identity). A node with
a failed sensor still publishes everything else; every room's detail panel has an **Analysis** section (statistics, time above
thresholds, risk bands, ventilation estimate from CO2 decay, sensor health, insights). `firmware/bringup/` has one sketch per
check (I2C scan, UART probe, LD2410 baud change).

## Connecting the real ESP32 (details)
The ESP32 talks to the API on **port 8000**, never to localhost.
1. Find your PC's LAN IP (`ipconfig`). The API listens on `0.0.0.0`.
2. Windows firewall (Administrator PowerShell):
   `New-NetFirewallRule -DisplayName "AIRSAFE API" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private`
3. A phone on the same WiFi should open `http://<LAN-IP>:8000/api/status` and see JSON.
4. Provision the device on the Devices page. Put `DEVICE_ID`, `DEVICE_API_KEY`, `API_BASE_URL=http://<LAN-IP>:8000` and WiFi in
   `firmware/airsafe_node/config.h`, flash the `esp32_real` environment (`wokwi/platformio.ini`).
   For signed readings set `DEVICE_SIGNING 1` and a seed (see `config.h`); the device prints its public key at boot, paste it
   into *Device public key* when provisioning.
5. `node tools/verify_hardware.mjs --email you@x.com --password '...' --device-id esp32-iso1-01` must say **REAL**.

## Tests
```bash
cd backend && cargo test            # vectors vs the JS reference, risk parity, crypto, simulator, validation (no DB)
cd contracts && forge test          # after: forge install foundry-rs/forge-std --no-commit
cd tools && node --test             # reference primitives + tools end to end (reference server)
cd web && npm test                  # dashboard logic + in-browser verifier on the golden vectors
```
Honest status of what has and has not been run: `docs/INTEGRATION_NOTES.md`. **The Rust code has not been compiled yet.**

## Prototype limits
Open self-registration as master admin, permissive CORS, no rate limiting, JWT in `localStorage`, public Anvil dev key in
`docker-compose.yml`, server checkpoint key kept in the database unless `SERVER_SIGNING_KEY` is set. Not for production as is.
