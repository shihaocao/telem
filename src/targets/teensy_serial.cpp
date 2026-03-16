#include <Arduino.h>

constexpr int LED_PIN = LED_BUILTIN;

constexpr uint32_t BLINK_PERIOD_MS = 500;
constexpr uint32_t TELEMETRY_PERIOD_MS = 100; // 10 Hz

elapsedMillis blink_timer;
elapsedMillis telemetry_timer;

void setup() {
    pinMode(LED_PIN, OUTPUT);

    Serial.begin(115200);

    // Optional: wait for serial monitor (remove for embedded use)
    while (!Serial && millis() < 3000) {}
}

void loop() {

    // --- Blink LED ---
    if (blink_timer >= BLINK_PERIOD_MS) {
        blink_timer = 0;
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    }

    // --- Mock Telemetry (10 Hz) ---
    if (telemetry_timer >= TELEMETRY_PERIOD_MS) {
        telemetry_timer = 0;

        static float t = 0.0f;
        t += 0.1f;

        float v1 = sinf(t);
        float v2 = cosf(t);
        float v3 = t;

        // Print: "v1 v2 v3\n"
        Serial.print(v1, 6);
        Serial.print(" ");
        Serial.print(v2, 6);
        Serial.print(" ");
        Serial.println(v3, 6);
    }
}