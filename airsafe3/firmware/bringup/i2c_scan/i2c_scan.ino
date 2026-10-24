// AIRSAFE bring-up: I2C scanner. SDA=GPIO21, SCL=GPIO22 (shared bus: OLED, SHT31, SGP30, XGZP6847A).
#include <Wire.h>

#define SDA_PIN 21
#define SCL_PIN 22

const char *nameFor(uint8_t a) {
  switch (a) {
    case 0x3C: case 0x3D: return "SSD1306 OLED";
    case 0x44: case 0x45: return "SHT31 temperature / humidity";
    case 0x58: return "SGP30 TVOC";
    case 0x6D: return "XGZP6847A pressure (typical address; check your datasheet)";
    default: return "unknown device";
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin(SDA_PIN, SCL_PIN);
  Serial.println("\nAIRSAFE I2C scan (SDA=GPIO21, SCL=GPIO22)");
}

void loop() {
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  found 0x%02X  %s\n", a, nameFor(a));
      found++;
    }
  }
  if (found == 0) Serial.println("  nothing found: check SDA/SCL wires, 3.3 V and GND on every module");
  else Serial.printf("  %d device(s). Expected for the full build: 0x3C, 0x44, 0x58 (+ 0x6D if the pressure sensor is fitted)\n", found);
  Serial.println();
  delay(3000);
}
