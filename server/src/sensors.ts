/**
 * Sensor conversion functions for 1992 Honda Accord EX (F22A).
 *
 * Forward conversions (voltage → physical): used by serial-bridge
 * Inverse conversions (physical → voltage): used by gen-data
 */

// ── Shared constants ──

export const ECT_PULLUP_KOHM = 6.65; // Honda ECU internal pull-up, derived from 0.25V @ 190°F (87.8°C)

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
export const ECT_TABLE: [number, number][] = [
  [12.0, -20], [5.0, 0], [2.0, 20], [1.2, 40],
  [0.7, 60], [0.4, 80], [0.2, 100], [0.1, 120],
];

// ── Forward conversions (voltage → physical) ──

/** TPS: 0.5V = 0%, 4.5V = 100%. Clamped to 0–100. */
export function tpsToPercent(v: number): number {
  return Math.max(0, Math.min(100, ((v - 0.5) / 4.0) * 100));
}

/** MAP: Honda 1-bar Denso. 0.5V ≈ 20 kPa, 3.0V ≈ 101 kPa. */
export function mapToKpa(v: number): number {
  return (v - 0.5) * 32.4 + 20;
}

/** ECT: voltage → temperature in °C via resistance lookup. */
export function ectToTempC(v: number): number {
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

// ── Inverse conversions (physical → voltage) ──

/** TPS: throttle % → voltage */
export function tpsToVoltage(pct: number): number {
  return pct * 4.0 / 100 + 0.5;
}

/** MAP: kPa → voltage */
export function mapToVoltage(kpa: number): number {
  return (kpa - 20) / 32.4 + 0.5;
}

/** ECT: temperature °C → voltage */
export function ectToVoltage(tempC: number): number {
  let rKohm: number;
  if (tempC <= ECT_TABLE[0][1]) rKohm = ECT_TABLE[0][0];
  else if (tempC >= ECT_TABLE[ECT_TABLE.length - 1][1]) rKohm = ECT_TABLE[ECT_TABLE.length - 1][0];
  else {
    rKohm = ECT_TABLE[0][0];
    for (let i = 0; i < ECT_TABLE.length - 1; i++) {
      const [r1, t1] = ECT_TABLE[i];
      const [r2, t2] = ECT_TABLE[i + 1];
      if (tempC >= t1 && tempC <= t2) {
        const frac = (tempC - t1) / (t2 - t1);
        rKohm = Math.exp(Math.log(r1) + frac * (Math.log(r2) - Math.log(r1)));
        break;
      }
    }
  }
  return 5 * rKohm / (ECT_PULLUP_KOHM + rKohm);
}
