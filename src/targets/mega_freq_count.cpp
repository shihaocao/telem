// Tach Signal Processing - Arduino Mega
// Samples D18 (PD3) at 20kHz, analyzes buffer every 100ms
// Detects rising edges using 80% threshold voting
// Double-buffered to avoid blocking interrupts

#include <Arduino.h>

// ── Configuration ──
const uint16_t SAMPLE_RATE = 20000;          // Hz
const uint16_t BUFFER_SIZE = 2000;           // 100ms at 20kHz
const uint8_t EDGE_WINDOW = 8;              // samples on each side of candidate edge
const uint8_t THRESHOLD_COUNT = 7;          // ceil(8 * 0.80) = 7 of 8 must agree
const float MAX_VALID_HZ = 1000.0;          // reject frequencies above this
const float MIN_VALID_HZ = 5.0;             // reject frequencies below this

// ── Double Buffer ──
volatile uint8_t bufferA[BUFFER_SIZE];
volatile uint8_t bufferB[BUFFER_SIZE];
volatile uint8_t *writeBuffer = bufferA;     // ISR writes here
volatile uint8_t *readBuffer = bufferB;      // main loop reads here
volatile uint16_t writeIndex = 0;
volatile bool bufferReady = false;

// ── ISR: sample D18 at 20kHz ──
ISR(TIMER1_COMPA_vect) {
  writeBuffer[writeIndex] = (PIND >> 3) & 1;
  writeIndex++;
  if (writeIndex >= BUFFER_SIZE) {
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
uint8_t findRisingEdges(volatile uint8_t *buf, uint16_t len, uint16_t *edgePositions, uint8_t maxEdges) {
  uint8_t edgeCount = 0;
  uint16_t i = EDGE_WINDOW;

  while (i < len - EDGE_WINDOW && edgeCount < maxEdges) {
    if (buf[i] == 1 && buf[i - 1] == 0) {

      uint8_t lowCount = 0;
      for (uint8_t j = 0; j < EDGE_WINDOW; j++) {
        if (buf[i - 1 - j] == 0) lowCount++;
      }

      uint8_t highCount = 0;
      for (uint8_t j = 0; j < EDGE_WINDOW; j++) {
        if (buf[i + j] == 1) highCount++;
      }

      if (lowCount >= THRESHOLD_COUNT && highCount >= THRESHOLD_COUNT) {
        edgePositions[edgeCount] = i;
        edgeCount++;
        i += EDGE_WINDOW;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return edgeCount;
}

void setup() {
  Serial.begin(115200);
  pinMode(18, INPUT);

  // Timer1 CTC mode, prescaler=8
  // 16MHz / 8 / 100 = 20000Hz
  TCCR1A = 0;
  TCCR1B = (1 << WGM12) | (1 << CS11);
  OCR1A = 99;
  TIMSK1 = (1 << OCIE1A);

  Serial.println("Tach DSP on D18 (PD3)");
  Serial.println("Sample rate: 20kHz, Window: 100ms, Double buffered");
}

void loop() {
  if (!bufferReady) return;
  bufferReady = false;

  // readBuffer is safe to access — ISR is writing to the other one
  uint16_t edgePositions[64];
  uint8_t edgeCount = findRisingEdges(readBuffer, BUFFER_SIZE, edgePositions, 64);

  if (edgeCount < 2) {
    Serial.println("Not enough edges detected");
    return;
  }

  float totalPeriod = 0;
  uint8_t validPairs = 0;

  for (uint8_t i = 1; i < edgeCount; i++) {
    uint16_t periodSamples = edgePositions[i] - edgePositions[i - 1];
    float hz = (float)SAMPLE_RATE / periodSamples;

    if (hz >= MIN_VALID_HZ && hz <= MAX_VALID_HZ) {
      totalPeriod += periodSamples;
      validPairs++;
    }
  }

  if (validPairs == 0) {
    Serial.println("No valid edge pairs found");
    return;
  }

  float avgPeriodSamples = totalPeriod / validPairs;
  float hz = (float)SAMPLE_RATE / avgPeriodSamples;
  float rpm = hz * 60.0 / 2.0;

  Serial.print("Edges: ");
  Serial.print(edgeCount);
  Serial.print("  |  Valid pairs: ");
  Serial.print(validPairs);
  Serial.print("  |  Hz: ");
  Serial.print(hz, 1);
  Serial.print("  |  RPM: ");
  Serial.println(rpm, 0);
}