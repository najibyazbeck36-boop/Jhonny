#pragma once

// Copy this file to secrets.h in the same folder and put your real values there.
// secrets.h is ignored by Git so private credentials do not get published.

#define WIFI_SSID_VALUE "YOUR_WIFI_NAME"
#define WIFI_PASS_VALUE "YOUR_WIFI_PASSWORD"

#define MQTT_SERVER_VALUE "your-cluster-host.s1.eu.hivemq.cloud"
#define MQTT_PORT_VALUE 8883
#define MQTT_USER_VALUE "your-hivemq-username"
#define MQTT_PASS_VALUE "your-hivemq-password"
#define MQTT_USE_TLS_VALUE 1

#define MQTT_TOPIC_AC_COMMAND_VALUE "centralcommand/room1/ac/cmd"
#define MQTT_TOPIC_AC_STATUS_VALUE "centralcommand/room1/ac/status"
