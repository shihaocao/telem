// ── TachDSP.cpp ──

#include "tach_dsp.hpp"

// ── Internal state ──
static TachConfig cfg;

// Resolved at begin() from cfg.pin via Arduino's pin-to-port lookup tables
static volatile uint8_t *pinReg;
static uint8_t           pinMask;

static volatile uint8_t bufferA[2000];
static volatile uint8_t bufferB[2000];
static volatile uint8_t *writeBuffer = bufferA;
static volatile uint8_t *readBuffer  = bufferB;
static volatile uint16_t writeIndex  = 0;
static volatile bool bufferReady     = false;

// ── ISR: sample the configured pin at sampleRate ──
ISR(TIMER1_COMPA_vect) {
  writeBuffer[writeIndex] = (*pinReg & pinMask) ? 1 : 0;
  writeIndex++;
  if (writeIndex >= cfg.bufferSize) {
    writeIndex = 0;
    if (!bufferReady) {
      volatile uint8_t *temp = writeBuffer;
      writeBuffer = readBuffer;
      readBuffer = temp;
      bufferReady = true;
    }
  }
}

// ── Edge detection ──
static uint8_t findRisingEdges(volatile uint8_t *buf, uint16_t len,
                                uint16_t *edgePositions, uint8_t maxEdges) {
  uint8_t edgeCount = 0;
  uint16_t i = cfg.edgeWindow;

  while (i < len - cfg.edgeWindow && edgeCount < maxEdges) {
    if (buf[i] == 1 && buf[i - 1] == 0) {

      uint8_t lowCount = 0;
      for (uint8_t j = 0; j < cfg.edgeWindow; j++) {
        if (buf[i - 1 - j] == 0) lowCount++;
      }

      uint8_t highCount = 0;
      for (uint8_t j = 0; j < cfg.edgeWindow; j++) {
        if (buf[i + j] == 1) highCount++;
      }

      if (lowCount >= cfg.thresholdCount && highCount >= cfg.thresholdCount) {
        edgePositions[edgeCount] = i;
        edgeCount++;
        i += cfg.edgeWindow;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return edgeCount;
}

// ── Public API ──

void TachDSP::begin(const TachConfig &config) {
  cfg = config;
  pinMode(cfg.pin, INPUT);

  // Resolve pin to port INPUT register + bitmask once using Arduino's built-in
  // lookup tables (pins_arduino.h), so the ISR never calls any lookup at runtime
  pinReg  = portInputRegister(digitalPinToPort(cfg.pin));
  pinMask = digitalPinToBitMask(cfg.pin);

  // Timer1 CTC mode, prescaler=8
  // OCR1A = (16MHz / 8 / sampleRate) - 1
  uint16_t compareVal = (F_CPU / 8 / cfg.sampleRate) - 1;
  TCCR1A = 0;
  TCCR1B = (1 << WGM12) | (1 << CS11);
  OCR1A = compareVal;
  TIMSK1 = (1 << OCIE1A);
}

bool TachDSP::available() {
  return bufferReady;
}

TachResult TachDSP::process() {
  TachResult result = {false, 0, 0, 0.0, 0.0};
  bufferReady = false;

  uint16_t edgePositions[64];
  result.edgeCount = findRisingEdges(readBuffer, cfg.bufferSize, edgePositions, 64);

  if (result.edgeCount < 2) return result;

  float totalPeriod = 0;

  for (uint8_t i = 1; i < result.edgeCount; i++) {
    uint16_t periodSamples = edgePositions[i] - edgePositions[i - 1];
    float hz = (float)cfg.sampleRate / periodSamples;

    if (hz >= cfg.minValidHz && hz <= cfg.maxValidHz) {
      totalPeriod += periodSamples;
      result.validPairs++;
    }
  }

  if (result.validPairs == 0) return result;

  float avgPeriodSamples = totalPeriod / result.validPairs;
  result.hz = (float)cfg.sampleRate / avgPeriodSamples;
  result.rpm = result.hz * 60.0 / cfg.pulsesPerRev;
  result.valid = true;

  return result;
}
