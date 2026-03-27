// ── main.cpp ──
// Mega telemetry: analog sensors + DSP-based tach/VSS
// Outputs at 25Hz over serial to Jetson

#include <Arduino.h>
#include "square_dsp.hpp"

// ── LED ──
constexpr int LED_PIN = LED_BUILTIN;
constexpr uint32_t BLINK_PERIOD_MS = 500;

// ── Telemetry ──
constexpr uint32_t TELEMETRY_PERIOD_MS = 40; // 25 Hz

// Source of truth:
// 2026.03.18:
//
// ECT A8
// TPS A9
// MAP A10
// Brake Indicator voltage divided by 4.3X - A5
// Battery Voltage - voltage divided by 4.3X - A6
// RPM 12V voltage digital square divided by R1=33k R2=22k - D18
// VSS 12V voltage digital square divided by R1=33k R2=22k - D19
// End source of truth

// ── Analog pins ──
constexpr int PIN_ECT   = A8;
constexpr int PIN_TPS   = A9;
constexpr int PIN_MAP   = A10;
constexpr int PIN_BRAKE = A5;
constexpr int PIN_VBATT = A6;

constexpr float VREF       = 5.0f;
constexpr float ADC_MAX    = 1023.0f;
constexpr float VDIV_RATIO = 4.3f;

// ── DSP config ──
static const uint16_t BASE_RATE       = 20000;
static const uint16_t TACH_BUF_SIZE   = 2000;   // 100ms at 20kHz
static const uint16_t VSS_BUF_SIZE    = 1000;   // 50ms at 20kHz
static const uint8_t  EDGE_WINDOW     = 8;
static const uint8_t  THRESHOLD_COUNT = 7;       // ceil(8 * 0.80)

// Tach: F22A 4-cylinder, 2 pulses per crank revolution
constexpr uint8_t TACH_PULSES_PER_REV = 2;

// Total SRAM: 2*(2000+1000) = 6000 bytes, ~2KB headroom

// ── Buffers ──
static uint8_t tachBufA[TACH_BUF_SIZE], tachBufB[TACH_BUF_SIZE];
static uint8_t vssBufA[VSS_BUF_SIZE],   vssBufB[VSS_BUF_SIZE];

// ── Channels ──
DSPChannel channels[2] = {
  { // Tach
    .pin            = 18,
    .bufferSize     = TACH_BUF_SIZE,
    .maxValidHz     = 1000.0,
    .minValidHz     = 5.0,
    .pulsesPerRev   = TACH_PULSES_PER_REV,
    .edgeWindow     = EDGE_WINDOW,
    .thresholdCount = THRESHOLD_COUNT,
    .bufA           = tachBufA,
    .bufB           = tachBufB,
  },
  { // VSS
    .pin            = 19,
    .bufferSize     = VSS_BUF_SIZE,
    .maxValidHz     = 200.0,
    .minValidHz     = 10.0,
    .pulsesPerRev   = 1,          // raw Hz, Jetson calibrates
    .edgeWindow     = EDGE_WINDOW,
    .thresholdCount = THRESHOLD_COUNT,
    .bufA           = vssBufA,
    .bufB           = vssBufB,
  },
};

DSPChannel &tach = channels[0];
DSPChannel &vss  = channels[1];

// ── Latest DSP results (updated asynchronously, read at telemetry rate) ──
static float last_rpm    = 0.0f;
static float last_vss_hz = 0.0f;

void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(PIN_ECT, INPUT);
  pinMode(PIN_TPS, INPUT);
  pinMode(PIN_MAP, INPUT);
  pinMode(PIN_BRAKE, INPUT);
  pinMode(PIN_VBATT, INPUT);

  Serial.begin(115200);
  while (!Serial && millis() < 3000) {}

  SquareWaveDSP::begin(channels, 2, BASE_RATE);
}

void loop() {
  static uint32_t last_blink = 0;
  static uint32_t last_telem = 0;
  uint32_t now = millis();

  // ── Blink ──
  if (now - last_blink >= BLINK_PERIOD_MS) {
    last_blink = now;
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }

  // ── Process DSP buffers as they become ready ──
  if (tach.ready) {
    DSPResult t = SquareWaveDSP::process(tach, BASE_RATE);
    if (t.valid) {
      last_rpm = t.rpm;
    } else {
      last_rpm = 0.0f;
    }
  }

  if (vss.ready) {
    DSPResult v = SquareWaveDSP::process(vss, BASE_RATE);
    if (v.valid) {
      last_vss_hz = v.hz;
    } else {
      last_vss_hz = 0.0f;
    }
  }

  // ── Telemetry output at 25Hz ──
  if (now - last_telem >= TELEMETRY_PERIOD_MS) {
    last_telem = now;

    float ect   = analogRead(PIN_ECT)   * (VREF / ADC_MAX);
    float tps   = analogRead(PIN_TPS)   * (VREF / ADC_MAX);
    float map_v = analogRead(PIN_MAP)   * (VREF / ADC_MAX);
    float brake = analogRead(PIN_BRAKE) * (VREF / ADC_MAX) * VDIV_RATIO;
    float vbatt = analogRead(PIN_VBATT) * (VREF / ADC_MAX) * VDIV_RATIO;

    // Print: "ect tps map brake vbatt rpm vss_hz\n"
    Serial.print(ect, 3);        Serial.print(" ");
    Serial.print(tps, 3);        Serial.print(" ");
    Serial.print(map_v, 3);      Serial.print(" ");
    Serial.print(brake, 2);      Serial.print(" ");
    Serial.print(vbatt, 2);      Serial.print(" ");
    Serial.print(last_rpm, 0);   Serial.print(" ");
    Serial.println(last_vss_hz, 1);
  }
}