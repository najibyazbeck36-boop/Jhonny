#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <PubSubClient.h>
#include <ModbusMaster.h>
#include <ArduinoOTA.h>
#include <Preferences.h>

#if __has_include("secrets.h")
#include "secrets.h"
#endif

// ===================== WIFI =====================
#ifndef WIFI_SSID_VALUE
#define WIFI_SSID_VALUE "YOUR_WIFI_NAME"
#endif

#ifndef WIFI_PASS_VALUE
#define WIFI_PASS_VALUE "YOUR_WIFI_PASSWORD"
#endif

const char* WIFI_SSID = WIFI_SSID_VALUE;
const char* WIFI_PASS = WIFI_PASS_VALUE;

// ===================== OTA =====================
#ifndef OTA_HOSTNAME_VALUE
#define OTA_HOSTNAME_VALUE "central-command-rs485"
#endif

#ifndef OTA_PASSWORD_VALUE
#define OTA_PASSWORD_VALUE "CHANGE_THIS_PASSWORD"
#endif

const char* OTA_HOSTNAME = OTA_HOSTNAME_VALUE;
const char* OTA_PASSWORD = OTA_PASSWORD_VALUE;

// ===================== MQTT =====================
#ifndef MQTT_SERVER_VALUE
#define MQTT_SERVER_VALUE "192.168.1.100"
#endif

#ifndef MQTT_PORT_VALUE
#define MQTT_PORT_VALUE 1883
#endif

#ifndef MQTT_USER_VALUE
#define MQTT_USER_VALUE ""
#endif

#ifndef MQTT_PASS_VALUE
#define MQTT_PASS_VALUE ""
#endif

#ifndef MQTT_USE_TLS_VALUE
#define MQTT_USE_TLS_VALUE 1
#endif

const char* MQTT_SERVER = MQTT_SERVER_VALUE;
const int MQTT_PORT = MQTT_PORT_VALUE;
const char* MQTT_USER = MQTT_USER_VALUE;
const char* MQTT_PASS = MQTT_PASS_VALUE;
const bool MQTT_USE_TLS = MQTT_USE_TLS_VALUE;

const char* MQTT_TOPIC_STATUS = "centralcommand/room1/status";
const char* MQTT_TOPIC_DATA = "centralcommand/room1/sensors";
const char* MQTT_TOPIC_CALIBRATION = "centralcommand/room1/calibration";
const char* MQTT_TOPIC_HUMIDIFIER_CONFIG = "centralcommand/room1/humidifier/config";
const char* MQTT_TOPIC_HUMIDIFIER_STATUS = "centralcommand/room1/humidifier/status";

// ===================== RS485 PINS =====================
#define RS485_TX_PIN 17
#define RS485_RX_PIN 16
#define RS485_DE_RE_PIN 4

// ===================== 4-CHANNEL RELAY PINS =====================
// Most 5 V relay boards are active LOW. Override these values in secrets.h if needed.
#ifndef RELAY_ACTIVE_LOW_VALUE
#define RELAY_ACTIVE_LOW_VALUE 1
#endif

#ifndef RELAY_CH1_PIN_VALUE
#define RELAY_CH1_PIN_VALUE 25
#endif

#ifndef RELAY_CH2_PIN_VALUE
#define RELAY_CH2_PIN_VALUE 26
#endif

#ifndef RELAY_CH3_PIN_VALUE
#define RELAY_CH3_PIN_VALUE 27
#endif

#ifndef RELAY_CH4_PIN_VALUE
#define RELAY_CH4_PIN_VALUE 33
#endif

const bool RELAY_ACTIVE_LOW = RELAY_ACTIVE_LOW_VALUE;
const uint8_t RELAY_PINS[] = {
  RELAY_CH1_PIN_VALUE,
  RELAY_CH2_PIN_VALUE,
  RELAY_CH3_PIN_VALUE,
  RELAY_CH4_PIN_VALUE
};
const uint8_t HUMIDIFIER_RELAY_INDEX = 0;

// ===================== HUMIDIFIER DEFAULTS =====================
#ifndef HUMIDIFIER_ENABLED_VALUE
#define HUMIDIFIER_ENABLED_VALUE 0
#endif

#ifndef HUMIDITY_SETPOINT_VALUE
#define HUMIDITY_SETPOINT_VALUE 90.0f
#endif

#ifndef HUMIDITY_HYSTERESIS_VALUE
#define HUMIDITY_HYSTERESIS_VALUE 3.0f
#endif

const bool DEFAULT_HUMIDIFIER_ENABLED = HUMIDIFIER_ENABLED_VALUE;
const float DEFAULT_HUMIDITY_SETPOINT = HUMIDITY_SETPOINT_VALUE;
const float DEFAULT_HUMIDITY_HYSTERESIS = HUMIDITY_HYSTERESIS_VALUE;

// ===================== MODBUS SETTINGS =====================
#ifndef MODBUS_BAUD_VALUE
#define MODBUS_BAUD_VALUE 9600
#endif

#ifndef PT100_ID_VALUE
#define PT100_ID_VALUE 1
#endif

#ifndef SHT20_ID_VALUE
#define SHT20_ID_VALUE 1
#endif

#ifndef ENABLE_PT100_VALUE
#define ENABLE_PT100_VALUE 0
#endif

#ifndef ENABLE_SHT20_VALUE
#define ENABLE_SHT20_VALUE 1
#endif

const uint32_t MODBUS_BAUD = MODBUS_BAUD_VALUE;
const uint8_t PT100_ID = PT100_ID_VALUE;
const uint8_t SHT20_ID = SHT20_ID_VALUE;
const bool ENABLE_PT100 = ENABLE_PT100_VALUE;
const bool ENABLE_SHT20 = ENABLE_SHT20_VALUE;

// ===================== OBJECTS =====================
HardwareSerial RS485Serial(2);
ModbusMaster node;

#if MQTT_USE_TLS_VALUE
WiFiClientSecure espClient;
#else
WiFiClient espClient;
#endif

PubSubClient mqtt(espClient);
WebServer server(80);
Preferences preferences;

// ===================== SENSOR VALUES =====================
float sht20Temp = NAN;
float sht20Hum = NAN;
float pt100Temp = NAN;

bool sht20Online = false;
bool pt100Online = false;

// ===================== HUMIDIFIER CONTROL =====================
bool humidifierEnabled = DEFAULT_HUMIDIFIER_ENABLED;
bool humidifierRelayOn = false;
float humiditySetpoint = DEFAULT_HUMIDITY_SETPOINT;
float humidityHysteresis = DEFAULT_HUMIDITY_HYSTERESIS;
float humidityCalibration = 0.0f;
unsigned long lastGoodHumidityAt = 0;
const char* humidifierReason = "disabled";

unsigned long lastRead = 0;
unsigned long lastMqtt = 0;
unsigned long lastWifiRetry = 0;

const unsigned long READ_INTERVAL = 3000;
const unsigned long MQTT_INTERVAL = 5000;
const unsigned long WIFI_RETRY_INTERVAL = 30000;
const unsigned long HUMIDITY_STALE_TIMEOUT = 15000;

// ===================== RELAY HELPERS =====================
uint8_t relayLevel(bool on) {
  if (RELAY_ACTIVE_LOW) {
    return on ? LOW : HIGH;
  }
  return on ? HIGH : LOW;
}

void initializeRelays() {
  for (uint8_t pin : RELAY_PINS) {
    digitalWrite(pin, relayLevel(false));
    pinMode(pin, OUTPUT);
    digitalWrite(pin, relayLevel(false));
  }
  humidifierRelayOn = false;
}

void setHumidifierRelay(bool on) {
  if (humidifierRelayOn == on) {
    return;
  }

  humidifierRelayOn = on;
  digitalWrite(RELAY_PINS[HUMIDIFIER_RELAY_INDEX], relayLevel(on));
  Serial.print("Humidifier relay CH1: ");
  Serial.println(on ? "ON" : "OFF");
}

float controlledHumidity() {
  if (!sht20Online || isnan(sht20Hum)) {
    return NAN;
  }
  return sht20Hum + humidityCalibration;
}

bool humiditySensorFresh() {
  return sht20Online &&
         !isnan(sht20Hum) &&
         lastGoodHumidityAt > 0 &&
         millis() - lastGoodHumidityAt <= HUMIDITY_STALE_TIMEOUT;
}

void updateHumidifierControl() {
  if (!humidifierEnabled) {
    humidifierReason = "disabled";
    setHumidifierRelay(false);
    return;
  }

  if (!humiditySensorFresh()) {
    humidifierReason = "sensor_offline";
    setHumidifierRelay(false);
    return;
  }

  float humidity = controlledHumidity();
  if (humidifierRelayOn) {
    if (humidity >= humiditySetpoint) {
      humidifierReason = "target_reached";
      setHumidifierRelay(false);
    } else {
      humidifierReason = "humidifying";
    }
    return;
  }

  if (humidity <= humiditySetpoint - humidityHysteresis) {
    humidifierReason = "below_setpoint";
    setHumidifierRelay(true);
  } else {
    humidifierReason = "holding";
  }
}

void loadHumiditySettings() {
  preferences.begin("humidity", false);
  humidifierEnabled = preferences.getBool("enabled", DEFAULT_HUMIDIFIER_ENABLED);
  humiditySetpoint = preferences.getFloat("setpoint", DEFAULT_HUMIDITY_SETPOINT);
  humidityHysteresis = preferences.getFloat("hysteresis", DEFAULT_HUMIDITY_HYSTERESIS);
  humidityCalibration = preferences.getFloat("humOffset", 0.0f);

  if (humiditySetpoint < 0.0f || humiditySetpoint > 100.0f) {
    humiditySetpoint = DEFAULT_HUMIDITY_SETPOINT;
  }
  if (humidityHysteresis < 0.5f || humidityHysteresis > 20.0f) {
    humidityHysteresis = DEFAULT_HUMIDITY_HYSTERESIS;
  }
}

void saveHumidityControlSettings() {
  preferences.putBool("enabled", humidifierEnabled);
  preferences.putFloat("setpoint", humiditySetpoint);
  preferences.putFloat("hysteresis", humidityHysteresis);
}

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
bool connectWiFi(unsigned long timeoutMs = 20000) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting WiFi");

  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < timeoutMs) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("WiFi failed. Continuing sensor reads offline.");
  return false;
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
    mqtt.subscribe(MQTT_TOPIC_CALIBRATION);
    mqtt.subscribe(MQTT_TOPIC_HUMIDIFIER_CONFIG);
    publishHumidifierStatus();
  } else {
    Serial.print("failed, rc=");
    Serial.println(mqtt.state());
  }
}

// ===================== READ SHT20 =====================
// Common SHT20 RS485 format:
// register 0x0001 = temperature x10
// register 0x0002 = humidity x10
bool readSHT20() {
  if (!ENABLE_SHT20) {
    sht20Online = false;
    return false;
  }

  node.begin(SHT20_ID, RS485Serial);

  uint8_t result = node.readInputRegisters(0x0001, 2);

  if (result == node.ku8MBSuccess) {
    int16_t rawTemp = (int16_t)node.getResponseBuffer(0);
    uint16_t rawHum = node.getResponseBuffer(1);

    sht20Hum = rawHum / 10.0;
    sht20Temp = rawTemp / 10.0;
    sht20Online = true;
    lastGoodHumidityAt = millis();

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
  if (!ENABLE_PT100) {
    pt100Temp = NAN;
    pt100Online = false;
    return false;
  }

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

int jsonValueStart(const String& json, const char* key) {
  String token = "\"";
  token += key;
  token += "\"";
  int keyPosition = json.indexOf(token);
  if (keyPosition < 0) return -1;

  int colonPosition = json.indexOf(':', keyPosition + token.length());
  if (colonPosition < 0) return -1;

  int valuePosition = colonPosition + 1;
  while (valuePosition < (int)json.length() &&
         (json[valuePosition] == ' ' || json[valuePosition] == '\t' ||
          json[valuePosition] == '\r' || json[valuePosition] == '\n')) {
    valuePosition++;
  }
  return valuePosition;
}

bool jsonFloatValue(const String& json, const char* key, float& value) {
  int start = jsonValueStart(json, key);
  if (start < 0) return false;

  int end = start;
  while (end < (int)json.length() &&
         json[end] != ',' && json[end] != '}' && json[end] != ']') {
    end++;
  }

  String raw = json.substring(start, end);
  raw.trim();
  if (raw.length() == 0) return false;

  char* parsedEnd = nullptr;
  float parsed = strtof(raw.c_str(), &parsedEnd);
  if (parsedEnd == raw.c_str() || *parsedEnd != '\0' || isnan(parsed) || isinf(parsed)) {
    return false;
  }

  value = parsed;
  return true;
}

bool jsonBoolValue(const String& json, const char* key, bool& value) {
  int start = jsonValueStart(json, key);
  if (start < 0) return false;

  if (json.substring(start, start + 4).equalsIgnoreCase("true")) {
    value = true;
    return true;
  }
  if (json.substring(start, start + 5).equalsIgnoreCase("false")) {
    value = false;
    return true;
  }
  return false;
}

String humidifierStatusJson() {
  String json = "{";
  json += "\"device\":\"central-command-rs485\",";
  json += "\"enabled\":";
  json += boolJson(humidifierEnabled);
  json += ",";
  json += "\"setpoint\":";
  json += String(humiditySetpoint, 1);
  json += ",";
  json += "\"hysteresis\":";
  json += String(humidityHysteresis, 1);
  json += ",";
  json += "\"relay_on\":";
  json += boolJson(humidifierRelayOn);
  json += ",";
  json += "\"sensor_online\":";
  json += boolJson(humiditySensorFresh());
  json += ",";
  json += "\"humidity_raw\":";
  json += valueOrNull(sht20Online ? sht20Hum : NAN, 1);
  json += ",";
  json += "\"humidity_control\":";
  json += valueOrNull(controlledHumidity(), 1);
  json += ",";
  json += "\"calibration\":";
  json += String(humidityCalibration, 1);
  json += ",";
  json += "\"reason\":\"";
  json += humidifierReason;
  json += "\",";
  json += "\"uptime_ms\":";
  json += String(millis());
  json += "}";
  return json;
}

void publishHumidifierStatus() {
  if (!mqtt.connected()) {
    return;
  }

  String payload = humidifierStatusJson();
  mqtt.publish(MQTT_TOPIC_HUMIDIFIER_STATUS, payload.c_str(), true);
  Serial.print("Humidifier status: ");
  Serial.println(payload);
}

void handleMqttMessage(char* topic, byte* payload, unsigned int length) {
  String message;
  message.reserve(length);
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  if (strcmp(topic, MQTT_TOPIC_CALIBRATION) == 0) {
    float offset;
    if (jsonFloatValue(message, "humidity", offset) && offset >= -50.0f && offset <= 50.0f) {
      humidityCalibration = offset;
      preferences.putFloat("humOffset", humidityCalibration);
      updateHumidifierControl();
      publishHumidifierStatus();
      Serial.print("Humidity calibration updated: ");
      Serial.println(humidityCalibration, 1);
    }
    return;
  }

  if (strcmp(topic, MQTT_TOPIC_HUMIDIFIER_CONFIG) != 0) {
    return;
  }

  bool enabled;
  float setpoint;
  float hysteresis;
  bool hasEnabled = jsonBoolValue(message, "enabled", enabled);
  bool hasSetpoint = jsonFloatValue(message, "setpoint", setpoint);
  bool hasHysteresis = jsonFloatValue(message, "hysteresis", hysteresis);

  if (!hasEnabled && !hasSetpoint && !hasHysteresis) {
    Serial.println("Ignored invalid humidifier config.");
    return;
  }
  if ((hasSetpoint && (setpoint < 0.0f || setpoint > 100.0f)) ||
      (hasHysteresis && (hysteresis < 0.5f || hysteresis > 20.0f))) {
    Serial.println("Ignored out-of-range humidifier config.");
    return;
  }

  if (hasEnabled) humidifierEnabled = enabled;
  if (hasSetpoint) humiditySetpoint = setpoint;
  if (hasHysteresis) humidityHysteresis = hysteresis;

  saveHumidityControlSettings();
  updateHumidifierControl();
  publishHumidifierStatus();
  Serial.println("Humidifier control settings updated.");
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
  json += "\"humidifier_enabled\":";
  json += boolJson(humidifierEnabled);
  json += ",";
  json += "\"humidifier_setpoint\":";
  json += String(humiditySetpoint, 1);
  json += ",";
  json += "\"humidifier_hysteresis\":";
  json += String(humidityHysteresis, 1);
  json += ",";
  json += "\"humidifier_relay_on\":";
  json += boolJson(humidifierRelayOn);
  json += ",";
  json += "\"humidifier_reason\":\"";
  json += humidifierReason;
  json += "\",";
  json += "\"humidity_control\":";
  json += valueOrNull(controlledHumidity(), 1);
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
    publishHumidifierStatus();

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
          : Number(value).toFixed(1) + ' <span class="unit">' + unit + '</span>';
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
  initializeRelays();
  loadHumiditySettings();
  updateHumidifierControl();
  delay(1000);

  pinMode(RS485_DE_RE_PIN, OUTPUT);
  digitalWrite(RS485_DE_RE_PIN, LOW);

  RS485Serial.begin(MODBUS_BAUD, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);

  Serial.println("Modbus RTU ready");
  Serial.print("Baud: ");
  Serial.println(MODBUS_BAUD);
  Serial.print("SHT20: ");
  Serial.print(ENABLE_SHT20 ? "enabled, ID " : "disabled, ID ");
  Serial.println(SHT20_ID);
  Serial.print("PT100: ");
  Serial.print(ENABLE_PT100 ? "enabled, ID " : "disabled, ID ");
  Serial.println(PT100_ID);
  Serial.print("Humidifier relay: GPIO");
  Serial.print(RELAY_PINS[HUMIDIFIER_RELAY_INDEX]);
  Serial.print(RELAY_ACTIVE_LOW ? " active LOW" : " active HIGH");
  Serial.print(" | enabled: ");
  Serial.print(humidifierEnabled ? "yes" : "no");
  Serial.print(" | setpoint: ");
  Serial.print(humiditySetpoint, 1);
  Serial.print("% | hysteresis: ");
  Serial.print(humidityHysteresis, 1);
  Serial.println("%");

  node.preTransmission(preTransmission);
  node.postTransmission(postTransmission);

  if (connectWiFi()) {
    setupOTA();
  }

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setBufferSize(768);
  mqtt.setCallback(handleMqttMessage);

#if MQTT_USE_TLS_VALUE
  // HiveMQ Cloud requires TLS on port 8883. For production, replace this with a pinned CA certificate.
  espClient.setInsecure();
#endif

  setupWebServer();

  Serial.println("System ready");
}

// ===================== LOOP =====================
void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    ArduinoOTA.handle();
  }

  server.handleClient();

  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED && now - lastWifiRetry >= WIFI_RETRY_INTERVAL) {
    lastWifiRetry = now;
    if (connectWiFi(5000)) {
      setupOTA();
    }
  }

  if (WiFi.status() == WL_CONNECTED && !mqtt.connected()) {
    connectMQTT();
  }

  if (mqtt.connected()) {
    mqtt.loop();
  }

  if (now - lastRead >= READ_INTERVAL) {
    lastRead = now;

    if (ENABLE_PT100) {
      readPT100();
      delay(200);
    }

    if (ENABLE_SHT20) {
      readSHT20();
    }

    updateHumidifierControl();
  }

  if (WiFi.status() == WL_CONNECTED && now - lastMqtt >= MQTT_INTERVAL) {
    lastMqtt = now;
    publishMQTT();
  }
}
