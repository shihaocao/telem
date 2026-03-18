#include <Arduino.h>

constexpr int LED_PIN = LED_BUILTIN;

constexpr uint32_t BLINK_PERIOD_MS = 500;
constexpr uint32_t TELEMETRY_PERIOD_MS = 100; // 10 Hz

// ECT (0-5V analog) pin A5
// Throttle position sensor pin A6, analog 0-5V
// MAP sensor pin A7, analog 0-5V
constexpr int PIN_ECT = A5;
constexpr int PIN_TPS = A6;
constexpr int PIN_MAP = A7;

constexpr float VREF = 5.0f;
constexpr float ADC_MAX = 1023.0f;

void setup() {
    pinMode(LED_PIN, OUTPUT);
    pinMode(PIN_ECT, INPUT);
    pinMode(PIN_TPS, INPUT);
    pinMode(PIN_MAP, INPUT);

    Serial.begin(115200);
    while (!Serial && millis() < 3000) {}
}

void loop() {
    static uint32_t last_blink = 0;
    static uint32_t last_telem = 0;
    uint32_t now = millis();

    if (now - last_blink >= BLINK_PERIOD_MS) {
        last_blink = now;
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    }

    if (now - last_telem >= TELEMETRY_PERIOD_MS) {
        last_telem = now;

        float ect = analogRead(PIN_ECT) * (VREF / ADC_MAX);
        float tps = analogRead(PIN_TPS) * (VREF / ADC_MAX);
        float map_v = analogRead(PIN_MAP) * (VREF / ADC_MAX);

        // Print: "ect tps map\n" (volts, 3 decimal places)
        Serial.print(ect, 3);
        Serial.print(" ");
        Serial.print(tps, 3);
        Serial.print(" ");
        Serial.println(map_v, 3);
    }
}