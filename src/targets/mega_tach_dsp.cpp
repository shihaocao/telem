#include <Arduino.h>
#include "tach_dsp.hpp"

void setup() {
  Serial.begin(115200);
  TachConfig cfg;
  cfg.pin = 18;
  TachDSP::begin(cfg);
  Serial.println("TachDSP started on D18 (PD3)");
  Serial.println("20kHz sampling, 100ms window, 80% threshold edge detection");
}

void loop() {
  if (!TachDSP::available()) return;

  TachResult r = TachDSP::process();

  if (!r.valid) {
    Serial.println("No valid edges");
    return;
  }

  Serial.print("Edges: ");
  Serial.print(r.edgeCount);
  Serial.print("  |  Valid pairs: ");
  Serial.print(r.validPairs);
  Serial.print("  |  Hz: ");
  Serial.print(r.hz, 1);
  Serial.print("  |  RPM: ");
  Serial.println(r.rpm, 0);
}
