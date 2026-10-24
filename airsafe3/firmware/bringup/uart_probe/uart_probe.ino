// AIRSAFE bring-up: talk to the three UART sensors directly and print what they say.
//   MH-Z19B  UART2  RX=GPIO17 (sensor TX)  TX=GPIO16 (sensor RX)  9600 baud
//   PMS5003  UART1  RX=GPIO4  (sensor TX)  TX=GPIO2  (sensor RX)  9600 baud
//   LD2410   UART2  RX=GPIO27 (sensor TX)  TX=GPIO26 (sensor RX)  baud unknown: this sketch scans for it
// A healthy sensor prints OK lines every few seconds. Silence means wiring or power, not software.

#define CO2_RX 17
#define CO2_TX 16
#define PM_RX 4
#define PM_TX 2
#define RADAR_RX 27
#define RADAR_TX 26

void probeCo2() {
  Serial2.begin(9600, SERIAL_8N1, CO2_RX, CO2_TX);
  delay(100);
  while (Serial2.available()) Serial2.read();
  const uint8_t cmd[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79};   // "read CO2 concentration"
  Serial2.write(cmd, 9);
  uint8_t r[9];
  size_t n = Serial2.readBytes(r, 9);
  if (n == 9 && r[0] == 0xFF && r[1] == 0x86) {
    uint8_t sum = 0;
    for (int i = 1; i < 8; i++) sum += r[i];
    bool good = (uint8_t)(0xFF - sum + 1) == r[8];
    Serial.printf("CO2  MH-Z19B : OK  %d ppm%s\n", r[2] * 256 + r[3], good ? "" : "  (checksum mismatch)");
    if (r[2] * 256 + r[3] == 0) Serial.println("             value 0 or 400 right after power-on is normal: warm-up takes ~3 minutes");
  } else {
    Serial.printf("CO2  MH-Z19B : NO ANSWER (%u bytes). Check 5 V + GND, sensor TX -> GPIO17, sensor RX -> GPIO16\n", (unsigned)n);
  }
  Serial2.end();
}

void probePm() {
  Serial1.begin(9600, SERIAL_8N1, PM_RX, PM_TX);
  unsigned long t0 = millis();
  uint8_t buf[32];
  int idx = 0;
  bool ok = false;
  while (millis() - t0 < 3000 && !ok) {
    if (!Serial1.available()) continue;
    uint8_t b = Serial1.read();
    if (idx == 0 && b != 0x42) continue;
    if (idx == 1 && b != 0x4D) { idx = (b == 0x42) ? 1 : 0; continue; }
    buf[idx++] = b;
    if (idx == 32) {
      uint16_t sum = 0;
      for (int i = 0; i < 30; i++) sum += buf[i];
      uint16_t chk = (buf[30] << 8) | buf[31];
      auto w = [&](int i) { return (buf[i] << 8) | buf[i + 1]; };
      Serial.printf("PM   PMS5003 : OK  PM1.0=%d PM2.5=%d PM10=%d ug/m3%s\n", w(10), w(12), w(14), sum == chk ? "" : "  (checksum mismatch)");
      ok = true;
    }
  }
  if (!ok) Serial.println("PM   PMS5003 : NO FRAME. Check 5 V + GND (fan must spin), sensor TX -> GPIO4. (SET pin: leave open or 3.3 V)");
  Serial1.end();
}

void probeRadar() {
  const long bauds[] = {256000, 9600, 19200, 38400, 57600, 115200, 230400, 460800};
  for (long baud : bauds) {
    Serial2.begin(baud, SERIAL_8N1, RADAR_RX, RADAR_TX);
    unsigned long t0 = millis();
    uint8_t h[4] = {0, 0, 0, 0};
    bool found = false;
    while (millis() - t0 < 500 && !found) {
      if (!Serial2.available()) continue;
      h[0] = h[1]; h[1] = h[2]; h[2] = h[3]; h[3] = Serial2.read();
      if (h[0] == 0xF4 && h[1] == 0xF3 && h[2] == 0xF2 && h[3] == 0xF1) found = true;   // LD2410 data frame header
    }
    Serial2.end();
    if (found) {
      Serial.printf("Occ  LD2410   : OK  data frames at %ld baud%s\n", baud,
                    baud == 9600 ? "  (this is what airsafe_node expects)" : "  -> run ld2410_set_baud to change it to 9600");
      return;
    }
  }
  Serial.println("Occ  LD2410   : NO FRAMES at any baud rate. Check 5 V + GND, sensor TX -> GPIO27, sensor RX -> GPIO26");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\nAIRSAFE UART probe: repeating every few seconds");
}

void loop() {
  probeCo2();
  probePm();
  probeRadar();
  Serial.println();
  delay(2000);
}
