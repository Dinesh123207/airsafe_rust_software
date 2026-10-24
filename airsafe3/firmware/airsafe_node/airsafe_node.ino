/*
  AIRSAFE Sensor Node — ESP32 firmware
  =====================================
  Implements the wiring diagram "AirSafe – Complete Circuit Connection
  Diagram (Without Buzzer)". Reads all 7 sensor channels, shows local
  status on the OLED + RGB LED, and POSTs a reading to the AIRSAFE
  backend's /api/ingest/reading endpoint every READING_INTERVAL_MS.

  NOT COMPILE-TESTED. There's no ESP32 toolchain available in the
  environment this was written in. It's written against the real,
  named libraries below and your exact pin mapping -- but the first
  real build/flash is on your bench. If avr-gcc/esp-idf throws an
  error, send it back and it'll get fixed from the actual message
  instead of guessed at.

  Required libraries (Arduino IDE Library Manager / PlatformIO):
    - MHZ19 by strange-v
    - PMS Library by Mariusz Kacki (fu-hsi fork also works)
    - Adafruit SHT31 Library
    - Adafruit SGP30 Sensor
    - ld2410 by ncmreynolds
    - Adafruit SSD1306 + Adafruit GFX Library
    - ArduinoJson (v6 or v7)
  All available via Arduino Library Manager by name.

  ---------------------------------------------------------------
  UART RESOURCE CONFLICT -- READ BEFORE WIRING
  ---------------------------------------------------------------
  The ESP32 has exactly 3 hardware UART controllers. This diagram uses
  UART for 3 sensors (CO2, PM, Occupancy) plus USB/programming needs
  one -- that's 4 UART consumers for 3 UART peripherals.

  Resolution used in this firmware:
    UART0 (default pins)      -> USB / Serial monitor / flashing (untouched)
    UART2 (GPIO16 TX / 17 RX) -> MH-Z19B CO2 sensor (hardware UART)
    UART1 (GPIO2 TX / 4 RX)   -> PMS5003/7003 PM sensor (hardware UART)
    SoftwareSerial (GPIO26/27)-> HLK-LD2410 occupancy sensor

  The LD2410 defaults to 256000 baud, which SoftwareSerial cannot
  reliably sustain. You MUST re-flash the LD2410's own baud rate to
  9600 first (one-time, via its AT-command protocol over a temporary
  hardware UART connection) before wiring it to GPIO26/27 for normal
  operation. Skipping this step will produce garbled/no occupancy data,
  not a crash -- it will look like a wiring fault when it's a baud
  mismatch.
*/

#include "config.h"

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <time.h>

#if !SIM_MODE
#include <SoftwareSerial.h>
#include <MHZ19.h>
#include <PMS.h>
#include <Adafruit_SHT31.h>
#include <Adafruit_SGP30.h>
#include <ld2410.h>
#endif
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#if DEVICE_SIGNING
#include <Ed25519.h>            // rweather/Crypto
#include <mbedtls/base64.h>
static uint8_t devPrivate[32];
static uint8_t devPublic[32];

static bool hexToBytes(const char *hex, uint8_t *out, size_t n) {
  for (size_t i = 0; i < n; i++) {
    char pair[3] = { hex[2 * i], hex[2 * i + 1], 0 };
    char *end = nullptr;
    long v = strtol(pair, &end, 16);
    if (end != pair + 2) return false;
    out[i] = (uint8_t)v;
  }
  return true;
}

// base64url without padding, as the server expects
static String base64Url(const uint8_t *data, size_t len) {
  unsigned char buf[96];
  size_t outLen = 0;
  mbedtls_base64_encode(buf, sizeof(buf), &outLen, data, len);
  String s((const char *)buf, outLen);
  s.replace('+', '-');
  s.replace('/', '_');
  while (s.endsWith("=")) s.remove(s.length() - 1);
  return s;
}

static void initDeviceKey() {
  if (!hexToBytes(DEVICE_SIGNING_SEED_HEX, devPrivate, 32)) {
    Serial.println("DEVICE_SIGNING_SEED_HEX is not 64 hex characters: readings will be rejected if signing is required.");
    return;
  }
  Ed25519::derivePublicKey(devPublic, devPrivate);
  Serial.print("Device public key (hex, paste into provisioning): ");
  for (int i = 0; i < 32; i++) Serial.printf("%02x", devPublic[i]);
  Serial.println();
}

// Signs  "AIRSAFE-READING-V1\n" + DEVICE_ID + "\n" + the exact request body  (docs/PROTOCOL.md)
static String signReading(const String &body) {
  String prefix = String("AIRSAFE-READING-V1\n") + DEVICE_ID + "\n";
  size_t total = prefix.length() + body.length();
  uint8_t *msg = (uint8_t *)malloc(total);
  if (!msg) return "";
  memcpy(msg, prefix.c_str(), prefix.length());
  memcpy(msg + prefix.length(), body.c_str(), body.length());
  uint8_t sig[64];
  Ed25519::sign(sig, devPrivate, devPublic, msg, total);
  free(msg);
  return base64Url(sig, 64);
}
#endif

static bool oledOk = false;

// Arduino-ESP32 core 3.x has analogWrite(); core 2.x does not, so fall back to LEDC.
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  #define LED_ATTACH(pin, ch)
  #define LED_WRITE(pin, ch, v) analogWrite(pin, v)
#else
  #define LED_ATTACH(pin, ch) do { ledcSetup(ch, 5000, 8); ledcAttachPin(pin, ch); } while (0)
  #define LED_WRITE(pin, ch, v) ledcWrite(ch, v)
#endif

// ---------------- Pin map (from the wiring diagram) ----------------
#define PIN_CO2_RX      17   // MH-Z19B TX -> here
#define PIN_CO2_TX      16   // MH-Z19B RX <- here
#define PIN_PM_RX       4    // PMS5003 TX -> here
#define PIN_PM_TX       2    // PMS5003 RX <- here
#define PIN_OCC_RX      27   // LD2410 TX -> here
#define PIN_OCC_TX      26   // LD2410 RX <- here
#define PIN_I2C_SCL     22   // SHT31 / SGP30 / XGZP6847A / OLED (shared bus)
#define PIN_I2C_SDA     21
#define PIN_AIR_VEL_AO  36   // analog air-velocity sensor (ADC1_CH0)
#define PIN_LED_R       25
#define PIN_LED_G       33
#define PIN_LED_B       32

// Micro SD (SPI) -- these are ESP32's default VSPI pins, which is exactly
// what the diagram uses, so no SPI.begin() remapping is needed.
#define PIN_SD_CS       5
#define SD_QUEUE_FILE   "/queue.jsonl"
#define SD_QUEUE_TMP    "/queue.tmp"
#define SD_MAX_QUEUED_READINGS  500   // ~4 days at 30s interval; oldest dropped past this

// XGZP6847A differential pressure sensor -- I2C address per datasheet.
// [Guessing] Common default for this family is 0x6D; CONFIRM against
// your specific module's datasheet before trusting pressure readings.
#define XGZP6847A_I2C_ADDR   0x6D

// ---------------- Sensor objects ----------------
#if !SIM_MODE
HardwareSerial Co2Serial(2);
MHZ19 mhz19;

HardwareSerial PmSerial(1);
PMS pms(PmSerial);
PMS::DATA pmsData;

Adafruit_SHT31 sht31 = Adafruit_SHT31();
Adafruit_SGP30 sgp30;

SoftwareSerial OccSerial(PIN_OCC_RX, PIN_OCC_TX);
ld2410 occupancySensor;
#endif

Adafruit_SSD1306 display(128, 64, &Wire, -1);

// ---------------- State ----------------
unsigned long lastReadingAt = 0;
bool wifiWasConnected = false;
bool sdAvailable = false;

void setLed(uint8_t r, uint8_t g, uint8_t b) {
  LED_WRITE(PIN_LED_R, 0, r);
  LED_WRITE(PIN_LED_G, 1, g);
  LED_WRITE(PIN_LED_B, 2, b);
}

void connectWifi() {
#if TRANSPORT_SERIAL
  return;  // serial transport: the bridge talks to the backend, the node needs no network
#endif
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_RETRY_MS) {
    delay(300);
    Serial.print(".");
    setLed(40, 0, 40); // dim purple while connecting
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
    // NTP so each reading carries its real sample time (SD-buffered readings keep it).
    configTime(0, 0, "pool.ntp.org", "time.google.com");
  } else {
    Serial.println("WiFi connection failed, will retry next loop.");
  }
}

#if !SIM_MODE
// The LD2410 streams frames continuously; poll for ~0.6 s so a frame is certainly caught. Returns false if it never
// answered (wrong baud rate, wiring, power) so that "empty room" is never reported for a sensor that is not there.
bool readOccupancy(int &occupancy) {
  bool got = false;
  for (int i = 0; i < 20; i++) {
    if (occupancySensor.read()) got = true;
    delay(30);
  }
  if (got) occupancy = occupancySensor.presenceDetected() ? 1 : 0;
  return got;
}
#endif

// Boot checklist in plain English, so a wiring problem is found in seconds. Watch it in the serial monitor (115200).
void selfTest() {
  Serial.println("\n=========== AIRSAFE SELF-TEST ===========");
#if !SIM_MODE
  delay(1500);  // let the UART sensors deliver their first frames
  float c = mhz19.getCO2();
  Serial.printf("CO2  MH-Z19B  (UART2 RX=GPIO%d TX=GPIO%d): %s\n", PIN_CO2_RX, PIN_CO2_TX,
                c > 0 ? "OK" : "NO ANSWER -> 5 V present? sensor TX goes to GPIO17, sensor RX to GPIO16");
  pms.requestRead();
  bool pmOk = pms.readUntil(pmsData, 3000);
  Serial.printf("PM   PMS5003  (UART1 RX=GPIO%d TX=GPIO%d): %s\n", PIN_PM_RX, PIN_PM_TX,
                pmOk ? "OK" : "NO ANSWER -> 5 V present? fan spinning? sensor TX goes to GPIO4, sensor RX to GPIO2");
  float t = sht31.readTemperature();
  Serial.printf("T/RH SHT31    (I2C 0x44): %s\n", isnan(t) ? "NOT FOUND -> SDA=GPIO21 SCL=GPIO22, 3.3 V, address pin (run firmware/bringup/i2c_scan)" : "OK");
  Serial.printf("TVOC SGP30    (I2C 0x58): %s\n", sgp30.IAQmeasure() ? "OK" : "NOT FOUND -> SDA=GPIO21 SCL=GPIO22, 3.3 V");
  int occ = 0;
  Serial.printf("Occupancy LD2410 (soft-serial RX=GPIO%d TX=GPIO%d at %d baud): %s\n", PIN_OCC_RX, PIN_OCC_TX, LD2410_BAUD,
                readOccupancy(occ) ? "OK" : "NO FRAMES -> baud must be 9600 (run firmware/bringup/ld2410_set_baud once), 5 V, TX/RX");
  Serial.printf("XGZP6847A pressure: %s | Air velocity: %s\n", ENABLE_DIFF_PRESSURE ? "enabled (UNVERIFIED registers)" : "off (unverified, see config.h)",
                ENABLE_AIR_VELOCITY ? "enabled (placeholder curve)" : "off (needs calibration, see config.h)");
#else
  Serial.println("SIM_MODE: sensors are simulated.");
#endif
  Serial.printf("OLED SSD1306 (I2C 0x3C): %s | microSD: %s\n", oledOk ? "OK" : "NOT FOUND", sdAvailable ? "OK" : "not found (no offline buffering)");
#if !TRANSPORT_SERIAL
  Serial.printf("WiFi: %s", WiFi.status() == WL_CONNECTED ? "connected" : "NOT CONNECTED -> SSID/password right? 2.4 GHz network?");
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("  IP %s  signal %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    HTTPClient http;
    http.begin(String(API_BASE_URL) + "/api/health");
    http.setTimeout(5000);
    int code = http.GET();
    if (code == 200) Serial.printf("API  %s: reachable\n", API_BASE_URL);
    else if (code > 0) Serial.printf("API  %s: answered HTTP %d (is this the AIRSAFE API?)\n", API_BASE_URL, code);
    else Serial.printf("API  %s: UNREACHABLE (%s) -> use the PC's LAN IP, open firewall port 8000, same WiFi as the PC\n", API_BASE_URL, HTTPClient::errorToString(code).c_str());
    http.end();
  } else {
    Serial.println();
  }
#endif
  Serial.println("=========================================\n");
}

void setup() {
  Serial.begin(115200);
#if DEVICE_SIGNING
  initDeviceKey();
#endif
  delay(200);
  Serial.println("\nAIRSAFE sensor node starting...");

  // I2C bus -- shared by SHT31, SGP30, XGZP6847A, OLED
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

#if !SIM_MODE
  // CO2 (hardware UART2)
  Co2Serial.begin(9600, SERIAL_8N1, PIN_CO2_RX, PIN_CO2_TX);
  mhz19.begin(Co2Serial);
  mhz19.autoCalibration(false); // set true only if this device will see fresh outdoor air daily

  // PM (hardware UART1)
  PmSerial.begin(9600, SERIAL_8N1, PIN_PM_RX, PIN_PM_TX);
  pms.passiveMode(); // we request a read each cycle instead of continuous streaming

  // Temp/RH
  if (!sht31.begin(0x44)) {
    Serial.println("WARNING: SHT31 not found on I2C bus");
  }

  // TVOC
  if (!sgp30.begin()) {
    Serial.println("WARNING: SGP30 not found on I2C bus");
  }

  // Occupancy (SoftwareSerial -- see baud-rate note in config.h)
  OccSerial.begin(LD2410_BAUD);
  if (!occupancySensor.begin(OccSerial)) {
    Serial.println("WARNING: LD2410 did not respond -- check baud rate (see config.h)");
  }

#else
  Serial.println("SIM_MODE: generating fake sensor values (no sensor libraries active)");
#endif

  // OLED
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) {
    Serial.println("WARNING: SSD1306 OLED not found on I2C bus");
  } else {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("AIRSAFE");
    display.println("Starting...");
    display.display();
  }

  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  LED_ATTACH(PIN_LED_R, 0);
  LED_ATTACH(PIN_LED_G, 1);
  LED_ATTACH(PIN_LED_B, 2);
  setLed(0, 0, 60); // blue = booting

  // Micro SD -- used as a store-and-forward buffer when WiFi/backend is
  // unreachable, not for anything else. If it's not present, the node
  // still works; it just can't survive a network outage without losing
  // readings taken during the outage.
  sdAvailable = SD.begin(PIN_SD_CS);
  if (!sdAvailable) {
    Serial.println("WARNING: SD card not found -- readings taken during a network outage will be lost, not buffered.");
  }

  connectWifi();
  selfTest();
}

// Reads the XGZP6847A over I2C. [Guessing] register layout based on the
// common XGZP68xx family pattern (2 bytes pressure, MSB first, plus a
// status bit) -- CONFIRM against your module's actual datasheet. This
// is the piece of this firmware I'm least confident is exactly right;
// treat the returned Pa value as unverified until checked against a
// known reference pressure.
float readDifferentialPressurePa() {
  Wire.beginTransmission(XGZP6847A_I2C_ADDR);
  Wire.write(0x06); // convert command -- CONFIRM against datasheet
  Wire.endTransmission();
  delay(20);

  Wire.requestFrom(XGZP6847A_I2C_ADDR, 3);
  if (Wire.available() < 3) return NAN;
  uint8_t status = Wire.read();
  uint16_t raw = (Wire.read() << 8) | Wire.read();
  (void)status;
  // Typical XGZP68xx scaling: raw counts over a +/-6894 Pa (1 psi) full
  // scale range, centered at zero. CONFIRM full-scale range for your
  // exact part number (this family ships in multiple pressure ranges).
  float pa = ((float)raw - 32768.0) / 32768.0 * 6894.0;
  return pa;
}

float readAirVelocityMs() {
  int raw = analogRead(PIN_AIR_VEL_AO);       // 0-4095 on ESP32 ADC
  float voltage = raw / 4095.0 * 3.3;
  // Placeholder linear mapping -- replace with your specific air-velocity
  // sensor's actual voltage-to-m/s curve from its datasheet.
  float ms = voltage * 1.0;
  return ms;
}

String buildReadingJson(float co2, float pm25, float pm10, float tvoc,
                        float temp, float rh, int occupancy,
                        float diffPressure, float airVelocity) {
  JsonDocument doc;
  // Only what was actually measured goes on the wire. The backend needs CO2; every other field is optional, so a node
  // with one failed or not-yet-wired sensor still reports the rest (and the app shows exactly what is missing).
  doc["co2_ppm"] = co2;
  if (!isnan(pm25)) doc["pm25_ugm3"] = pm25;
  if (!isnan(pm10)) doc["pm10_ugm3"] = pm10;
  if (!isnan(tvoc)) doc["tvoc_ppb"] = tvoc;
  if (!isnan(temp)) doc["temp_c"] = temp;
  if (!isnan(rh)) doc["rh_pct"] = rh;
  if (occupancy >= 0) doc["occupancy"] = occupancy;
  if (!isnan(diffPressure)) doc["diff_pressure_pa"] = diffPressure;
  if (!isnan(airVelocity)) doc["air_velocity_ms"] = airVelocity;
  doc["firmware_version"] = "0.3.0";
  time_t nowEpoch = time(nullptr);
  if (nowEpoch > 1700000000) doc["ts"] = (uint32_t)nowEpoch;  // only once NTP has synced

  String body;
  serializeJson(doc, body);
  return body;
}

// Result of one publish attempt.
//   POST_OK        accepted (HTTP 200)
//   POST_RETRY     network/server/auth problem -- keep the reading and try again later
//   POST_REJECTED  backend permanently refused THIS reading (HTTP 4xx such as 422
//                  out-of-range). Retrying can never succeed, so it must be dropped:
//                  otherwise one bad queued line blocks every reading behind it forever.
// (plain int + #defines, not an enum: the Arduino/PlatformIO .ino preprocessor inserts function
// prototypes above custom types, which breaks enum return types.)
#define POST_RETRY     0
#define POST_OK        1
#define POST_REJECTED -1

// Posts a pre-built JSON body. Used both for a fresh reading and for
// replaying a line out of the SD queue -- same wire format either way.
int postJsonBody(const String &body) {
#if TRANSPORT_SERIAL
  // Bridge mode: one line on USB serial, forwarded to the backend by tools/wokwi_bridge.mjs.
  Serial.print("AIRSAFE_JSON ");
  Serial.println(body);
  return POST_OK;
#else
  if (WiFi.status() != WL_CONNECTED) return POST_RETRY;

  HTTPClient http;
  http.begin(String(API_BASE_URL) + "/api/ingest/reading");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
#if DEVICE_SIGNING
  http.addHeader("X-Device-Signature", signReading(body));   // over the exact bytes POSTed below
#endif
  http.setTimeout(8000);

  int status = http.POST(body);
  int result = POST_RETRY;
  if (status == 200) {
    result = POST_OK;
  } else {
    Serial.printf("Publish failed, HTTP status %d: %s\n", status, http.getString().c_str());
    if (status == 401) Serial.println("  -> The API rejected this device: re-copy DEVICE_ID and DEVICE_API_KEY (tools/connect_hardware.mjs writes them), or the signing key does not match the registered public key.");
    else if (status < 0) Serial.println("  -> Could not reach the API: check API_BASE_URL (the PC's LAN IP, not localhost), that the PC firewall allows port 8000, and that the PC and the ESP32 are on the same WiFi.");
    // 401/403 = wrong device key (a config problem the owner can fix, so keep the data);
    // 408/429 = transient. Any other 4xx means this exact payload is invalid.
    if (status >= 400 && status < 500 && status != 401 && status != 403 && status != 408 && status != 429) {
      result = POST_REJECTED;
    }
  }
  http.end();
  return result;
#endif
}

// Appends one JSON line to the SD queue file. Each line is a complete,
// independent reading -- .jsonl (newline-delimited JSON), not a single
// JSON array, so a partial write from a power loss mid-append only
// corrupts the last line, not the whole file.
void bufferToSD(const String &body) {
  if (!sdAvailable) {
    Serial.println("Reading lost -- publish failed and no SD card to buffer to.");
    return;
  }
  File f = SD.open(SD_QUEUE_FILE, FILE_APPEND);
  if (!f) {
    Serial.println("WARNING: could not open SD queue file for append -- reading lost.");
    return;
  }
  f.println(body);
  f.close();
  Serial.println("Buffered reading to SD (backend unreachable).");
}

// Counts lines in the queue file -- used to cap growth if a device is
// offline for a very long time (drops oldest readings past the cap
// rather than filling the card or growing an unbounded backlog).
int countSDQueueLines() {
  if (!sdAvailable || !SD.exists(SD_QUEUE_FILE)) return 0;
  File f = SD.open(SD_QUEUE_FILE, FILE_READ);
  if (!f) return 0;
  int count = 0;
  while (f.available()) { if (f.readStringUntil('\n').length() > 0) count++; }
  f.close();
  return count;
}

// Replays buffered readings, oldest first, stopping at the first failure
// (backend is still down, or came back up but dropped again mid-flush --
// either way, stop rather than reordering or losing track of position).
// Successfully-sent lines are removed by rewriting the file without them.
void flushSDQueue() {
#if TRANSPORT_SERIAL
  return;  // no SD queue in bridge mode
#endif
  if (!sdAvailable || WiFi.status() != WL_CONNECTED) return;
  if (!SD.exists(SD_QUEUE_FILE)) return;

  int total = countSDQueueLines();
  if (total == 0) return;
  if (total > SD_MAX_QUEUED_READINGS) {
    Serial.printf("SD queue has %d readings (cap %d) -- oldest will be dropped as newer ones are written.\n",
                  total, SD_MAX_QUEUED_READINGS);
  }

  File in = SD.open(SD_QUEUE_FILE, FILE_READ);
  if (!in) return;
  File out = SD.open(SD_QUEUE_TMP, FILE_WRITE);
  if (!out) { in.close(); return; }

  bool stillFailing = false;
  int sent = 0, kept = 0;
  while (in.available()) {
    String line = in.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    if (!stillFailing) {
      int r = postJsonBody(line);
      if (r == POST_OK) {
        sent++;
        continue; // don't copy to `out` -- it's been sent
      } else if (r == POST_REJECTED) {
        Serial.println("Dropped an unacceptable queued reading (backend rejected it permanently).");
        continue; // poison line: discard so it cannot block the readings behind it
      } else {
        stillFailing = true; // stop trying further lines this cycle, preserve order
      }
    }
    out.println(line);
    kept++;
  }
  in.close();
  out.close();

  SD.remove(SD_QUEUE_FILE);
  if (kept > 0) {
    SD.rename(SD_QUEUE_TMP, SD_QUEUE_FILE);
  } else {
    SD.remove(SD_QUEUE_TMP);
  }
  if (sent > 0) Serial.printf("Flushed %d buffered reading(s) from SD, %d remaining.\n", sent, kept);
}

bool publishReading(float co2, float pm25, float pm10, float tvoc,
                     float temp, float rh, int occupancy,
                     float diffPressure, float airVelocity) {
  String body = buildReadingJson(co2, pm25, pm10, tvoc, temp, rh, occupancy, diffPressure, airVelocity);

  // Try to clear any backlog first so buffered readings stay in order
  // ahead of this new one.
  flushSDQueue();

  int r = postJsonBody(body);
  if (r == POST_RETRY) {
    bufferToSD(body);
  } else if (r == POST_REJECTED) {
    Serial.println("Reading rejected by backend (out of range?) -- dropped, not buffered.");
  }
  return r == POST_OK;
}

void updateDisplay(float co2, float pm25, int occupancy, bool published, int queued) {
  if (!oledOk) return;
  display.clearDisplay();
  display.setCursor(0, 0);
  display.setTextSize(1);
  if (isnan(co2)) display.println("CO2:  --"); else display.printf("CO2:  %.0f ppm\n", co2);
  if (isnan(pm25)) display.println("PM2.5:--"); else display.printf("PM2.5:%.0f ug/m3\n", pm25);
  if (occupancy < 0) display.println("Occ:  --"); else display.printf("Occ:  %d\n", occupancy);
  display.printf("Link: %s\n", WiFi.status() == WL_CONNECTED ? "OK" : "--");
  display.printf("Sync: %s\n", published ? "OK" : "FAIL");
  if (queued > 0) display.printf("Queued: %d\n", queued);
  display.display();
}

#if SIM_MODE
// Fake room used by Wokwi / sensor-less bench runs. Mirrors the idea in the
// backend's simulator: CO2 relaxes toward an occupancy-driven equilibrium.
// Phases repeat every SIM_PHASE_MS: empty -> occupied -> PM spike -> empty.
void simulateReadings(float &co2, float &pm25, float &pm10, float &tvoc, float &temp,
                      float &rh, int &occupancy, float &diffPressure, float &airVelocity) {
  static float simCo2 = 450.0f;
  int phase = (millis() / SIM_PHASE_MS) % 4;
  occupancy = (phase == 1 || phase == 2) ? 4 : 0;
  float target = 420.0f + occupancy * 260.0f;
  simCo2 += (target - simCo2) * 0.18f + ((int)random(-8, 9));
  if (simCo2 < 400) simCo2 = 400;
  co2 = simCo2;
  pm25 = (phase == 2 ? 120.0f : 8.0f) + (int)random(-2, 3);
  if (pm25 < 0) pm25 = 0;
  pm10 = pm25 * 1.6f;
  tvoc = 90.0f + occupancy * 40.0f + (int)random(-10, 11);
  temp = 22.0f + occupancy * 0.4f;
  rh = 45.0f;
  diffPressure = -5.0f;
  airVelocity = 0.3f;
}
#endif

void loop() {
  connectWifi();

  if (millis() - lastReadingAt < READING_INTERVAL_MS && lastReadingAt != 0) {
    delay(200);
    return;
  }
  lastReadingAt = millis();

#if SIM_MODE
  float co2, pm25, pm10, tvoc, temp, rh, diffPressure, airVelocity;
  int occupancy;
  simulateReadings(co2, pm25, pm10, tvoc, temp, rh, occupancy, diffPressure, airVelocity);
#else
  if (WARMUP_MS > 0 && millis() < WARMUP_MS) {
    unsigned long left = (WARMUP_MS - millis()) / 1000;
    Serial.printf("Warming up sensors (MH-Z19B needs about 3 min): %lu s left, not publishing yet.\n", left);
    if (oledOk) {
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println("AIRSAFE");
      display.println("Warming up sensors");
      display.printf("%lu s left\n", left);
      display.display();
    }
    setLed(40, 0, 40);
    return;
  }

  // ---- CO2 ----
  float co2 = mhz19.getCO2();
  if (co2 <= 0) co2 = NAN;

  // ---- PM ----
  float pm25 = NAN, pm10 = NAN;
  pms.requestRead();
  if (pms.readUntil(pmsData, 2000)) {
    pm25 = pmsData.PM_AE_UG_2_5;
    pm10 = pmsData.PM_AE_UG_10_0;
  }

  // ---- Temp / RH ----
  float temp = sht31.readTemperature();
  float rh = sht31.readHumidity();

  // ---- TVOC (needs temp/RH compensation for accuracy) ----
  float tvoc = NAN;
  if (!isnan(temp) && !isnan(rh)) {
    sgp30.setHumidity(getAbsoluteHumidity(temp, rh));
  }
  if (sgp30.IAQmeasure()) {
    tvoc = sgp30.TVOC;
  }

  // ---- Occupancy ----
  int occupancy = -1;                 // -1 = not measured (sensor silent): omitted, never reported as "empty"
  readOccupancy(occupancy);
  // LD2410 reports presence, not a headcount. If your protocol needs a
  // real count (not just occupied/vacant), that requires a different
  // sensor class (e.g. a ToF array) -- flag this if room-level headcount
  // beyond "someone is here" matters for your use case.

  // ---- Differential pressure / air velocity: unverified, only if enabled in config.h ----
  float diffPressure = NAN;
  float airVelocity = NAN;
#if ENABLE_DIFF_PRESSURE
  diffPressure = readDifferentialPressurePa();
  if (!isnan(diffPressure) && fabsf(diffPressure) > 2000.0f) diffPressure = NAN;   // out of the API's accepted range: do not poison the reading
#endif
#if ENABLE_AIR_VELOCITY
  airVelocity = readAirVelocityMs();
#endif

#endif

  Serial.printf("CO2=%.0f PM2.5=%.0f PM10=%.0f TVOC=%.0f T=%.1f RH=%.1f Occ=%d DP=%.1f AV=%.2f\n",
                co2, pm25, pm10, tvoc, temp, rh, occupancy, diffPressure, airVelocity);

  bool published = false;
  if (!isnan(co2)) {
    // CO2 is the one essential value; anything else that failed is simply left out (see the self-test at boot).
    published = publishReading(co2, pm25, pm10, tvoc, temp, rh, occupancy, diffPressure, airVelocity);
  } else {
    Serial.println("Skipping publish -- no CO2 reading (MH-Z19B silent: check 5 V and the TX/RX wires)");
  }

  updateDisplay(co2, pm25, occupancy, published, countSDQueueLines());

  // Status LED: green = published OK, amber = read OK but publish failed
  // (WiFi/backend issue), red = sensor read failure.
  if (published) setLed(0, 60, 0);
  else if (!isnan(co2)) setLed(60, 40, 0);
  else setLed(60, 0, 0);
}

// SGP30 needs absolute humidity in mg/m^3, not relative humidity -- this
// is the standard conversion from the Adafruit SGP30 example code.
uint32_t getAbsoluteHumidity(float temperature, float humidity) {
  const float absoluteHumidity = 216.7f * ((humidity / 100.0f) * 6.112f *
      exp((17.62f * temperature) / (243.12f + temperature)) / (273.15f + temperature));
  return static_cast<uint32_t>(1000.0f * absoluteHumidity);
}
