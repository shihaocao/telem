// Tach Signal Debug - Arduino Mega
// Counts rising edges on pin D18 (INT3) every 1 second

#include <Arduino.h>

volatile unsigned long pulseCount = 0;

void tachISR() {
  pulseCount++;
}

void setup() {
  Serial.begin(115200);
  pinMode(18, INPUT);
  attachInterrupt(digitalPinToInterrupt(18), tachISR, RISING);
  Serial.println("Tach debug started on D18 (INT3)");
  Serial.println("Counting rising edges per second...");
}

void loop() {
  noInterrupts();
  pulseCount = 0;
  interrupts();

  delay(1000);

  noInterrupts();
  unsigned long count = pulseCount;
  interrupts();

  Serial.print("Edges/sec: ");
  Serial.print(count);
  Serial.print("  |  Est RPM (1 pulse/rev): ");
  Serial.println(count * 60);
}
