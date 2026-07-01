# Mushroom Farm Climate Monitor

Static GitHub Pages dashboard for an ESP32 RS485/Modbus climate node in a mushroom farm.

The dashboard shows only three cards:

- Air temperature from SHT20
- Air humidity from SHT20
- Compost temperature from PT100

It also includes an AC Control panel for a second ESP32 that sends NEOCLIMA IR commands.

The ESP32 firmware reads:

- SHT20 air temperature and humidity over Modbus RTU
- PT100 compost temperature over Modbus RTU

It publishes JSON to MQTT and exposes the same JSON at `/api`.

## Files

- `index.html` - web app shell
- `styles.css` - dashboard styling
- `app.js` - dashboard logic, MQTT WebSocket client, ESP32 API polling, demo mode
- `firmware/central-command-rs485/central-command-rs485.ino` - ESP32 firmware
- `firmware/neoclima-ir-blaster/neoclima-ir-blaster.ino` - ESP32 AC Control / IR sender firmware

## Recommended Data Path

For a GitHub Pages dashboard, use MQTT over WebSockets:

```text
ESP32 -> MQTT broker on TCP 1883 -> MQTT broker WebSocket listener -> GitHub Pages dashboard
```

Browsers cannot connect directly to normal MQTT TCP port `1883`. The broker must expose a WebSocket URL such as:

```text
wss://your-broker.example.com:8884/mqtt
ws://192.168.1.100:9001/mqtt
```

The firmware publishes to:

```text
centralcommand/room1/sensors
```

## ESP32 Setup

1. Open `firmware/central-command-rs485/central-command-rs485.ino`.
2. Copy `firmware/central-command-rs485/secrets.example.h` to `firmware/central-command-rs485/secrets.h`.
3. Set WiFi, OTA, MQTT broker, and sensor Modbus IDs.
4. In Arduino IDE, use `ESP32 Dev Module` and port `COM5` for the main controller.
5. Install these Arduino libraries:
   - `PubSubClient`
   - `ModbusMaster`
   - `ArduinoOTA` from ESP32 core
6. Flash the ESP32.
7. Confirm the serial monitor shows sensor values and MQTT publishes.

## Main Controller RS485 Wiring

The main controller on `COM5` is only the USB programming/serial-monitor connection. Modbus uses the ESP32 UART2 pins in the firmware:

```text
ESP32 GPIO17 TX2 -> RS485 DI
ESP32 GPIO16 RX2 <- RS485 RO
ESP32 GPIO4      -> RS485 DE and RE tied together
ESP32 GND       -> RS485 module GND and sensor power GND
RS485 A         -> sensor A
RS485 B         -> sensor B
```

Firmware defaults:

```text
Baud: 9600
Serial: 8N1
PT100 Modbus ID: 1
SHT20 Modbus ID: 2
```

If a sensor stays offline, swap A/B first, then confirm the Modbus ID and register map. Use a 120 ohm termination resistor at the end of a longer RS485 line.

## Live SHT20 Test

For a first SHT20-only test, upload the scanner:

```powershell
& "C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" upload -p COM5 --fqbn esp32:esp32:esp32 firmware/sht20-modbus-scanner
```

Open Serial Monitor at `115200`. A working connection prints `OK raw0=... raw1=...`.

If every line shows `fail 0xE2`, the ESP32 is timing out waiting for a reply. Check:

- Sensor has its own required power, often 5-24V, not just RS485 A/B.
- Sensor power GND, MAX485 GND, and ESP32 GND are connected together.
- ESP32 GPIO17 goes to MAX485 `DI` or `TXD`.
- ESP32 GPIO16 goes to MAX485 `RO` or `RXD`.
- ESP32 GPIO4 goes to both MAX485 `DE` and `/RE`.
- Sensor `A`/`D+` goes to MAX485 `A`, and sensor `B`/`D-` goes to MAX485 `B`.
- If it still times out, swap A and B.

After the scanner finds the sensor, upload the main firmware again:

```powershell
& "C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" upload -p COM5 --fqbn esp32:esp32:esp32 firmware/central-command-rs485
```

## Dashboard Setup

Open `index.html`, then choose `Settings`.

Use `MQTT WS` when the dashboard is hosted on GitHub Pages.

Use `ESP32 API` only when the browser can reach the ESP32 over local HTTP. GitHub Pages is HTTPS, so many browsers block direct `http://esp32-ip/api` requests from a GitHub Pages page.

The `Sensors calibration` tab stores a correction offset for each dashboard reading. The
offset is added to the raw sensor value before the value, range status, and history graph
are displayed. For example, set the PT100 offset to `+2.0` when it reads 16 C and the
reference temperature is 18 C. Set an offset back to `0` to remove that calibration.

## HiveMQ Cloud Setup

Use HiveMQ Cloud for live data on the web:

```text
ESP32 -> HiveMQ Cloud MQTT TLS 8883 -> GitHub Pages dashboard over WSS 8884
```

In HiveMQ Cloud:

1. Create a free Serverless cluster.
2. Create MQTT access credentials.
3. Copy the cluster host from the cluster connection details.
4. Put these values in local `firmware/central-command-rs485/secrets.h`:

```c
#define MQTT_SERVER_VALUE "your-cluster-host.s1.eu.hivemq.cloud"
#define MQTT_PORT_VALUE 8883
#define MQTT_USER_VALUE "your-hivemq-username"
#define MQTT_PASS_VALUE "your-hivemq-password"
#define MQTT_USE_TLS_VALUE 1
```

Then upload the main controller firmware to `COM5`.

In the web dashboard `Settings`, choose:

```text
Data source: MQTT WS
MQTT WebSocket URL: wss://your-cluster-host.s1.eu.hivemq.cloud:8884/mqtt
MQTT topic: centralcommand/room1/sensors
MQTT username: your-hivemq-username
MQTT password: your-hivemq-password
AC MQTT command topic: centralcommand/room1/ac/cmd
AC MQTT status topic: centralcommand/room1/ac/status
```

For GitHub Pages, AC control should use MQTT because browsers block HTTPS pages from calling local `http://` ESP32 URLs. The dashboard publishes AC commands to:

```text
centralcommand/room1/ac/cmd
```

The AC ESP32 publishes retained AC status to:

```text
centralcommand/room1/ac/status
```

The command payloads are the same button commands used by the dashboard, for example `on`, `off`, `temp:24`, `cool`, and `fan_high`.

## AC Control ESP Setup

1. Copy `firmware/neoclima-ir-blaster/secrets.example.h` to `firmware/neoclima-ir-blaster/secrets.h`.
2. Set WiFi, MQTT broker, MQTT credentials, and AC MQTT topics locally before flashing.
3. Install these Arduino libraries:
   - `IRremoteESP8266`
   - `ESPAsyncWebServer`
   - `AsyncTCP`
   - `PubSubClient`
4. Flash the second ESP32.
5. Open the serial monitor and confirm it prints `Connecting AC MQTT... connected`.
6. In the dashboard `Settings`, leave `AC ESP URL local HTTP` empty for GitHub Pages, or keep it only for local HTTP testing.

For direct HTTP control on the same network, open `index.html` locally or host the dashboard over HTTP and set `AC ESP URL local HTTP` to the second ESP32 address, for example `http://192.168.1.60`.

## GitHub Pages

After committing and pushing:

1. Open the repository on GitHub.
2. Go to `Settings` -> `Pages`.
3. Select `Deploy from a branch`.
4. Choose branch `main` and folder `/root`.
5. Save.

If "Beehive FTTP" means Beehive FTP hosting, this app is static. Upload `index.html`, `styles.css`, and `app.js` to the web root. If it means a Beehive IoT/MQTT service, enter its WebSocket URL, topic, username, and password in the dashboard settings.

## Safety Notes

Do not commit private WiFi passwords, MQTT passwords, or OTA passwords to a public GitHub repository. Keep secrets in local firmware before flashing, or use a private repository.
