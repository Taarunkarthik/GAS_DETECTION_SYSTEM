#ifndef FIRE_SYSTEM_H
#define FIRE_SYSTEM_H

#include <Arduino.h>

// Replace these values before uploading the sketch.
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define API_URL "http://192.168.1.10:3000/api/readings"
#define DEVICE_API_KEY "demo-key-change-before-deployment"
#define DEVICE_ID "esp32-fire-01"

// For hosted HTTPS, paste the host's trusted root CA certificate here.
// Keep this empty while using a local HTTP address.
#define SERVER_ROOT_CA ""

// Pin assignments from your circuit: ESP32 DevKit V1 + DHT11 + MQ-2.
#define DHT_PIN         4
#define DHT_TYPE        DHT11
#define SMOKE_PIN       34
#define RED_LED_PIN     18
#define GREEN_LED_PIN   19
#define BUZZER_PIN      26

// The backend .env thresholds must match these values.
#define TEMP_WARNING       30.0f
#define TEMP_CRITICAL      35.0f
#define SMOKE_WARNING      400
#define SMOKE_CRITICAL     500
#define SAMPLE_COUNT       5
#define SENSOR_INTERVAL_MS 2000UL
#define WIFI_RETRY_INTERVAL_MS 10000UL

#define STATE_SAFE     0
#define STATE_WARNING  1
#define STATE_FIRE     2

struct SensorReading {
  float temperatureC;
  float humidity;
  bool temperatureOk;
  bool humidityOk;
  int smokeRaw;
};

// Function declarations: implementations are in esp32_fire_alert.ino.
void initFireSystem(void);
float readTemperatureData(void);
float readHumidityData(void);
int readAverageSmokeLevel(void);
int evaluateFireCondition(float temp, int smoke);
void triggerSystemAlerts(float temp, float humidity, int smoke, int state);
void connectToWiFi(void);
bool sendReading(const SensorReading &reading, int state);

#endif
