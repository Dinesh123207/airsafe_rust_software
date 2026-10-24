# Notes: stack history, verification status, first run

## Stack history
Python (FastAPI + SQLite + static HTML) -> Node (Express + PostgreSQL + Next.js) -> **now: Rust (Axum + sqlx) +
PostgreSQL + Next.js + a verifiable ledger anchored on an EVM chain**. The HTTP contract of the original (paths, JSON shapes,
`{detail}` errors, device headers) is unchanged, so firmware, Wokwi path and tools carried over.

## Every feature of the Python version, and where it lives now
| Original feature | Now |
|---|---|
| Register / login / JWT, roles, vertical-scoped access, 401/403 | `backend/src/auth.rs`, `routes/auth_routes.rs` (argon2 passwords, HS256 JWT) |
| 3 verticals, 62 rooms (22 hospital, 24 hotel, 16 corporate) | `backend/data/rooms.json`, `seed.rs` |
| Rudnick-Milton risk engine with cited constants | `risk.rs` (checked against 504 cases from the Python engine) |
| `/api/methodology` | `routes/methodology.rs` |
| Rooms, history, alerts (threshold), master view | `routes/rooms.rs` |
| Device provisioning, SHA-256-hashed keys, ingestion, wrong-key and unknown-device rejection | `routes/devices.rs` |
| Mass-balance simulator, meeting no-shows | `simulator.rs` |
| Simulator stands down in rooms that have a device | `simulator.rs` (`hardware` set) |
| Stale-device detection (2+ minutes) | `models.rs::is_stale`, `devices.rs` online flag |
| Backend serves the whole frontend from one process | `STATIC_DIR` + Next.js static export (`Dockerfile`) |
| Honest LIVE badge (hardware vs simulated) | `web/components/dash/Primitives.js` |
| Login, register, master admin, devices, three dashboards | `web/app/**`, `web/components/dash/**` |
| ESP32 firmware, SD store-and-forward, UART resolution | `firmware/airsafe_node` |
| `verify_hardware` CLI, firewall checklist | `tools/verify_hardware.mjs`, `README.md` |
| Bugs found in review (poison queue, backfill timestamps, validation, core 2.x LED) | kept and fixed in firmware + `devices.rs` |

Hardware-readiness additions: partial-sensor tolerance (only CO2 is required; missing sensors are omitted, shown as '-' and reported by the analysis), a room **analysis** endpoint and panel (`/api/rooms/:id/analysis`: statistics, minutes above thresholds, risk bands, ventilation ACH from empty-room CO2 decay, trend, sensor health, insights; parity-tested against `tools/lib/analysis.mjs`), `/api/health`, boot self-test + 3-minute warm-up gate + `config_local.h` in the firmware, unverified sensors (pressure, air velocity) off by default, `tools/connect_hardware.mjs`, bring-up sketches, start/firewall scripts.

New: wallet sign-in (SIWE), device `did:key` identity and Ed25519-signed readings, RFC 6962 Merkle ledger with signed
checkpoints, EVM anchoring (`contracts/`), in-browser and CLI proof verification, signing virtual device, ledger page.

## Verification status (read this)
**Verified in this environment**
* `tools/lib/web3ref.mjs` against published vectors: Keccak-256, Ethereum addresses, the EIP-155 specification
  transaction (byte for byte), RFC 6962 / Certificate Transparency roots for 1-8 leaves, ERC-20 selector.
* Client tools end to end against an in-memory reference server (`tools/test`): signing device -> ledger leaf equality,
  proofs, tamper detection, on-chain check against a fake JSON-RPC node, bridge forwarding exact bytes, hardware check.
* Web: dashboard logic (10 unit tests); in headless Chrome: all dashboards, wallet sign-in (mock wallet), ledger page,
  device page, and in-browser Ed25519 + Merkle verification passing on a genuine proof and failing on tampering.
* Analysis engine (JavaScript reference): recovers a known ventilation rate from synthetic CO2 decay within 8 % for 2, 4 and 8 ACH; gaps, missing sensors, stuck CO2, empty windows.
* `tools/connect_hardware.mjs` setup / doctor / watch against the reference server, including the generated firmware config (string escaping, signing identity) and a simulated node reporting from that config.
* The analysis panel with the window selector and sensor-health warnings, in headless Chrome.
* Firmware preprocesses with balanced syntax in all 8 combinations of `SIM_MODE` / `TRANSPORT_SERIAL` / `DEVICE_SIGNING`.

**NOT run here (no toolchain or network in this environment)**
* **The Rust backend (including the new `analysis.rs`) has never been compiled.** It was written against well-known crate APIs and checked by careful
  review, but expect to fix a few compile errors on the first build. Its tests contain the golden vectors, so
  `cargo test` will point at exactly which function deviates from the verified JavaScript reference.
* `AirSafeAnchor.sol` (never compiled; `forge test` is provided), PostgreSQL SQL, `next build`, firmware compile, Wokwi,
  a real wallet and a real chain.

## First run, in this order
1. `cd backend && cargo test`  (no database needed: vectors, risk parity, crypto, simulator, validation)
2. `cd contracts && forge install foundry-rs/forge-std --no-commit && forge test`
3. `docker compose up --build`  then open http://localhost:8000
4. `node tools/sim_device.mjs --email <you> --password <pw> --device-id sim-1 --room iso1 --count 6 --interval 2`
5. click **Seal now** on the Ledger page, then open Isolation 1 and press **Verify this reading**;
   `node tools/verify_proof.mjs --email <you> --password <pw> --reading <id> --rpc http://localhost:8545`
If something fails, send me the compiler or runtime message and I will fix it.

## Still open from the hardware review (unchanged)
GPIO2 (boot-strapping pin) is the PMS5003 TX in the firmware; the TP4056-to-buck power path is a hardware issue; XGZP6847A
registers, air-velocity curve, LD2410 baud change and the optional relay are not done. See `docs/AirSafe_Simulation_and_Test_Guide.pdf`.

## Prototype limits
Open self-registration as master admin, permissive CORS, no rate limiting, JWT in `localStorage`, the Anvil dev key in
`docker-compose.yml` (public, worthless), server signing key stored in the database unless `SERVER_SIGNING_KEY` is set
(use a KMS/HSM in production), anchoring uses legacy transactions (fine on most EVM chains, not fee-optimal).
