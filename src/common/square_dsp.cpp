// ── SquareWaveDSP.cpp ──

#include "square_dsp.hpp"

static DSPChannel *g_channels = nullptr;
static uint8_t     g_count    = 0;

static inline void sampleChannel(DSPChannel &ch) {
  ch.writeBuffer[ch.writeIndex] = (*ch.pinReg & ch.pinMask) ? 1 : 0;
  ch.writeIndex++;
  if (ch.writeIndex >= ch.bufferSize) {
    ch.writeIndex = 0;
    if (!ch.ready) {
      volatile uint8_t *temp = ch.writeBuffer;
      ch.writeBuffer = ch.readBuffer;
      ch.readBuffer = temp;
      ch.ready = true;
    }
  }
}

ISR(TIMER1_COMPA_vect) {
  for (uint8_t i = 0; i < g_count; i++) {
    sampleChannel(g_channels[i]);
  }
}

static uint8_t findRisingEdges(volatile uint8_t *buf, uint16_t len,
                                uint16_t *edgePositions, uint8_t maxEdges,
                                uint8_t edgeWindow, uint8_t thresholdCount) {
  uint8_t edgeCount = 0;
  uint16_t i = edgeWindow;

  while (i < len - edgeWindow && edgeCount < maxEdges) {
    if (buf[i] == 1 && buf[i - 1] == 0) {

      uint8_t lowCount = 0;
      for (uint8_t j = 0; j < edgeWindow; j++) {
        if (buf[i - 1 - j] == 0) lowCount++;
      }

      uint8_t highCount = 0;
      for (uint8_t j = 0; j < edgeWindow; j++) {
        if (buf[i + j] == 1) highCount++;
      }

      if (lowCount >= thresholdCount && highCount >= thresholdCount) {
        edgePositions[edgeCount] = i;
        edgeCount++;
        i += edgeWindow;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return edgeCount;
}

static void initChannel(DSPChannel &ch) {
  pinMode(ch.pin, INPUT);
  ch.pinReg      = portInputRegister(digitalPinToPort(ch.pin));
  ch.pinMask     = digitalPinToBitMask(ch.pin);
  ch.writeBuffer = ch.bufA;
  ch.readBuffer  = ch.bufB;
  ch.writeIndex  = 0;
  ch.ready       = false;
}

void SquareWaveDSP::begin(DSPChannel *channels, uint8_t count, uint16_t baseRate) {
  g_channels = channels;
  g_count    = count;

  for (uint8_t i = 0; i < count; i++) {
    initChannel(channels[i]);
  }

  uint16_t compareVal = (F_CPU / 8 / baseRate) - 1;
  TCCR1A = 0;
  TCCR1B = (1 << WGM12) | (1 << CS11);
  OCR1A  = compareVal;
  TIMSK1 = (1 << OCIE1A);
}

DSPResult SquareWaveDSP::process(DSPChannel &ch, uint16_t baseRate) {
  DSPResult result = {false, 0, 0, 0.0, 0.0};
  ch.ready = false;

  uint16_t edgePositions[64];
  result.edgeCount = findRisingEdges(ch.readBuffer, ch.bufferSize,
                                      edgePositions, 64,
                                      ch.edgeWindow, ch.thresholdCount);

  if (result.edgeCount < 2) return result;

  float totalPeriod = 0;

  for (uint8_t i = 1; i < result.edgeCount; i++) {
    uint16_t periodSamples = edgePositions[i] - edgePositions[i - 1];
    float hz = (float)baseRate / periodSamples;

    if (hz >= ch.minValidHz && hz <= ch.maxValidHz) {
      totalPeriod += periodSamples;
      result.validPairs++;
    }
  }

  if (result.validPairs == 0) return result;

  float avgPeriod = totalPeriod / result.validPairs;
  result.hz  = (float)baseRate / avgPeriod;
  result.rpm = result.hz * 60.0 / ch.pulsesPerRev;
  result.valid = true;

  return result;
}