# Bring-up sketches: test one thing at a time before flashing the full firmware

Open the folder of the sketch you want in PlatformIO (or the Arduino IDE), upload, open the serial monitor at **115200**.
All of them use the same pins as `airsafe_node` (see `docs/HARDWARE_BRINGUP.md` for the wiring table).

| Sketch | Use it to |
|---|---|
| `i2c_scan` | find the OLED (0x3C), SHT31 (0x44), SGP30 (0x58) and XGZP6847A (0x6D) on the shared I2C bus |
| `uart_probe` | talk to the MH-Z19B, PMS5003 and LD2410 directly and print what each one says (and which baud rate the LD2410 is at) |
| `ld2410_set_baud` | switch the LD2410 from its factory 256000 baud to 9600, once, so the main firmware can read it |
