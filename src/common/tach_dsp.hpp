// ── TachDSP.hpp ──
// Double-buffered 20kHz sampling with 80% threshold edge detection
// Uses Timer1 on Arduino Mega. Pin is specified in TachConfig.

#pragma once
#include <Arduino.h>

struct TachConfig {
  uint8_t  pin;                       // digital input pin (any Mega digital pin)
  uint16_t sampleRate    = 20000;     // Hz
  uint16_t bufferSize    = 2000;      // samples per window
  uint8_t  edgeWindow    = 8;         // samples on each side of candidate edge
  uint8_t  thresholdCount = 7;        // min agreeing samples (ceil(edgeWindow * 0.80))
  float    maxValidHz    = 1000.0;    // reject above this
  float    minValidHz    = 5.0;       // reject below this
  uint8_t  pulsesPerRev  = 2;         // F22A: 2 pulses per crank revolution
};

struct TachResult {
  bool     valid;                     // true if we got usable data
  uint8_t  edgeCount;                 // total rising edges found
  uint8_t  validPairs;                // edge pairs within valid Hz range
  float    hz;                        // averaged frequency
  float    rpm;                       // computed RPM
};

namespace TachDSP {
  void begin(const TachConfig &config);
  bool available();                   // true when a buffer is ready for analysis
  TachResult process();               // analyze the ready buffer, return results
}
