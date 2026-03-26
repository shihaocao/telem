// Tach Signal Debug - Arduino Mega
// Counts rising edges on pin D18 (INT3) every 1 second
// With 2ms debounce to filter opto-isolator bounce

#include <Arduino.h>

volatile unsigned long pulseCount = 0;
volatile unsigned long lastEdgeTime = 0;
const unsigned long DEBOUNCE_US = 2000; // 2ms blanking window

void tachISR() {
  unsigned long now = micros();
  if (now - lastEdgeTime > DEBOUNCE_US) {
    pulseCount++;
    lastEdgeTime = now;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(18, INPUT);
  attachInterrupt(digitalPinToInterrupt(18), tachISR, RISING);
  Serial.println("Tach debug started on D18 (INT3)");
  Serial.println("Counting rising edges per second (2ms debounce)...");
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
  Serial.print("  |  Est RPM (2 pulse/rev): ");
  Serial.println(count * 60 / 2);
}
