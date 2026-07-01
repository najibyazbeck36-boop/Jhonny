#pragma once

// Copy this file to secrets.h in the same folder and put your real values there.
// secrets.h is ignored by Git so private credentials do not get published.

#define WIFI_SSID_VALUE "YOUR_WIFI_NAME"
#define WIFI_PASS_VALUE "YOUR_WIFI_PASSWORD"

#define OTA_HOSTNAME_VALUE "central-command-rs485"
#define OTA_PASSWORD_VALUE "CHANGE_THIS_PASSWORD"

#define MQTT_SERVER_VALUE "192.168.1.100"
#define MQTT_PORT_VALUE 8883
#define MQTT_USER_VALUE ""
#define MQTT_PASS_VALUE ""
#define MQTT_USE_TLS_VALUE 1

#define MODBUS_BAUD_VALUE 9600

// For testing only the SHT20, leave PT100 disabled.
// Many RS485 SHT20 sensors ship with Modbus ID 1.
#define ENABLE_SHT20_VALUE 1
#define SHT20_ID_VALUE 1

#define ENABLE_PT100_VALUE 0
#define PT100_ID_VALUE 1

// 4-channel relay module. Channel 1 controls the humidifier.
// Most relay modules are active LOW; use 0 for an active-HIGH board.
#define RELAY_ACTIVE_LOW_VALUE 1
#define RELAY_CH1_PIN_VALUE 25
#define RELAY_CH2_PIN_VALUE 26
#define RELAY_CH3_PIN_VALUE 27
#define RELAY_CH4_PIN_VALUE 33

// Safe default is disabled until enabled from the dashboard.
#define HUMIDIFIER_ENABLED_VALUE 0
#define HUMIDITY_SETPOINT_VALUE 90.0f
#define HUMIDITY_HYSTERESIS_VALUE 3.0f
