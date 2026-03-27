// ── main.cpp ──

#include <Arduino.h>
#include "square_dsp.hpp"

// ── Constants ──
static const uint16_t BASE_RATE      = 20000;
static const uint8_t  TACH_PIN       = 18;
static const uint8_t  VSS_PIN        = 19;
static const uint16_t TACH_BUF_SIZE  = 2000;    // 100ms at 20kHz
static const uint16_t VSS_BUF_SIZE   = 1000;    // 50ms at 20kHz
static const uint8_t  EDGE_WINDOW    = 8;
static const uint8_t  THRESHOLD_COUNT = 7;       // ceil(8 * 0.80)

// Total SRAM: 2*(2000+1000) = 6000 bytes, ~2KB headroom

// ── Buffers ──
static uint8_t tachBufA[TACH_BUF_SIZE], tachBufB[TACH_BUF_SIZE];
static uint8_t vssBufA[VSS_BUF_SIZE],   vssBufB[VSS_BUF_SIZE];

// ── Channels ──
DSPChannel channels[2] = {
  { // Tach
    .pin            = TACH_PIN,
    .bufferSize     = TACH_BUF_SIZE,
    .maxValidHz     = 1000.0,
    .minValidHz     = 5.0,
    .pulsesPerRev   = 2,
    .edgeWindow     = EDGE_WINDOW,
    .thresholdCount = THRESHOLD_COUNT,
    .bufA           = tachBufA,
    .bufB           = tachBufB,
  },
  { // VSS
    .pin            = VSS_PIN,
    .bufferSize     = VSS_BUF_SIZE,
    .maxValidHz     = 200.0,
    .minValidHz     = 10.0,
    .pulsesPerRev   = 1,
    .edgeWindow     = EDGE_WINDOW,
    .thresholdCount = THRESHOLD_COUNT,
    .bufA           = vssBufA,
    .bufB           = vssBufB,
  },
};

DSPChannel &tach = channels[0];
DSPChannel &vss  = channels[1];

void setup() {
  Serial.begin(115200);
  SquareWaveDSP::begin(channels, 2, BASE_RATE);
  Serial.println("Tach+VSS DSP started");
}

void loop() {
  if (tach.ready) {
    DSPResult t = SquareWaveDSP::process(tach, BASE_RATE);
    if (t.valid) {
      Serial.print("TACH  Hz: ");
      Serial.print(t.hz, 1);
      Serial.print("  RPM: ");
      Serial.println(t.rpm, 0);
    }
  }

  if (vss.ready) {
    DSPResult v = SquareWaveDSP::process(vss, BASE_RATE);
    if (v.valid) {
      Serial.print("VSS   Hz: ");
      Serial.println(v.hz, 1);
    }
  }
}