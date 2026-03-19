#include <Arduino.h>

constexpr int LED_PIN = LED_BUILTIN;

constexpr uint32_t BLINK_PERIOD_MS = 500;
constexpr uint32_t TELEMETRY_PERIOD_MS = 40; // 25 Hz

// Source of truth:
// 2026.03.18:
//
// ECT A8
// TPS A9
// MAP A10

// Brake Indicator voltage divided by 4.3X - A5
// Battery Voltage - voltage divided by 4.3X - A6

// RPM 12V voltage digital square divided by 4.3X - D18
// VSS 12V voltage digital square divided by 4.3X - D19
// End source of truth

// Analog pins
constexpr int PIN_ECT = A8;
constexpr int PIN_TPS = A9;
constexpr int PIN_MAP = A10;
constexpr int PIN_BRAKE = A5;
constexpr int PIN_VBATT = A6;

constexpr float VREF = 5.0f;
constexpr float ADC_MAX = 1023.0f;
constexpr float VDIV_RATIO = 4.3f;

// Interrupt pins (Mega 2560: pin 18 = INT3, pin 19 = INT2)
constexpr int PIN_TACH = 18;  // INT3 — RPM signal, 12V square wave through 4.3× voltage divider
constexpr int PIN_VSS  = 19;  // INT2 — VSS signal, 12V square wave through 4.3× voltage divider

// Tach: 2 pulses per revolution (F22A)
constexpr float TACH_PULSES_PER_REV = 2.0f;

// VSS: pulses per km — calibrate this on track
constexpr float VSS_PULSES_PER_KM = 4000.0f; // placeholder, needs calibration

volatile unsigned long vss_count = 0;
volatile unsigned long tach_count = 0;

void vssISR() {
    vss_count++;
}

void tachISR() {
    tach_count++;
}

void setup() {
    pinMode(LED_PIN, OUTPUT);
    pinMode(PIN_ECT, INPUT);
    pinMode(PIN_TPS, INPUT);
    pinMode(PIN_MAP, INPUT);
    pinMode(PIN_BRAKE, INPUT);
    pinMode(PIN_VBATT, INPUT);
    pinMode(PIN_VSS, INPUT);
    pinMode(PIN_TACH, INPUT);

    attachInterrupt(digitalPinToInterrupt(PIN_VSS), vssISR, RISING);
    attachInterrupt(digitalPinToInterrupt(PIN_TACH), tachISR, RISING);

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

        // Read analog channels
        float ect = analogRead(PIN_ECT) * (VREF / ADC_MAX);
        float tps = analogRead(PIN_TPS) * (VREF / ADC_MAX);
        float map_v = analogRead(PIN_MAP) * (VREF / ADC_MAX);
        float brake = analogRead(PIN_BRAKE) * (VREF / ADC_MAX) * VDIV_RATIO;
        float vbatt = analogRead(PIN_VBATT) * (VREF / ADC_MAX) * VDIV_RATIO;

        // Snapshot and reset pulse counters atomically
        noInterrupts();
        unsigned long vss_snap = vss_count;
        unsigned long tach_snap = tach_count;
        vss_count = 0;
        tach_count = 0;
        interrupts();

        // Calculate RPM from tach pulses in this 40ms window
        float rpm = (tach_snap / TACH_PULSES_PER_REV)
                    * (1000.0f / TELEMETRY_PERIOD_MS)
                    * 60.0f;

        // VSS frequency in Hz
        float vss_hz = vss_snap * (1000.0f / TELEMETRY_PERIOD_MS);

        // Print: "ect tps map brake vbatt rpm vss_hz\n"
        Serial.print(ect, 3);    Serial.print(" ");
        Serial.print(tps, 3);    Serial.print(" ");
        Serial.print(map_v, 3);  Serial.print(" ");
        Serial.print(brake, 2);  Serial.print(" ");
        Serial.print(vbatt, 2);  Serial.print(" ");
        Serial.print(rpm, 0);    Serial.print(" ");
        Serial.println(vss_hz, 1);
    }
}