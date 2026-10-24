// AIRSAFE bring-up: switch the HLK-LD2410 from its factory 256000 baud to 9600, ONCE.
// Why: the main firmware reads the sensor through software serial (all hardware UARTs are used), which cannot keep
// up with 256000 baud. Wiring: sensor TX -> GPIO27, sensor RX -> GPIO26, 5 V, GND (same pins as airsafe_node).
// The setting is stored inside the sensor: after one successful run you never need this sketch again.
// To undo it, set kTargetIndex to 7 (256000) and run it again.
//
// LD2410 command frames:  header FD FC FB FA | length (2 bytes LE) | command word + value | tail 04 03 02 01
//   enable configuration  0x00FF  value 0x0001
//   set serial baud rate  0x00A1  value index: 1=9600 2=19200 3=38400 4=57600 5=115200 6=230400 7=256000 8=460800
//   restart module        0x00A3

#define RADAR_RX 27
#define RADAR_TX 26
const int kTargetIndex = 1;                 // 9600 baud
const long kTargetBaud = 9600;

const uint8_t HDR[4] = {0xFD, 0xFC, 0xFB, 0xFA};
const uint8_t TAIL[4] = {0x04, 0x03, 0x02, 0x01};

void sendCommand(uint16_t cmd, const uint8_t *value, uint16_t valueLen) {
  uint16_t len = 2 + valueLen;
  Serial2.write(HDR, 4);
  Serial2.write((uint8_t)(len & 0xFF));
  Serial2.write((uint8_t)(len >> 8));
  Serial2.write((uint8_t)(cmd & 0xFF));
  Serial2.write((uint8_t)(cmd >> 8));
  if (valueLen) Serial2.write(value, valueLen);
  Serial2.write(TAIL, 4);
  Serial2.flush();
}

// true if an acknowledgement frame (header FD FC FB FA) arrives within timeoutMs
bool waitAck(unsigned long timeoutMs) {
  unsigned long t0 = millis();
  uint8_t h[4] = {0, 0, 0, 0};
  while (millis() - t0 < timeoutMs) {
    if (!Serial2.available()) continue;
    h[0] = h[1]; h[1] = h[2]; h[2] = h[3]; h[3] = Serial2.read();
    if (h[0] == 0xFD && h[1] == 0xFC && h[2] == 0xFB && h[3] == 0xFA) return true;
  }
  return false;
}

bool waitDataFrame(unsigned long timeoutMs) {
  unsigned long t0 = millis();
  uint8_t h[4] = {0, 0, 0, 0};
  while (millis() - t0 < timeoutMs) {
    if (!Serial2.available()) continue;
    h[0] = h[1]; h[1] = h[2]; h[2] = h[3]; h[3] = Serial2.read();
    if (h[0] == 0xF4 && h[1] == 0xF3 && h[2] == 0xF2 && h[3] == 0xF1) return true;
  }
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\nLD2410 baud-rate setup");
  const long tryBauds[] = {256000, 9600, 19200, 38400, 57600, 115200, 230400, 460800};
  long current = 0;
  const uint8_t enableValue[2] = {0x01, 0x00};
  for (long baud : tryBauds) {
    Serial2.begin(baud, SERIAL_8N1, RADAR_RX, RADAR_TX);
    delay(100);
    while (Serial2.available()) Serial2.read();
    sendCommand(0x00FF, enableValue, 2);
    if (waitAck(400)) { current = baud; break; }
    Serial2.end();
  }
  if (current == 0) {
    Serial.println("The sensor did not answer at any baud rate: check 5 V, GND and that TX/RX are the right way round, then reset the board.");
    return;
  }
  Serial.printf("Sensor answered at %ld baud.\n", current);
  if (current == kTargetBaud) {
    Serial.println("Already at the target baud rate: nothing to change. You can flash airsafe_node now.");
    return;
  }
  const uint8_t baudValue[2] = {(uint8_t)kTargetIndex, 0x00};
  sendCommand(0x00A1, baudValue, 2);
  Serial.println(waitAck(400) ? "Baud-rate command acknowledged." : "No acknowledgement for the baud command (continuing anyway).");
  sendCommand(0x00A3, nullptr, 0);   // restart so the new rate takes effect
  waitAck(400);
  Serial2.end();
  delay(1500);

  Serial2.begin(kTargetBaud, SERIAL_8N1, RADAR_RX, RADAR_TX);
  if (waitDataFrame(4000)) Serial.printf("SUCCESS: the sensor now streams at %ld baud. Flash airsafe_node.\n", kTargetBaud);
  else Serial.println("No data at the new baud yet: power-cycle the sensor, then run uart_probe to see which baud it uses.");
}

void loop() {}
