// ── SquareWaveDSP.hpp ──
// Generic multi-channel double-buffered square wave frequency measurement
// Single Timer1 ISR at configurable base rate
// Arduino Mega

#pragma once
#include <Arduino.h>

struct DSPResult {
  bool     valid;
  uint8_t  edgeCount;
  uint8_t  validPairs;
  float    hz;
  float    rpm;
};

struct DSPChannel {
  // ── Config (set before begin) ──
  uint8_t  pin;
  uint16_t bufferSize;
  float    maxValidHz;
  float    minValidHz;
  uint8_t  pulsesPerRev;
  uint8_t  edgeWindow;
  uint8_t  thresholdCount;

  // ── Pre-allocated buffer pointers (set before begin) ──
  volatile uint8_t *bufA;
  volatile uint8_t *bufB;

  // ── Internal state (managed by library) ──
  volatile uint8_t *writeBuffer;
  volatile uint8_t *readBuffer;
  volatile uint16_t writeIndex;
  volatile bool     ready;
  volatile uint8_t *pinReg;
  uint8_t           pinMask;
};

namespace SquareWaveDSP {
  void begin(DSPChannel *channels, uint8_t count, uint16_t baseRate);
  DSPResult process(DSPChannel &ch, uint16_t baseRate);
} 