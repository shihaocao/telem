/**
 * Reads ECU telemetry from Arduino Mega over serial and POSTs to /ingest.
 * Serial format: "ect tps map\n" (space-separated voltages at 10Hz)
 *
 * Vehicle: 1992 Honda Accord EX (F22A1)
 *
 * Sensor conversions:
 *
 *   TPS (Throttle Position Sensor) — Pin A6
 *     Linear 0.5V–4.5V → 0–100%
 *     Formula: throttle_pct = (V - 0.5) / 4.0 * 100
 *     Source: https://easyautodiagnostics.com/honda/2200/testing-the-tps?start=1
 *     Source: https://honda-tech.com/forums/tech-misc-15/diy-how-calibrating-voltage-your-tps-sensor-2947986/
 *
 *   MAP (Manifold Absolute Pressure) — Pin A7
 *     Honda 1-bar Denso sensor, linear.
 *     ~0.5V ≈ 20 kPa (high vacuum/idle), ~3.0V ≈ 101 kPa (atmospheric)
 *     Formula: kPa = (V - 0.5) * 32.4 + 20
 *     At idle: ~1.0–1.3V (~36–46 kPa). At WOT: ~3.0V (~101 kPa)
 *     Source: https://easyautodiagnostics.com/honda/2200/map-sensor-tests
 *
 *   ECT (Engine Coolant Temperature) — Pin A5
 *     NTC thermistor via voltage divider. Nonlinear.
 *     Honda typical resistance: 20kΩ @ -20°C, ~0.1kΩ @ 120°C
 *     Approximate voltage-to-temp lookup (Honda 2-wire ECT sensor):
 *       4.5V ≈ -20°C, 3.5V ≈ 20°C, 2.5V ≈ 60°C, 1.0V ≈ 95°C, 0.5V ≈ 110°C
 *     We use linear interpolation between known points.
 *     Source: https://honda-tech.com/forums/honda-accord-1990-2002-2/coolant-temperature-sensor-question-3008918/
 *
 * Usage: npx tsx scripts/serial-bridge.ts [serial_port]
 *   serial_port defaults to /dev/ttyACM0
 */

import { createInterface } from "readline";
import { createReadStream } from "fs";
import { execSync } from "child_process";

const SERIAL_PORT = process.argv[2] || "/dev/ttyACM0";
const INGEST_URL = process.env.INGEST_URL || "http://localhost:4400/ingest";

// --- Sensor conversions ---

/** TPS: 0.5V = 0%, 4.5V = 100%. Clamped to 0–100. */
function tpsToPercent(v: number): number {
  return Math.max(0, Math.min(100, ((v - 0.5) / 4.0) * 100));
}

/** MAP: Honda 1-bar Denso. 0.5V ≈ 20 kPa, 3.0V ≈ 101 kPa. */
function mapToKpa(v: number): number {
  return (v - 0.5) * 32.4 + 20;
}

/**
 * ECT: NTC thermistor lookup with linear interpolation.
 * Voltage decreases as temperature increases.
 * Points derived from Honda FSM and community measurements.
 */
const ECT_TABLE: [number, number][] = [
  // [voltage, tempC]
  [4.50, -20],
  [3.75,   0],
  [3.50,  20],
  [2.50,  60],
  [1.50,  85],
  [1.00,  95],
  [0.50, 110],
  [0.25, 120],
];

function ectToTempC(v: number): number {
  // Table is sorted descending by voltage
  if (v >= ECT_TABLE[0][0]) return ECT_TABLE[0][1];
  if (v <= ECT_TABLE[ECT_TABLE.length - 1][0]) return ECT_TABLE[ECT_TABLE.length - 1][1];

  for (let i = 0; i < ECT_TABLE.length - 1; i++) {
    const [v1, t1] = ECT_TABLE[i];
    const [v2, t2] = ECT_TABLE[i + 1];
    if (v <= v1 && v >= v2) {
      const frac = (v1 - v) / (v1 - v2);
      return t1 + frac * (t2 - t1);
    }
  }
  return ECT_TABLE[ECT_TABLE.length - 1][1];
}

// --- Main ---

async function main() {
  console.log(`serial-bridge: ${SERIAL_PORT} → ${INGEST_URL}`);

  execSync(`stty -F ${SERIAL_PORT} 115200 raw -echo`);

  const stream = createReadStream(SERIAL_PORT, { encoding: "utf-8" });
  const rl = createInterface({ input: stream });

  rl.on("line", async (line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) return;

    const [ectStr, tpsStr, mapStr] = parts;
    const ectV = parseFloat(ectStr);
    const tpsV = parseFloat(tpsStr);
    const mapV = parseFloat(mapStr);

    if (isNaN(ectV) || isNaN(tpsV) || isNaN(mapV)) return;

    const payload = [
      { channel: "coolant_temp", value: Math.round(ectToTempC(ectV) * 10) / 10 },   // °C
      { channel: "throttle_pos", value: Math.round(tpsToPercent(tpsV) * 10) / 10 },  // %
      { channel: "manifold_pressure", value: Math.round(mapToKpa(mapV) * 10) / 10 }, // kPa
      { channel: "ect_voltage", value: Math.round(ectV * 1000) / 1000 },             // V
      { channel: "tps_voltage", value: Math.round(tpsV * 1000) / 1000 },             // V
      { channel: "map_voltage", value: Math.round(mapV * 1000) / 1000 },             // V
    ];

    try {
      await fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      console.error(`ingest error: ${err.message}`);
    }
  });

  rl.on("close", () => {
    console.log("serial-bridge: serial port closed");
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`serial-bridge: ${err.message}`);
  process.exit(1);
});
