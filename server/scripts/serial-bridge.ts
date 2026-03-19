/**
 * Reads ECU telemetry from Arduino Mega over serial and POSTs to /ingest.
 * Serial format: "ect tps map brake vbatt rpm vss_hz\n" (space-separated, 25Hz)
 *
 * Vehicle: 1992 Honda Accord EX (F22A1)
 *
 * Sensor conversions:
 *
 *   TPS (Throttle Position Sensor) — Pin A9
 *     Linear 0.5V–4.5V → 0–100%
 *     Formula: throttle_pct = (V - 0.5) / 4.0 * 100
 *     Source: https://easyautodiagnostics.com/honda/2200/testing-the-tps?start=1
 *     Source: https://honda-tech.com/forums/tech-misc-15/diy-how-calibrating-voltage-your-tps-sensor-2947986/
 *
 *   MAP (Manifold Absolute Pressure) — Pin A10
 *     Honda 1-bar Denso sensor, linear.
 *     ~0.5V ≈ 20 kPa (high vacuum/idle), ~3.0V ≈ 101 kPa (atmospheric)
 *     Formula: kPa = (V - 0.5) * 32.4 + 20
 *     At idle: ~1.0–1.3V (~36–46 kPa). At WOT: ~3.0V (~101 kPa)
 *     Source: https://easyautodiagnostics.com/honda/2200/map-sensor-tests
 *
 *   ECT (Engine Coolant Temperature) — Pin A8
 *     NTC thermistor via voltage divider. Nonlinear.
 *     Honda typical resistance: 20kΩ @ -20°C, ~0.1kΩ @ 120°C
 *     Approximate voltage-to-temp lookup (Honda 2-wire ECT sensor):
 *       4.5V ≈ -20°C, 3.5V ≈ 20°C, 2.5V ≈ 60°C, 1.0V ≈ 95°C, 0.5V ≈ 110°C
 *     We use linear interpolation between known points.
 *     Conversion: voltage → resistance → temperature (log interpolation on R-T table)
 *     Source: https://honda-tech.com/forums/honda-accord-1990-2002-2/coolant-temperature-sensor-question-3008918/
 *
 *   Brake Indicator — Pin A5
 *     12V brake light circuit through 4.3× voltage divider.
 *     Raw voltage > ~2V = brake pressed (12V / 4.3 ≈ 2.79V)
 *
 *   Battery Voltage — Pin A6
 *     Through 4.3× voltage divider. Already scaled in firmware.
 *
 *   RPM (Tach) — Pin D18 (INT3)
 *     12V square wave through R1=33k R2=20k voltage divider.
 *     4.5 pulses per revolution (measured: 60 edges @ 800rpm, 180 @ 2400rpm).
 *     Firmware computes RPM from ring-buffer averaged frequency.
 *     500ms timeout → 0 when engine off.
 *
 *   VSS (Vehicle Speed Sensor) — Pin D19 (INT2)
 *     12V square wave through R1=33k R2=20k voltage divider.
 *     Ring-buffer averaged frequency in Hz.
 *     Convert to km/h: speed = vss_hz * 3600 / VSS_PULSES_PER_KM
 *     500ms timeout → 0 when stopped.
 *
 * Usage: npx tsx scripts/serial-bridge.ts [serial_port]
 *   serial_port defaults to /dev/ttyACM0
 */

import { createInterface } from "readline";
import { createReadStream } from "fs";
import { execSync } from "child_process";
import { inferGearFromRatio } from "../src/gear.js";

const SERIAL_PORT = process.argv[2] || "/dev/ttyACM0";
const INGEST_URL = process.env.INGEST_URL || "http://localhost:4400/ingest";

// VSS calibration — pulses per km (needs track calibration)
const VSS_PULSES_PER_KM = 4000;

// Brake threshold — firmware already scales by VDIV_RATIO, so this is the 12V-side voltage
const BRAKE_THRESHOLD_V = 6.0; // ~6V means brake light circuit is energized

// --- Sensor conversions ---

function tpsToPercent(v: number): number {
  return Math.max(0, Math.min(100, ((v - 0.5) / 4.0) * 100));
}

function mapToKpa(v: number): number {
  return (v - 0.5) * 32.4 + 20;
}

const ECT_PULLUP_KOHM = 6.65; // Honda ECU internal pull-up, derived from 0.25V @ 190°F (87.8°C)

/**
 * ECT resistance-to-temperature table from Honda FSM:
 *   12.0 kΩ → -20°C    0.7 kΩ →  60°C
 *    5.0 kΩ →   0°C    0.4 kΩ →  80°C
 *    2.0 kΩ →  20°C    0.2 kΩ → 100°C
 *    1.2 kΩ →  40°C    0.1 kΩ → 120°C
 *
 * The Mega reads voltage from a voltage divider: V = 5 * R_therm / (R_pullup + R_therm)
 * Conversion: voltage → resistance → temperature (log interpolation on R-T table)
 */
const ECT_TABLE: [number, number][] = [
  [12.0, -20], [5.0, 0], [2.0, 20], [1.2, 40],
  [0.7, 60], [0.4, 80], [0.2, 100], [0.1, 120],
];

function ectToTempC(v: number): number {
  if (v <= 0 || v >= 5.0) return v <= 0 ? 120 : -20;
  const rKohm = ECT_PULLUP_KOHM * v / (5.0 - v);

  if (rKohm >= ECT_TABLE[0][0]) return ECT_TABLE[0][1];
  if (rKohm <= ECT_TABLE[ECT_TABLE.length - 1][0]) return ECT_TABLE[ECT_TABLE.length - 1][1];

  for (let i = 0; i < ECT_TABLE.length - 1; i++) {
    const [r1, t1] = ECT_TABLE[i];
    const [r2, t2] = ECT_TABLE[i + 1];
    if (rKohm <= r1 && rKohm >= r2) {
      const frac = (Math.log(r1) - Math.log(rKohm)) / (Math.log(r1) - Math.log(r2));
      return t1 + frac * (t2 - t1);
    }
  }
  return ECT_TABLE[ECT_TABLE.length - 1][1];
}

function vssToKph(hz: number): number {
  return hz * 3600 / VSS_PULSES_PER_KM;
}

// --- Main ---

async function main() {
  console.log(`serial-bridge: ${SERIAL_PORT} → ${INGEST_URL}`);
  console.log(`  format: ect tps map brake vbatt rpm vss_hz`);

  execSync(`stty -F ${SERIAL_PORT} 115200 raw -echo`);

  const stream = createReadStream(SERIAL_PORT, { encoding: "utf-8" });
  const rl = createInterface({ input: stream });

  rl.on("line", async (line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 7) return;

    const [ectStr, tpsStr, mapStr, brakeStr, vbattStr, rpmStr, vssStr] = parts;
    const ectV = parseFloat(ectStr);
    const tpsV = parseFloat(tpsStr);
    const mapV = parseFloat(mapStr);
    const brakeV = parseFloat(brakeStr);
    const vbatt = parseFloat(vbattStr);
    const rpmVal = parseFloat(rpmStr);
    const vssHz = parseFloat(vssStr);

    if ([ectV, tpsV, mapV, brakeV, vbatt, rpmVal, vssHz].some(isNaN)) return;

    const speedKph = vssToKph(vssHz);
    const gear = speedKph > 1 ? inferGearFromRatio(rpmVal, speedKph) : 0;

    const payload = [
      // Converted values
      { channel: "coolant_temp", value: Math.round(ectToTempC(ectV) * 10) / 10 },
      { channel: "throttle_pos", value: Math.round(tpsToPercent(tpsV) * 10) / 10 },
      { channel: "manifold_pressure", value: Math.round(mapToKpa(mapV) * 10) / 10 },
      { channel: "brake", value: brakeV > BRAKE_THRESHOLD_V ? 1 : 0 },
      { channel: "battery_voltage", value: Math.round(vbatt * 10) / 10 },
      { channel: "rpm", value: Math.round(rpmVal) },
      { channel: "speed", value: Math.round(speedKph * 10) / 10 },
      { channel: "gear", value: gear },
      // Raw voltages
      { channel: "ect_voltage", value: Math.round(ectV * 1000) / 1000 },
      { channel: "tps_voltage", value: Math.round(tpsV * 1000) / 1000 },
      { channel: "map_voltage", value: Math.round(mapV * 1000) / 1000 },
      { channel: "brake_voltage", value: Math.round(brakeV * 100) / 100 },
      { channel: "vss_hz", value: Math.round(vssHz * 10) / 10 },
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
