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
// RPM 12V voltage digital square divided by R1=33k R2=20k - D18
// VSS 12V voltage digital square divided by R1=33k R2=20k - D19
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
constexpr int PIN_TACH = 18;
constexpr int PIN_VSS  = 19;

// Tach: measured 60 edges @ 800rpm, 180 edges @ 2400rpm → 4.5 pulses/rev
constexpr float TACH_PULSES_PER_REV = 4.5f;

// Ring buffer size for period averaging
constexpr int RING_N = 30;

// Timeout: if no pulse for this long, signal is considered dead (e.g. engine off)
constexpr unsigned long SIGNAL_TIMEOUT_US = 500000; // 500ms

struct PulseRing {
    volatile unsigned long timestamps[RING_N];
    volatile int head;           // next write index
    volatile int count;          // how many valid entries (0..RING_N)
    volatile unsigned long last_pulse_us;

    void init() {
        head = 0;
        count = 0;
        last_pulse_us = 0;
        for (int i = 0; i < RING_N; i++) timestamps[i] = 0;
    }

    void recordPulse() {
        unsigned long now = micros();
        timestamps[head] = now;
        head = (head + 1) % RING_N;
        if (count < RING_N) count++;
        last_pulse_us = now;
    }

    // Returns average frequency in Hz, called from main loop with interrupts disabled
    float avgFrequency(unsigned long now_us) const {
        // Signal dead?
        if (count < 2) return 0.0f;
        if ((now_us - last_pulse_us) > SIGNAL_TIMEOUT_US) return 0.0f;

        // Find oldest and newest timestamps in the buffer
        // newest is at (head - 1), oldest is at (head - count)
        int newest_idx = (head - 1 + RING_N) % RING_N;
        int oldest_idx = (head - count + RING_N) % RING_N;

        unsigned long newest = timestamps[newest_idx];
        unsigned long oldest = timestamps[oldest_idx];
        unsigned long span = newest - oldest; // micros wraps correctly via unsigned subtraction

        if (span == 0) return 0.0f;

        // (count - 1) periods span this time range
        return (float)(count - 1) * 1000000.0f / (float)span;
    }
};

volatile PulseRing tach_ring;
volatile PulseRing vss_ring;

void tachISR() {
    ((PulseRing*)&tach_ring)->recordPulse();
}

void vssISR() {
    ((PulseRing*)&vss_ring)->recordPulse();
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

    ((PulseRing*)&tach_ring)->init();
    ((PulseRing*)&vss_ring)->init();

    attachInterrupt(digitalPinToInterrupt(PIN_TACH), tachISR, RISING);
    attachInterrupt(digitalPinToInterrupt(PIN_VSS), vssISR, RISING);

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

        // Snapshot ring buffer state with interrupts disabled
        noInterrupts();
        unsigned long now_us = micros();
        float tach_hz = ((PulseRing*)&tach_ring)->avgFrequency(now_us);
        float vss_hz = ((PulseRing*)&vss_ring)->avgFrequency(now_us);
        interrupts();

        // RPM from tach frequency
        float rpm = tach_hz * 60.0f / TACH_PULSES_PER_REV;

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