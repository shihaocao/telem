// 1992 Honda Accord EX — H2U5 5-speed manual (F22A4/F22A6)
const TIRE_CIRCUMFERENCE_M = Math.PI * (15 * 0.0254 + 2 * 0.195 * 0.50); // ~1.810m

const TRANS = {
  gearRatios: [3.307, 1.809, 1.185, 0.870, 0.685],
  finalDrive: 4.062,
};

function expectedRpmPerKph(gearRatio: number): number {
  return (1 / 3.6) / TIRE_CIRCUMFERENCE_M * gearRatio * TRANS.finalDrive * 60;
}

export const GEAR_RPM_PER_KPH = TRANS.gearRatios.map(expectedRpmPerKph);
export const GEAR_COUNT = TRANS.gearRatios.length;

export function rpmFromSpeedAndGear(speedKph: number, gear: number): number {
  if (gear < 1 || gear > GEAR_COUNT) return 0;
  return speedKph * GEAR_RPM_PER_KPH[gear - 1];
}

export function optimalGear(speedKph: number, minRpm = 2000, maxRpm = 7000): number {
  for (let g = GEAR_COUNT; g >= 1; g--) {
    const rpm = rpmFromSpeedAndGear(speedKph, g);
    if (rpm >= minRpm && rpm <= maxRpm) return g;
  }
  return 1;
}

export function inferGearFromRatio(rpm: number, speedKph: number): number {
  const observedRatio = rpm / speedKph;
  let bestGear = 1;
  let bestDiff = Infinity;
  GEAR_RPM_PER_KPH.forEach((expected, i) => {
    const diff = Math.abs(observedRatio - expected);
    if (diff < bestDiff) { bestDiff = diff; bestGear = i + 1; }
  });
  return bestGear;
}

// ── Shift detection + state machine ──

const RPM_DOT_THRESHOLD = 500;
const SHIFT_MASK_MS = 300;

type ShiftDirection = "up" | "down" | "unknown";

export function detectShiftWindows(rpmSamples: number[], timestampsMs: number[]): boolean[] {
  const inShift = new Array(rpmSamples.length).fill(false);
  for (let i = 1; i < rpmSamples.length; i++) {
    const dt = (timestampsMs[i] - timestampsMs[i - 1]) / 1000;
    if (dt <= 0) continue;
    if (Math.abs((rpmSamples[i] - rpmSamples[i - 1]) / dt) > RPM_DOT_THRESHOLD) {
      for (let j = 0; j < rpmSamples.length; j++) {
        if (Math.abs(timestampsMs[j] - timestampsMs[i]) <= SHIFT_MASK_MS) inShift[j] = true;
      }
    }
  }
  return inShift;
}

function inferShiftDirection(rpmBefore: number, rpmAfter: number): ShiftDirection {
  const delta = rpmAfter - rpmBefore;
  if (delta < -300) return "up";
  if (delta > 300) return "down";
  return "unknown";
}

function isGearChangePlausible(from: number, to: number, direction: ShiftDirection): boolean {
  if (direction === "up") return to > from;
  if (direction === "down") return to < from;
  return true;
}

const REQUIRED_STABLE_SAMPLES = 5;

interface GearState {
  gear: number;
  stableCount: number;
  pendingGear: number | null;
  lastShiftDirection: ShiftDirection;
}

export interface TelemetrySample { timestampMs: number; rpm: number; speedKph: number; }
export interface GearSample { timestampMs: number; gear: number; inShift: boolean; }

export function processGearTelemetry(samples: TelemetrySample[]): GearSample[] {
  const rpms = samples.map((s) => s.rpm);
  const timestamps = samples.map((s) => s.timestampMs);
  const shiftWindows = detectShiftWindows(rpms, timestamps);

  let state: GearState = { gear: 1, stableCount: 0, pendingGear: null, lastShiftDirection: "unknown" };
  const results: GearSample[] = [];

  for (let i = 0; i < samples.length; i++) {
    const { timestampMs, rpm, speedKph } = samples[i];
    if (speedKph < 1) { results.push({ timestampMs, gear: 0, inShift: false }); continue; }

    const inShift = shiftWindows[i];
    const inferredGear = inferGearFromRatio(rpm, speedKph);

    let shiftDirection: ShiftDirection = "unknown";
    if (inShift && i > 0 && !shiftWindows[i - 1]) {
      shiftDirection = inferShiftDirection(rpms[i - 1], rpm);
    }

    if (inShift) {
      state = { ...state, stableCount: 0, pendingGear: null, lastShiftDirection: shiftDirection !== "unknown" ? shiftDirection : state.lastShiftDirection };
    } else if (!isGearChangePlausible(state.gear, inferredGear, state.lastShiftDirection)) {
      state = { ...state, stableCount: 0, pendingGear: null };
    } else if (inferredGear === state.gear) {
      state = { ...state, stableCount: state.stableCount + 1, pendingGear: null };
    } else {
      const newCount = (state.pendingGear === inferredGear ? state.stableCount : 0) + 1;
      if (newCount >= REQUIRED_STABLE_SAMPLES) {
        state = { gear: inferredGear, stableCount: 0, pendingGear: null, lastShiftDirection: "unknown" };
      } else {
        state = { ...state, stableCount: newCount, pendingGear: inferredGear };
      }
    }

    results.push({ timestampMs, gear: state.gear, inShift });
  }

  return results;
}
