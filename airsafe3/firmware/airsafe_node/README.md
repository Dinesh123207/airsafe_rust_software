# AIRSAFE Sensor Node Firmware

Implements the wiring diagram you provided ("AirSafe – Complete Circuit
Connection Diagram, Without Buzzer"). Not compile-tested -- see the caveat
in the main chat response and at the top of `airsafe_node.ino`.

## Before you wire anything: the UART conflict

The ESP32 has 3 hardware UART peripherals. Your diagram puts 3 sensors on
UART (CO2, PM, Occupancy) plus USB/programming needs one — 4 consumers,
3 peripherals. This firmware resolves it as:

| Peripheral | Assigned to | Pins |
|---|---|---|
| UART0 (default) | USB / Serial monitor / flashing | untouched |
| UART2 | MH-Z19B (CO2) | GPIO16 TX / GPIO17 RX |
| UART1 | PMS5003/7003 (PM) | GPIO2 TX / GPIO4 RX |
| SoftwareSerial | HLK-LD2410 (Occupancy) | GPIO26 TX / GPIO27 RX |

**The LD2410 ships at 256000 baud by default — SoftwareSerial cannot
reliably sustain that.** One-time fix before final assembly:

1. Wire the LD2410 to a spare hardware UART temporarily (or a USB-serial adapter).
2. Send its AT command to drop the baud rate to 9600 (see the LD2410 AT-command datasheet section — command differs slightly by firmware version, look for the "baud rate config" command).
3. Verify the new rate persists after power cycle.
4. *Then* move it to GPIO26/27 for normal operation with this firmware.

Skip this and you won't get a crash — you'll get silent garbage or no data
at all, which looks exactly like a wiring fault. If occupancy readings
come back wrong once everything's assembled, this is the first thing to
check.

## Two things I flagged as unverified in the code itself

1. **XGZP6847A I2C address and register protocol** (`readDifferentialPressurePa()`)
   — I used a commonly-seen default (0x6D) and a plausible register/scaling
   pattern for this sensor family, but I don't have your exact module's
   datasheet. Confirm both against it before trusting pressure numbers.
2. **Air velocity sensor's voltage-to-m/s curve** (`readAirVelocityMs()`)
   — placeholder 1:1 mapping. Replace with your specific sensor's actual
   calibration curve.

Everything else (MH-Z19B, PMS5003/7003, SHT31, SGP30, LD2410, SSD1306) uses
well-established libraries with documented, standard interfaces, so those
are lower-risk.

## Provisioning a device (do this before flashing)

The device needs an API key before it can publish. This is a one-time step
per device, done by a logged-in admin from a machine that can reach the
backend — not something the ESP32 itself requests.

```bash
curl -X POST http://localhost:8000/api/devices/provision \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your admin JWT from /api/auth/login>" \
  -d '{"device_id":"esp32-iso1-01","room_id":"iso1","label":"Isolation 1 wall unit"}'
```

This returns the API key **once**:
```json
{"device_id":"esp32-iso1-01","room_id":"iso1","api_key":"a-long-random-string"}
```

Copy `device_id` and `api_key` into `config.h` (`DEVICE_ID` / `DEVICE_API_KEY`)
immediately — the key is hashed on the server side and cannot be retrieved
again. If you lose it, provision a new device ID.

`room_id` must already exist in the backend's seed data (see
`app/main.py`'s `ROOM_SEED`) — pick whichever room this physical unit is
being installed in.

## What happens after you flash

1. Device connects to WiFi, then POSTs a reading to `/api/ingest/reading`
   every 30 seconds (`READING_INTERVAL_MS` in config.h).
2. That reading lands in the exact same `sensor_readings` table the
   simulator writes to, tagged `source: "device:esp32-iso1-01"` instead
   of `"simulator"`.
3. The risk engine, every dashboard, and the master-admin view are
   unaware of the difference — they all just read the latest row per
   room. No frontend or scoring code changes when you go from simulated
   to real.
4. If you check `/api/rooms/iso1` right after a successful publish,
   you'll see `"source": "device:esp32-iso1-01"` in place of `"simulator"`
   — that's your confirmation the hardware path is actually live.

## Networking checklist before you flash

The backend must be started with `--host 0.0.0.0` (not the default), Windows
Firewall must allow inbound TCP 8000, and a phone on the same WiFi must be able
to open `http://<PC-LAN-IP>:8000/`. See the main README's "Connecting the ESP32 / Windows firewall"
section. After flashing, run `node tools/verify_hardware.mjs` to see your real readings.

## Local network note

`API_BASE_URL` in config.h must be your PC's **LAN IP**, not `localhost`.
On the ESP32, `localhost` means the ESP32 itself. Find your PC's LAN IP
with `ipconfig` (Windows) — look for the WiFi adapter's IPv4 address — and
make sure the ESP32 and your PC are on the same WiFi network.

## Store-and-forward on SD card

Component #10 in your wiring diagram (Micro SD, SPI) is implemented as a
buffer for network outages, not for anything else. When a publish to the
backend fails — WiFi down, backend unreachable, whatever — the reading is
appended as one line of a newline-delimited JSON file (`/queue.jsonl`) on
the SD card instead of being silently dropped. Every subsequent loop
iteration tries to flush that backlog (oldest first, in order) before
sending the current reading, so a room's history stays gap-free across a
temporary outage instead of just losing whatever happened while it was down.

The SD pins in the diagram (MOSI=23, MISO=19, SCK=18, CS=5) are exactly
ESP32's default VSPI pins, so this needed no custom SPI remapping — a
detail worth knowing if you ever repin something else onto those lines
for a different reason.

If no SD card is present, the node still runs — it just can't survive an
outage without losing whatever readings were taken during it. The OLED
shows a `Queued: N` line whenever there's an unsent backlog, so a backlog
building up is visible on the device itself, not just something you'd
notice later from a gap in the dashboard's history.

## What's still not implemented from the diagram

- **Component #12, the relay** — marked optional in your own diagram, so
  left out. If you want it: it would read the computed risk score back
  from `/api/rooms/{id}` (or replicate the threshold locally) and switch
  the relay when a configurable score is crossed. Say the word if you
  want this written up properly rather than left as a sketch.
- **Buzzer** — excluded per your diagram's own title.

