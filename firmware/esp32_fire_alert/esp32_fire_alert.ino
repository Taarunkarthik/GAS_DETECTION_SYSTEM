#include <Arduino.h>
#include <DHT.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <string.h>

#include "Config.h"

DHT dht(DHT_PIN, DHT_TYPE);
unsigned long lastSensorReadMs = 0;
unsigned long lastWiFiStatusLogMs = 0;
bool previouslyConnected = false;

void setup() {
  initFireSystem();
}

void loop() {
  const bool connected = WiFi.status() == WL_CONNECTED;
  const unsigned long now = millis();
  if (connected && !previouslyConnected) {
    Serial.print("Wi-Fi connected. ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else if (!connected && previouslyConnected) {
    Serial.println("Wi-Fi disconnected; automatic reconnect is enabled.");
  } else if (!connected && now - lastWiFiStatusLogMs >= 5000) {
    lastWiFiStatusLogMs = now;
    switch (WiFi.status()) {
      case WL_NO_SSID_AVAIL:
        Serial.println("Wi-Fi status: hotspot SSID not found; check SSID/band.");
        break;
      case WL_CONNECT_FAILED:
        Serial.println("Wi-Fi status: connection failed; check hotspot password/security.");
        break;
      case WL_DISCONNECTED:
        Serial.println("Wi-Fi status: disconnected/not associated yet.");
        break;
      case WL_IDLE_STATUS:
        Serial.println("Wi-Fi status: still connecting.");
        break;
      default:
        Serial.printf("Wi-Fi status code: %d\n", static_cast<int>(WiFi.status()));
        break;
    }
  }
  previouslyConnected = connected;

  if (now - lastSensorReadMs >= SENSOR_INTERVAL_MS) {
    lastSensorReadMs = now;

    SensorReading reading;
    reading.temperatureC = readTemperatureData();
    reading.humidity = readHumidityData();
    reading.temperatureOk = !isnan(reading.temperatureC);
    reading.humidityOk = !isnan(reading.humidity);
    reading.smokeRaw = readAverageSmokeLevel();

    if (!reading.temperatureOk || !reading.humidityOk) {
      Serial.println("[ERROR] DHT11 reading failed; checking smoke sensor still.");
    }

    const int systemState = evaluateFireCondition(
      reading.temperatureOk ? reading.temperatureC : NAN,
      reading.smokeRaw
    );

    triggerSystemAlerts(
      reading.temperatureOk ? reading.temperatureC : NAN,
      reading.humidityOk ? reading.humidity : NAN,
      reading.smokeRaw,
      systemState
    );

    if (WiFi.status() == WL_CONNECTED) {
      sendReading(reading, systemState);
    }
  }

  delay(10);
}

void initFireSystem(void) {
  Serial.begin(9600);
  dht.begin();

  pinMode(SMOKE_PIN, INPUT);
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(SMOKE_PIN, ADC_11db);

  digitalWrite(GREEN_LED_PIN, HIGH);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  Serial.println("==========================================");
  Serial.println("   SMART FIRE DETECTION & ALERT SYSTEM   ");
  Serial.println("==========================================");
  Serial.println("MQ-2 value is raw ADC (0-4095), not ppm.");

  connectToWiFi();
}

void connectToWiFi(void) {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

float readTemperatureData(void) {
  return dht.readTemperature();
}

float readHumidityData(void) {
  return dht.readHumidity();
}

int readAverageSmokeLevel(void) {
  long sum = 0;

  for (int sample = 0; sample < SAMPLE_COUNT; ++sample) {
    sum += analogRead(SMOKE_PIN);
    delay(10);
  }

  return static_cast<int>(sum / SAMPLE_COUNT);
}

int evaluateFireCondition(float temp, int smoke) {
  if ((isfinite(temp) && temp >= TEMP_CRITICAL) ||
      smoke >= SMOKE_CRITICAL) {
    return STATE_FIRE;
  }

  if ((isfinite(temp) && temp >= TEMP_WARNING) ||
      smoke >= SMOKE_WARNING) {
    return STATE_WARNING;
  }

  return STATE_SAFE;
}

void triggerSystemAlerts(float temp, float humidity, int smoke, int state) {
  Serial.print("Temp: ");
  if (isfinite(temp)) {
    Serial.print(temp, 1);
    Serial.print(" C");
  } else {
    Serial.print("DHT11 unavailable");
  }

  Serial.print(" | Humidity: ");
  if (isfinite(humidity)) {
    Serial.print(humidity, 1);
    Serial.print(" %");
  } else {
    Serial.print("unavailable");
  }

  Serial.print(" | Smoke ADC: ");
  Serial.print(smoke);
  Serial.print(" | Status: ");

  if (state == STATE_FIRE) {
    Serial.println("CRITICAL FIRE ALERT");
    digitalWrite(GREEN_LED_PIN, LOW);

    for (int pulse = 0; pulse < 4; ++pulse) {
      digitalWrite(RED_LED_PIN, HIGH);
      digitalWrite(BUZZER_PIN, HIGH);
      delay(150);
      digitalWrite(RED_LED_PIN, LOW);
      digitalWrite(BUZZER_PIN, LOW);
      delay(100);
    }

    // Keep the red LED on until the next sensor evaluation.
    digitalWrite(RED_LED_PIN, HIGH);
    digitalWrite(BUZZER_PIN, LOW);
  } else if (state == STATE_WARNING) {
    Serial.println("WARNING - elevated temperature or smoke");
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, HIGH);
    digitalWrite(BUZZER_PIN, HIGH);
    delay(200);
    digitalWrite(BUZZER_PIN, LOW);
  } else {
    Serial.println("NORMAL - safe environment");
    digitalWrite(GREEN_LED_PIN, HIGH);
    digitalWrite(RED_LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
  }
}

bool sendReading(const SensorReading &reading, int state) {
  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  const bool useHttps = strncmp(API_URL, "https://", 8) == 0;

  if (useHttps) {
    if (strlen(SERVER_ROOT_CA) < 100) {
      Serial.println("HTTPS needs SERVER_ROOT_CA in Config.h; reading not sent.");
      return false;
    }

    secureClient.setCACert(SERVER_ROOT_CA);
    if (!http.begin(secureClient, API_URL)) {
      Serial.println("Could not start HTTPS request.");
      return false;
    }
  } else if (!http.begin(plainClient, API_URL)) {
    Serial.println("Could not start HTTP request.");
    return false;
  }

  http.setTimeout(3500);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);

  String body = "{\"deviceId\":\"";
  body += DEVICE_ID;
  body += "\",\"temperatureC\":";
  body += reading.temperatureOk ? String(reading.temperatureC, 1) : String("null");
  body += ",\"humidity\":";
  body += reading.humidityOk ? String(reading.humidity, 1) : String("null");
  body += ",\"smokeRaw\":";
  body += String(reading.smokeRaw);
  body += ",\"sensorState\":";
  body += String(state);
  body += ",\"alarmActive\":";
  body += state == STATE_FIRE ? "true" : "false";
  body += ",\"rssi\":";
  body += String(constrain(WiFi.RSSI(), -120, 0));
  body += ",\"uptimeMs\":";
  body += String(millis());
  body += "}";

  const int responseCode = http.POST(body);
  const bool delivered = responseCode >= 200 && responseCode < 300;
  if (delivered) {
    Serial.printf("Dashboard update sent (HTTP %d).\n", responseCode);
  } else {
    Serial.printf("Dashboard update failed (HTTP %d).\n", responseCode);
  }

  http.end();
  return delivered;
}
