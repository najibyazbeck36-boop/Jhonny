#include <WiFi.h>
#include <WebServer.h>
#include <PubSubClient.h>
#include <ModbusMaster.h>
#include <ArduinoOTA.h>

// ===================== WIFI =====================
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// ===================== OTA =====================
const char* OTA_HOSTNAME = "central-command-rs485";
const char* OTA_PASSWORD = "CHANGE_THIS_PASSWORD";

// ===================== MQTT =====================
const char* MQTT_SERVER = "192.168.1.100";
const int MQTT_PORT = 1883;
const char* MQTT_USER = "";
const char* MQTT_PASS = "";

const char* MQTT_TOPIC_STATUS = "centralcommand/room1/status";
const char* MQTT_TOPIC_DATA = "centralcommand/room1/sensors";

// ===================== RS485 PINS =====================
#define RS485_TX_PIN 17
#define RS485_RX_PIN 16
#define RS485_DE_RE_PIN 4

// ===================== MODBUS SETTINGS =====================
#define MODBUS_BAUD 9600

#define PT100_ID 1
#define SHT20_ID 2

// ===================== OBJECTS =====================
HardwareSerial RS485Serial(2);
ModbusMaster node;

WiFiClient espClient;
PubSubClient mqtt(espClient);
WebServer server(80);

// ===================== SENSOR VALUES =====================
float sht20Temp = NAN;
float sht20Hum = NAN;
float pt100Temp = NAN;

bool sht20Online = false;
bool pt100Online = false;

unsigned long lastRead = 0;
unsigned long lastMqtt = 0;

const unsigned long READ_INTERVAL = 3000;
const unsigned long MQTT_INTERVAL = 5000;

// ===================== RS485 DIRECTION =====================
void preTransmission() {
  digitalWrite(RS485_DE_RE_PIN, HIGH);
  delayMicroseconds(150);
}

void postTransmission() {
  delayMicroseconds(150);
  digitalWrite(RS485_DE_RE_PIN, LOW);
}

// ===================== WIFI =====================
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting WiFi");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("WiFi connected. IP: ");
  Serial.println(WiFi.localIP());
}

// ===================== OTA =====================
void setupOTA() {
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);

  ArduinoOTA.onStart([]() {
    Serial.println("OTA Start");
  });

  ArduinoOTA.onEnd([]() {
    Serial.println("\nOTA End");
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("OTA Progress: %u%%\r", (progress * 100) / total);
  });

  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("OTA Error[%u]\n", error);
  });

  ArduinoOTA.begin();
  Serial.println("OTA ready");
}

// ===================== MQTT =====================
void connectMQTT() {
  if (mqtt.connected()) return;

  Serial.print("Connecting MQTT... ");

  String clientId = "ESP32-RS485-";
  clientId += String((uint32_t)ESP.getEfuseMac(), HEX);

  bool ok;

  if (strlen(MQTT_USER) > 0) {
    ok = mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, MQTT_TOPIC_STATUS, 0, true, "offline");
  } else {
    ok = mqtt.connect(clientId.c_str(), MQTT_TOPIC_STATUS, 0, true, "offline");
  }

  if (ok) {
    Serial.println("connected");
    mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
  } else {
    Serial.print("failed, rc=");
    Serial.println(mqtt.state());
  }
}

// ===================== READ SHT20 =====================
// Common SHT20 RS485 format:
// register 0x0001 = humidity x10
// register 0x0002 = temperature x10
bool readSHT20() {
  node.begin(SHT20_ID, RS485Serial);

  uint8_t result = node.readInputRegisters(0x0001, 2);

  if (result == node.ku8MBSuccess) {
    uint16_t rawHum = node.getResponseBuffer(0);
    int16_t rawTemp = (int16_t)node.getResponseBuffer(1);

    sht20Hum = rawHum / 10.0;
    sht20Temp = rawTemp / 10.0;
    sht20Online = true;

    Serial.print("SHT20 Temp: ");
    Serial.print(sht20Temp);
    Serial.print(" deg C | Humidity: ");
    Serial.print(sht20Hum);
    Serial.println(" %");

    return true;
  }

  sht20Online = false;
  Serial.print("SHT20 failed. Error: ");
  Serial.println(result);
  return false;
}

// ===================== READ PT100 =====================
// Based on a common PT100 RS485 module:
// register 0x0000 = temperature x10
bool readPT100() {
  node.begin(PT100_ID, RS485Serial);

  uint8_t result = node.readInputRegisters(0x0000, 1);

  if (result == node.ku8MBSuccess) {
    int16_t rawTemp = (int16_t)node.getResponseBuffer(0);

    pt100Temp = rawTemp / 10.0;
    pt100Online = true;

    Serial.print("PT100 Temp: ");
    Serial.print(pt100Temp);
    Serial.println(" deg C");

    return true;
  }

  pt100Online = false;
  Serial.print("PT100 failed. Error: ");
  Serial.println(result);
  return false;
}

// ===================== JSON HELPERS =====================
String valueOrNull(float value, int decimals = 1) {
  if (isnan(value)) return "null";
  return String(value, decimals);
}

String boolJson(bool value) {
  return value ? "true" : "false";
}

String apiJson() {
  String json = "{";
  json += "\"device\":\"central-command-rs485\",";
  json += "\"sht20_temperature\":";
  json += valueOrNull(sht20Temp, 1);
  json += ",";
  json += "\"sht20_humidity\":";
  json += valueOrNull(sht20Hum, 1);
  json += ",";
  json += "\"pt100_temperature\":";
  json += valueOrNull(pt100Temp, 1);
  json += ",";
  json += "\"sht20_online\":";
  json += boolJson(sht20Online);
  json += ",";
  json += "\"pt100_online\":";
  json += boolJson(pt100Online);
  json += ",";
  json += "\"mqtt_connected\":";
  json += boolJson(mqtt.connected());
  json += ",";
  json += "\"wifi_rssi\":";
  json += String(WiFi.RSSI());
  json += ",";
  json += "\"uptime_ms\":";
  json += String(millis());
  json += ",";
  json += "\"ip\":\"";
  json += WiFi.localIP().toString();
  json += "\"";
  json += "}";

  return json;
}

// ===================== MQTT PUBLISH =====================
void publishMQTT() {
  if (!mqtt.connected()) {
    connectMQTT();
  }

  if (mqtt.connected()) {
    String payload = apiJson();
    mqtt.publish(MQTT_TOPIC_DATA, payload.c_str(), true);

    Serial.print("MQTT publish: ");
    Serial.println(payload);
  }
}

// ===================== WEB PAGE =====================
String webPage() {
  return R"rawliteral(
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Central Command RS485 Monitor</title>
  <style>
    body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: #f4f6f3; color: #17201d; }
    main { max-width: 850px; margin: auto; }
    h1 { margin-bottom: 4px; color: #2f7068; }
    .subtitle { margin-bottom: 20px; color: #65706b; font-weight: 700; }
    .topbar, .card { border: 1px solid #dbe2dc; border-radius: 8px; background: white; box-shadow: 0 8px 22px rgba(22,32,29,0.08); }
    .topbar { padding: 12px 16px; margin-bottom: 14px; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
    .card { padding: 18px; border-left: 6px solid #2f7068; }
    .label { color: #65706b; margin-bottom: 8px; }
    .value { font-size: 34px; font-weight: 800; }
    .unit { font-size: 18px; color: #65706b; }
    .status { margin-top: 10px; font-size: 13px; font-weight: 800; }
    .online { color: #2f7d4f; }
    .offline { color: #b3453f; }
  </style>
</head>
<body>
  <main>
    <h1>Central Command</h1>
    <div class="subtitle">ESP32 + MAX485 | RS485 Modbus RTU Monitor</div>
    <div class="topbar">
      IP: <b id="ip">--</b> |
      WiFi RSSI: <b id="rssi">--</b> dBm |
      MQTT: <b id="mqtt">--</b>
    </div>
    <div class="grid">
      <div class="card">
        <div class="label">SHT20 Air Temperature</div>
        <div class="value" id="shtTemp">--</div>
        <div class="status" id="shtStatus">--</div>
      </div>
      <div class="card">
        <div class="label">SHT20 Air Humidity</div>
        <div class="value" id="shtHum">--</div>
        <div class="status" id="shtStatus2">--</div>
      </div>
      <div class="card">
        <div class="label">Compost Temperature</div>
        <div class="value" id="ptTemp">--</div>
        <div class="status" id="ptStatus">--</div>
      </div>
    </div>
  </main>
  <script>
    function showValue(id, value, unit) {
      document.getElementById(id).innerHTML =
        value === null || value === undefined || isNaN(value)
          ? "--"
          : Number(value).toFixed(1) + " <span class=\"unit\">" + unit + "</span>";
    }

    function showStatus(id, online) {
      const el = document.getElementById(id);
      el.textContent = online ? "Online" : "Offline";
      el.className = online ? "status online" : "status offline";
    }

    async function loadData() {
      try {
        const res = await fetch("/api");
        const data = await res.json();
        showValue("shtTemp", data.sht20_temperature, "deg C");
        showValue("shtHum", data.sht20_humidity, "%");
        showValue("ptTemp", data.pt100_temperature, "deg C");
        showStatus("shtStatus", data.sht20_online);
        showStatus("shtStatus2", data.sht20_online);
        showStatus("ptStatus", data.pt100_online);
        document.getElementById("ip").textContent = data.ip;
        document.getElementById("rssi").textContent = data.wifi_rssi;
        document.getElementById("mqtt").textContent = data.mqtt_connected ? "Online" : "Offline";
      } catch (error) {
        console.log(error);
      }
    }

    setInterval(loadData, 3000);
    loadData();
  </script>
</body>
</html>
)rawliteral";
}

void sendCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ===================== WEB ROUTES =====================
void setupWebServer() {
  server.on("/", HTTP_GET, []() {
    server.send(200, "text/html", webPage());
  });

  server.on("/api", HTTP_OPTIONS, []() {
    sendCorsHeaders();
    server.send(204, "text/plain", "");
  });

  server.on("/api", HTTP_GET, []() {
    sendCorsHeaders();
    server.send(200, "application/json", apiJson());
  });

  server.begin();
  Serial.println("Web server started");
}

// ===================== SETUP =====================
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(RS485_DE_RE_PIN, OUTPUT);
  digitalWrite(RS485_DE_RE_PIN, LOW);

  RS485Serial.begin(MODBUS_BAUD, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);

  node.preTransmission(preTransmission);
  node.postTransmission(postTransmission);

  connectWiFi();
  setupOTA();

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setBufferSize(512);

  setupWebServer();

  Serial.println("System ready");
}

// ===================== LOOP =====================
void loop() {
  ArduinoOTA.handle();
  server.handleClient();

  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (!mqtt.connected()) {
    connectMQTT();
  }

  mqtt.loop();

  unsigned long now = millis();

  if (now - lastRead >= READ_INTERVAL) {
    lastRead = now;

    readPT100();
    delay(200);
    readSHT20();
  }

  if (now - lastMqtt >= MQTT_INTERVAL) {
    lastMqtt = now;
    publishMQTT();
  }
}
