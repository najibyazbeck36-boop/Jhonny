# Mushroom Farm Climate Monitor

Static GitHub Pages dashboard for an ESP32 RS485/Modbus climate node in a mushroom farm.

The dashboard shows only three cards:

- Air temperature from SHT20
- Air humidity from SHT20
- Compost temperature from PT100

It also includes a NEOCLIMA AC control panel for a second ESP32 IR blaster.

The ESP32 firmware reads:

- SHT20 air temperature and humidity over Modbus RTU
- PT100 compost temperature over Modbus RTU

It publishes JSON to MQTT and exposes the same JSON at `/api`.

## Files

- `index.html` - web app shell
- `styles.css` - dashboard styling
- `app.js` - dashboard logic, MQTT WebSocket client, ESP32 API polling, demo mode
- `firmware/central-command-rs485/central-command-rs485.ino` - ESP32 firmware
- `firmware/neoclima-ir-blaster/neoclima-ir-blaster.ino` - ESP32 IR blaster firmware

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
2. Set WiFi, OTA, MQTT broker, and sensor Modbus IDs.
3. Install these Arduino libraries:
   - `PubSubClient`
   - `ModbusMaster`
   - `ArduinoOTA` from ESP32 core
4. Flash the ESP32.
5. Confirm the serial monitor shows sensor values and MQTT publishes.

## Dashboard Setup

Open `index.html`, then choose `Settings`.

Use `MQTT WS` when the dashboard is hosted on GitHub Pages.

Use `ESP32 API` only when the browser can reach the ESP32 over local HTTP. GitHub Pages is HTTPS, so many browsers block direct `http://esp32-ip/api` requests from a GitHub Pages page.

Set `IR Blaster URL` to the second ESP32 address, for example:

```text
http://192.168.1.60
```

The dashboard calls:

```text
GET /status
GET /cmd?c=on
GET /cmd?c=temp:24
```

The IR firmware in this repo has CORS headers enabled so the dashboard can call it from another web page.

## IR Blaster Setup

1. Open `firmware/neoclima-ir-blaster/neoclima-ir-blaster.ino`.
2. Set WiFi credentials locally before flashing.
3. Install these Arduino libraries:
   - `IRremoteESP8266`
   - `ESPAsyncWebServer`
   - `AsyncTCP`
4. Flash the second ESP32.
5. Open the serial monitor and copy the printed `IR Blaster IP`.
6. Paste that address into dashboard `Settings` -> `IR Blaster URL`.

If the dashboard is loaded from GitHub Pages over HTTPS, direct commands to a local `http://` ESP32 can be blocked by the browser. For direct HTTP control, open `index.html` locally or host the dashboard over HTTP on the same network. For public HTTPS control, put the IR blaster behind an HTTPS endpoint or add an MQTT command bridge.

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
