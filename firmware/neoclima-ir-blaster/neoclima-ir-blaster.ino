#include <Arduino.h>
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>

#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <ir_Neoclima.h>

// ================= WIFI =================
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// ================= IR =================
const uint16_t kIrLedPin = 27;
IRNeoclimaAc ac(kIrLedPin);

// ================= WEB SERVER =================
AsyncWebServer server(80);

// ================= AC STATE =================
bool powerState = false;
uint8_t tempState = 24;
uint8_t modeState = kNeoclimaCool;
uint8_t fanState = kNeoclimaFanAuto;

String modeToString(uint8_t mode) {
  if (mode == kNeoclimaAuto) return "auto";
  if (mode == kNeoclimaCool) return "cool";
  if (mode == kNeoclimaHeat) return "heat";
  if (mode == kNeoclimaDry) return "dry";
  if (mode == kNeoclimaFan) return "fan";
  return "unknown";
}

String fanToString(uint8_t fan) {
  if (fan == kNeoclimaFanAuto) return "auto";
  if (fan == kNeoclimaFanLow) return "low";
  if (fan == kNeoclimaFanMed) return "med";
  if (fan == kNeoclimaFanHigh) return "high";
  return "unknown";
}

void sendAcState() {
  if (powerState) ac.on();
  else ac.off();

  ac.setMode(modeState);
  ac.setTemp(tempState, true);
  ac.setFan(fanState);
  ac.send();

  Serial.println("========== NEOCLIMA AC COMMAND SENT ==========");
  Serial.print("Power: ");
  Serial.println(powerState ? "ON" : "OFF");
  Serial.print("Temp: ");
  Serial.println(tempState);
  Serial.print("Mode: ");
  Serial.println(modeToString(modeState));
  Serial.print("Fan: ");
  Serial.println(fanToString(fanState));
  Serial.print("State: ");
  Serial.println(ac.toString());
  Serial.println("==============================================");
}

String statusJson() {
  String json = "{";
  json += "\"power\":\"";
  json += (powerState ? "ON" : "OFF");
  json += "\",";
  json += "\"temp\":";
  json += String(tempState);
  json += ",";
  json += "\"mode\":\"";
  json += modeToString(modeState);
  json += "\",";
  json += "\"fan\":\"";
  json += fanToString(fanState);
  json += "\",";
  json += "\"ip\":\"";
  json += WiFi.localIP().toString();
  json += "\"";
  json += "}";
  return json;
}

String htmlPage() {
  return R"rawliteral(
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NEOCLIMA AC Controller</title>
  <style>
    body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: #111827; color: white; text-align: center; }
    main { max-width: 420px; margin: auto; background: #1f2937; padding: 24px; border-radius: 12px; }
    button { width: 45%; min-height: 48px; margin: 8px; border: 0; border-radius: 8px; color: white; font-weight: 700; cursor: pointer; }
    .on { background: #22c55e; }
    .off { background: #ef4444; }
    .blue { background: #3b82f6; }
    .gray { background: #6b7280; }
    .orange { background: #f97316; }
    .teal { background: #14b8a6; }
  </style>
</head>
<body>
  <main>
    <h1>NEOCLIMA AC Controller</h1>
    <h2><span id="temp">24</span> deg C</h2>
    <p>
      Power: <span id="power">OFF</span><br>
      Mode: <span id="mode">cool</span><br>
      Fan: <span id="fan">auto</span>
    </p>
    <button class="on" onclick="sendCmd('on')">ON</button>
    <button class="off" onclick="sendCmd('off')">OFF</button>
    <button class="blue" onclick="sendCmd('temp_up')">TEMP +</button>
    <button class="blue" onclick="sendCmd('temp_down')">TEMP -</button>
    <button class="teal" onclick="sendCmd('temp:20')">20 C</button>
    <button class="teal" onclick="sendCmd('temp:22')">22 C</button>
    <button class="teal" onclick="sendCmd('temp:24')">24 C</button>
    <button class="teal" onclick="sendCmd('temp:26')">26 C</button>
    <button class="gray" onclick="sendCmd('auto')">AUTO</button>
    <button class="gray" onclick="sendCmd('cool')">COOL</button>
    <button class="gray" onclick="sendCmd('heat')">HEAT</button>
    <button class="gray" onclick="sendCmd('dry')">DRY</button>
    <button class="gray" onclick="sendCmd('fan_mode')">FAN MODE</button>
    <button class="orange" onclick="sendCmd('fan_auto')">FAN AUTO</button>
    <button class="orange" onclick="sendCmd('fan_low')">FAN LOW</button>
    <button class="orange" onclick="sendCmd('fan_med')">FAN MED</button>
    <button class="orange" onclick="sendCmd('fan_high')">FAN HIGH</button>
    <p id="log"></p>
  </main>
  <script>
    function updateStatus() {
      fetch("/status")
        .then((response) => response.json())
        .then((status) => {
          document.getElementById("temp").textContent = status.temp;
          document.getElementById("power").textContent = status.power;
          document.getElementById("mode").textContent = status.mode;
          document.getElementById("fan").textContent = status.fan;
        });
    }

    function sendCmd(command) {
      fetch("/cmd?c=" + encodeURIComponent(command))
        .then((response) => response.text())
        .then((message) => {
          document.getElementById("log").textContent = message;
          updateStatus();
        });
    }

    updateStatus();
  </script>
</body>
</html>
)rawliteral";
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting to WiFi");

  unsigned long startAttemptTime = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 20000) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected");
    Serial.print("IR Blaster IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi failed");
  }
}

void setupCors() {
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type");
}

bool applyCommand(String cmd) {
  if (cmd == "on") {
    powerState = true;
  } else if (cmd == "off") {
    powerState = false;
  } else if (cmd == "temp_up") {
    if (tempState < 32) tempState++;
    powerState = true;
  } else if (cmd == "temp_down") {
    if (tempState > 16) tempState--;
    powerState = true;
  } else if (cmd.startsWith("temp:")) {
    int temp = cmd.substring(5).toInt();
    if (temp < 16 || temp > 32) return false;
    tempState = temp;
    powerState = true;
  } else if (cmd == "auto") {
    modeState = kNeoclimaAuto;
    powerState = true;
  } else if (cmd == "cool") {
    modeState = kNeoclimaCool;
    powerState = true;
  } else if (cmd == "heat") {
    modeState = kNeoclimaHeat;
    powerState = true;
  } else if (cmd == "dry") {
    modeState = kNeoclimaDry;
    fanState = kNeoclimaFanLow;
    powerState = true;
  } else if (cmd == "fan_mode") {
    modeState = kNeoclimaFan;
    powerState = true;
  } else if (cmd == "fan_auto") {
    fanState = kNeoclimaFanAuto;
    powerState = true;
  } else if (cmd == "fan_low") {
    fanState = kNeoclimaFanLow;
    powerState = true;
  } else if (cmd == "fan_med") {
    fanState = kNeoclimaFanMed;
    powerState = true;
  } else if (cmd == "fan_high") {
    fanState = kNeoclimaFanHigh;
    powerState = true;
  } else {
    return false;
  }

  return true;
}

void setupRoutes() {
  server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send(200, "text/html", htmlPage());
  });

  server.on("/status", HTTP_OPTIONS, [](AsyncWebServerRequest *request) {
    request->send(204, "text/plain", "");
  });

  server.on("/status", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send(200, "application/json", statusJson());
  });

  server.on("/cmd", HTTP_OPTIONS, [](AsyncWebServerRequest *request) {
    request->send(204, "text/plain", "");
  });

  server.on("/cmd", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (!request->hasParam("c")) {
      request->send(400, "text/plain", "Missing command");
      return;
    }

    String cmd = request->getParam("c")->value();
    if (!applyCommand(cmd)) {
      String message = "Unknown command: ";
      message += cmd;
      request->send(400, "text/plain", message);
      return;
    }

    sendAcState();
    String message = "Command sent: ";
    message += cmd;
    request->send(200, "text/plain", message);
  });

  server.onNotFound([](AsyncWebServerRequest *request) {
    if (request->method() == HTTP_OPTIONS) {
      request->send(204, "text/plain", "");
      return;
    }

    request->send(404, "text/plain", "Not found");
  });
}

void setup() {
  Serial.begin(115200);
  delay(500);

  ac.begin();
  ac.stateReset();
  ac.off();
  ac.setMode(modeState);
  ac.setTemp(tempState, true);
  ac.setFan(fanState);

  connectWiFi();
  setupCors();
  setupRoutes();
  server.begin();

  Serial.println("IR blaster web server started");
}

void loop() {
}
