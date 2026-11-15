# Emberwatch — Smart Fire Detection & Alert System

A complete ESP32 and web dashboard prototype for the **Smart Fire Detection & Alert System** project topic. The dashboard shows live temperature and smoke-sensor readings, device connectivity, an event log, a live chart, and a full-screen alert when a configured threshold is crossed. The ESP32 independently drives its LED and buzzer, so those local alerts do not rely on the website or internet connection.

The supplied GitHub repository was empty when this work started, so this workspace contains the project scaffold.

## Hardware assumption

This firmware targets an **ESP32 DevKit V1**, an **MQ-2 analog gas/smoke sensor module**, a **DHT11 temperature/humidity sensor**, two external LEDs, and an **active buzzer driven through an NPN transistor**. The ESP32 is used because it has built-in Wi-Fi. A classic Arduino Uno does not have Wi-Fi built in and would need a separate network module plus different firmware.

The topic sheet asks for continuous sensor readings, threshold comparisons, LED/buzzer and Serial alerts, modular code, a custom header, and at least five user-defined functions. The sketch declares eight functions in `Config.h` and defines them in the `.ino` file.

## How readings reach the site

```text
MQ-2 + DHT11 → ESP32 -- HTTP POST /api/readings --> Node.js backend
                                                    │
Browser dashboard <-- server-sent events (SSE) -----┘
```

The board sends one JSON reading about every 2 seconds. The backend validates it, applies warning/fire thresholds, saves the latest reading and fire-alert history, then pushes each update to open dashboards. The device authenticates with `X-Device-Key`. The website and API are served by the same Node process. There is no Docker and no third-party Node dependency.

## Start on your local network

1. Install Node.js 18 or later.
2. In PowerShell, open this project folder and start the backend:

   ```powershell
   Copy-Item .env.example .env
   npm start
   ```

   `npm install` is not needed. The development API key is preconfigured in both the example environment and firmware. Before deploying or sharing your network, replace it with a long random value in both `.env` and `firmware/esp32_fire_alert/Config.h`.

3. Open [http://localhost:3000](http://localhost:3000) on the computer running Node.
4. Find the computer's private IPv4 address by running `ipconfig` in PowerShell. Allow Node.js on your private network if Windows Firewall asks.
5. Edit `firmware/esp32_fire_alert/Config.h`:

   ```cpp
   #define WIFI_SSID "your-2.4-GHz-network"
   #define WIFI_PASSWORD "your-wifi-password"
   #define API_URL "http://192.168.1.25:3000/api/readings"
   #define DEVICE_API_KEY "demo-key-change-before-deployment"
   ```

   Replace `192.168.1.25` with the computer's LAN address. Do not put `localhost` in `API_URL`: on the ESP32, that points back to the ESP32 itself. Keep the board and the backend computer on the same Wi-Fi network for this local setup.

6. In Arduino IDE, install Espressif's ESP32 board package, select the matching ESP32 board, then install **DHT sensor library by Adafruit** and **Adafruit Unified Sensor**.
7. Open `firmware/esp32_fire_alert/esp32_fire_alert.ino`, upload it, and open Serial Monitor at **9600 baud**. Look for `Dashboard update sent`. The dashboard refreshes itself with new readings.

The dashboard offers an **Enable alerts** action. Click it to allow browser notifications and enable an optional repeating sound in the current tab. The visual fire popup does not require this permission.

## Wiring — ESP32 DevKit V1

| Part | Connections |
| --- | --- |
| MQ-2 | VCC → 5V; GND → GND; AO → GPIO 34 through a divider |
| MQ-2 divider | AO → 10 kΩ resistor → GPIO 34; GPIO 34 → 10 kΩ resistor → GND |
| DHT11 | VCC → 3.3V; GND → GND; DATA → GPIO 4. A bare DHT11 needs a pull-up resistor from DATA to 3.3V; many modules include it. |
| Red alert LED | GPIO 18 → 220–330 Ω resistor → LED anode; LED cathode → GND |
| Green safe LED | GPIO 19 → 220–330 Ω resistor → LED anode; LED cathode → GND |
| Active buzzer | GPIO 26 → 1 kΩ resistor → NPN base; emitter → GND; collector → buzzer negative; buzzer positive → its rated supply |

All grounds must be connected together. Do not connect the MQ-2's 5 V analog output directly to an ESP32 pin. The two-resistor divider halves a 5 V output to 2.5 V. Do not drive a buzzer directly from GPIO; use the transistor, and add a flyback diode for a magnetic buzzer. Pin numbers and built-in LEDs vary by ESP32 board.

## Thresholds and sensor behavior

The starter values from your supplied sketch are:

- Temperature warning: **30°C**
- Temperature fire alert: **35°C**
- MQ-2 warning reading: **225 raw ADC**
- MQ-2 fire alert: **300 raw ADC**

The system has three states: safe, warning, and fire. Either sensor can raise the state. In warning, the red LED turns on and the buzzer beeps briefly. In fire, the red LED and buzzer pulse, then the red LED stays on for that monitoring cycle. The firmware and backend thresholds must match: update `Config.h` and the corresponding values in `.env` (`TEMP_WARNING_C`, `FIRE_TEMP_C`, `SMOKE_WARNING_RAW`, `SMOKE_RAW_THRESHOLD`). Restart Node after changing `.env` and re-upload the sketch after changing `Config.h`.

These are demo values, not validated fire limits. MQ-2 modules vary and need warm-up, baseline observation, and individual calibration. The displayed MQ-2 number is an ADC reading, **not ppm** and not calibrated smoke concentration. Never test by lighting a fire. Follow the datasheet supplied with the exact module; some manufacturer datasheets specify an initial burn-in of 24–48 hours.

## Hosting outside your Wi-Fi

For a remote dashboard, deploy this project to a service that runs Node.js and provides HTTPS. Set `PORT`, `DEVICE_API_KEY`, and the four threshold variables in that service's environment settings. Change `API_URL` in the sketch to the public HTTPS `/api/readings` endpoint, and put the host's trusted root CA PEM in `SERVER_ROOT_CA`. The firmware verifies the host certificate; it intentionally does not disable TLS checks. Do not expose your computer's local port by forwarding it through a home router.

## Project files

- `firmware/esp32_fire_alert/esp32_fire_alert.ino` — sensor sampling, threshold logic, local alarm outputs, Wi-Fi and API delivery.
- `firmware/esp32_fire_alert/Config.h` — pins, Wi-Fi, backend endpoint, thresholds, and function declarations.
- `backend/server.js` — dependency-free Node HTTP server, API, persistence, alarm state, and SSE stream.
- `public/index.html`, `public/styles.css`, `public/app.js` — responsive monitoring console and alert popup.
- `public/setup.html` — wiring and bring-up guide served by the dashboard.

## API payload

The ESP32 posts a payload similar to this to `/api/readings`:

```json
{
  "deviceId": "esp32-fire-01",
  "smokeRaw": 1260,
  "temperatureC": 28.4,
  "humidity": 46.0,
  "sensorState": 0,
  "alarmActive": false,
  "rssi": -54,
  "uptimeMs": 84320
}
```

Useful endpoints: `GET /api/health`, `GET /api/state`, `GET /api/history`, and `GET /api/stream` (SSE). Only the device POST endpoint requires the API key.

## Important use limitation

This is an educational prototype, not a life-safety product. It has no certified smoke detector, backup power, supervised wiring, redundant communications, or evaluated alarm thresholds. Keep certified smoke/fire alarms installed and follow local building and fire-safety requirements.

## References

- [Arduino-ESP32 ADC documentation](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/adc.html)
- [Winsen MQ-2 sensor information](https://www.winsentech.com/Semiconductor_Combustible_Gas_Sensor_MQ-2.html)
