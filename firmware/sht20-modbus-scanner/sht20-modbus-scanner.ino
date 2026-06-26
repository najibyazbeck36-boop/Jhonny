#include <Arduino.h>
#include <ModbusMaster.h>

#define RS485_TX_PIN 17
#define RS485_RX_PIN 16
#define RS485_DE_RE_PIN 4

HardwareSerial RS485Serial(2);
ModbusMaster node;

struct RegisterTest {
  const char* name;
  bool inputRegister;
  uint16_t address;
  uint8_t count;
};

RegisterTest tests[] = {
  { "input 0x0001 count 2", true, 0x0001, 2 },
  { "input 0x0000 count 2", true, 0x0000, 2 },
  { "holding 0x0001 count 2", false, 0x0001, 2 },
};

uint8_t ids[] = { 1, 2, 3, 4, 5 };
uint32_t baudRates[] = { 9600, 4800, 19200 };

void preTransmission() {
  digitalWrite(RS485_DE_RE_PIN, HIGH);
  delayMicroseconds(150);
}

void postTransmission() {
  delayMicroseconds(150);
  digitalWrite(RS485_DE_RE_PIN, LOW);
}

void printResult(uint8_t id, RegisterTest test, uint8_t result) {
  Serial.print("ID ");
  Serial.print(id);
  Serial.print(" | ");
  Serial.print(test.name);
  Serial.print(" -> ");

  if (result == node.ku8MBSuccess) {
    uint16_t raw0 = node.getResponseBuffer(0);
    uint16_t raw1 = node.getResponseBuffer(1);

    Serial.print("OK raw0=");
    Serial.print(raw0);
    Serial.print(" raw1=");
    Serial.print(raw1);
    Serial.print(" as x10: ");
    Serial.print(raw0 / 10.0);
    Serial.print(", ");
    Serial.println(((int16_t)raw1) / 10.0);
  } else {
    Serial.print("fail 0x");
    Serial.println(result, HEX);
  }
}

void runScan() {
  Serial.println();
  Serial.println("Pins: TX=17 RX=16 DE/RE=4");

  for (uint8_t baudIndex = 0; baudIndex < sizeof(baudRates) / sizeof(baudRates[0]); baudIndex++) {
    uint32_t baudRate = baudRates[baudIndex];
    RS485Serial.updateBaudRate(baudRate);

    Serial.print("----- Baud ");
    Serial.print(baudRate);
    Serial.println(" 8N1 -----");

    for (uint8_t idIndex = 0; idIndex < sizeof(ids); idIndex++) {
      uint8_t id = ids[idIndex];
      node.begin(id, RS485Serial);

      for (uint8_t testIndex = 0; testIndex < sizeof(tests) / sizeof(tests[0]); testIndex++) {
        RegisterTest test = tests[testIndex];
        uint8_t result = test.inputRegister
          ? node.readInputRegisters(test.address, test.count)
          : node.readHoldingRegisters(test.address, test.count);

        printResult(id, test, result);
        delay(150);
      }
    }
  }

  Serial.println("===== Scan complete =====");
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(RS485_DE_RE_PIN, OUTPUT);
  digitalWrite(RS485_DE_RE_PIN, LOW);

  RS485Serial.begin(9600, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);
  node.preTransmission(preTransmission);
  node.postTransmission(postTransmission);

  runScan();
}

void loop() {
  delay(8000);
  runScan();
}
