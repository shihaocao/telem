#include <Arduino.h>

constexpr int LED_PIN = LED_BUILTIN;
constexpr unsigned long BLINK_MS = 500;

void setup() {
    pinMode(LED_PIN, OUTPUT);
}

void loop() {
    digitalWrite(LED_PIN, HIGH);
    delay(BLINK_MS);

    digitalWrite(LED_PIN, LOW);
    delay(BLINK_MS);
}
