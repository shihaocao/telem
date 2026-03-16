/**
 * Generates dummy race telemetry and POSTs it to the ingest endpoint.
 *
 * Usage: tsx scripts/gen-data.ts [--url http://localhost:4400] [--hz 50] [--duration 120]
 *
 * Simulates a car on a loop with straights and corners:
 *   - Straights: full throttle, RPM climbs, brakes off, wheel temps slowly cool
 *   - Braking zones: throttle off, heavy braking, RPM drops, front wheel temps spike
 *   - Corners: partial throttle, no brake, rear temps rise from traction
 *   - Corner exit: progressive throttle back on
 */

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE_URL = arg("url", "http://localhost:4400");
const HZ = parseInt(arg("hz", "50"), 10);
const DURATION_S = parseInt(arg("duration", "120"), 10);

// track is a sequence of segments the car loops through
type SegmentType = "straight" | "braking" | "corner" | "corner_exit";
interface Segment {
  type: SegmentType;
  duration: number; // seconds
}

const TRACK: Segment[] = [
  { type: "straight", duration: 6 },
  { type: "braking", duration: 1.5 },
  { type: "corner", duration: 3 },
  { type: "corner_exit", duration: 2 },
  { type: "straight", duration: 4 },
  { type: "braking", duration: 1.2 },
  { type: "corner", duration: 2.5 },
  { type: "corner_exit", duration: 1.8 },
  { type: "straight", duration: 8 },
  { type: "braking", duration: 2 },
  { type: "corner", duration: 4 },
  { type: "corner_exit", duration: 2.5 },
  { type: "straight", duration: 3 },
  { type: "braking", duration: 1 },
  { type: "corner", duration: 2 },
  { type: "corner_exit", duration: 1.5 },
];

const LAP_DURATION = TRACK.reduce((s, seg) => s + seg.duration, 0);

function getSegment(t: number): { seg: Segment; progress: number } {
  const lapT = t % LAP_DURATION;
  let elapsed = 0;
  for (const seg of TRACK) {
    if (lapT < elapsed + seg.duration) {
      return { seg, progress: (lapT - elapsed) / seg.duration };
    }
    elapsed += seg.duration;
  }
  return { seg: TRACK[TRACK.length - 1], progress: 1 };
}

// state
let rpm = 4000;
let throttle = 0;
let brake = 0;
let speed = 80; // km/h
const wheelTemp = { fl: 85, fr: 85, rl: 80, rr: 80 }; // °C

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function jitter(v: number, amount: number): number {
  return v + (Math.random() - 0.5) * 2 * amount;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function step(dt: number, seg: Segment, progress: number): void {
  switch (seg.type) {
    case "straight":
      throttle = lerp(throttle, clamp(95 + Math.random() * 5, 95, 100), dt * 4);
      brake = lerp(brake, 0, dt * 10);
      rpm = lerp(rpm, clamp(rpm + 800 * dt, 4000, 13500), dt * 3);
      speed = lerp(speed, clamp(speed + 40 * dt, 80, 310), dt * 2);
      // gear shifts — RPM drops on upshift
      if (rpm > 12800) rpm = 9500;
      break;

    case "braking":
      throttle = lerp(throttle, 0, dt * 12);
      brake = lerp(brake, clamp(80 + progress * 20, 80, 100), dt * 8);
      rpm = lerp(rpm, clamp(rpm - 3000 * dt, 3500, 13500), dt * 5);
      speed = lerp(speed, clamp(speed - 120 * dt, 60, 310), dt * 4);
      // front wheels heat up under braking
      wheelTemp.fl += dt * 25;
      wheelTemp.fr += dt * 25;
      break;

    case "corner":
      throttle = lerp(throttle, clamp(20 + progress * 30, 15, 60), dt * 5);
      brake = lerp(brake, clamp(10 - progress * 10, 0, 15), dt * 6);
      rpm = lerp(rpm, clamp(7000 + progress * 2000, 5000, 11000), dt * 3);
      speed = lerp(speed, clamp(80 + progress * 30, 60, 140), dt * 3);
      // rear wheels heat from traction
      wheelTemp.rl += dt * 12;
      wheelTemp.rr += dt * 12;
      break;

    case "corner_exit":
      throttle = lerp(throttle, clamp(50 + progress * 50, 50, 100), dt * 4);
      brake = lerp(brake, 0, dt * 10);
      rpm = lerp(rpm, clamp(8000 + progress * 3000, 6000, 12000), dt * 3);
      speed = lerp(speed, clamp(speed + 30 * dt, 80, 200), dt * 2);
      // rear wheels still working
      wheelTemp.rl += dt * 6;
      wheelTemp.rr += dt * 6;
      break;
  }

  // ambient cooling on all wheels
  const ambientTarget = 75;
  const coolRate = dt * 3;
  wheelTemp.fl = lerp(wheelTemp.fl, ambientTarget, coolRate);
  wheelTemp.fr = lerp(wheelTemp.fr, ambientTarget, coolRate);
  wheelTemp.rl = lerp(wheelTemp.rl, ambientTarget, coolRate);
  wheelTemp.rr = lerp(wheelTemp.rr, ambientTarget, coolRate);

  // clamp everything
  throttle = clamp(throttle, 0, 100);
  brake = clamp(brake, 0, 100);
  rpm = clamp(rpm, 2500, 13500);
  speed = clamp(speed, 30, 320);
  wheelTemp.fl = clamp(wheelTemp.fl, 60, 140);
  wheelTemp.fr = clamp(wheelTemp.fr, 60, 140);
  wheelTemp.rl = clamp(wheelTemp.rl, 60, 130);
  wheelTemp.rr = clamp(wheelTemp.rr, 60, 130);
}

async function send(batch: unknown[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  if (!res.ok) {
    throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const dt = 1 / HZ;
  const tickMs = 1000 / HZ;
  let t = 0;
  let totalSent = 0;

  console.log(`streaming live at ${HZ}Hz for ${DURATION_S}s → ${BASE_URL}  (ctrl-c to stop)`);

  const startReal = performance.now();

  for (let i = 0; i < HZ * DURATION_S; i++) {
    const { seg, progress } = getSegment(t);
    step(dt, seg, progress);
    const ts = Date.now();

    const batch = [
      { channel: "rpm", value: Math.round(jitter(rpm, 30)), ts },
      { channel: "speed", value: Math.round(jitter(speed, 0.5) * 10) / 10, ts },
      { channel: "throttle", value: Math.round(jitter(throttle, 0.5) * 10) / 10, ts },
      { channel: "brake", value: Math.round(jitter(brake, 0.3) * 10) / 10, ts },
      { channel: "wheel_temp_fl", value: Math.round(jitter(wheelTemp.fl, 0.3) * 10) / 10, ts },
      { channel: "wheel_temp_fr", value: Math.round(jitter(wheelTemp.fr, 0.3) * 10) / 10, ts },
      { channel: "wheel_temp_rl", value: Math.round(jitter(wheelTemp.rl, 0.3) * 10) / 10, ts },
      { channel: "wheel_temp_rr", value: Math.round(jitter(wheelTemp.rr, 0.3) * 10) / 10, ts },
    ];

    await send(batch);
    totalSent += 8;
    t += dt;

    // sleep to maintain real-time pacing
    const expected = (i + 1) * tickMs;
    const elapsed = performance.now() - startReal;
    const drift = expected - elapsed;
    if (drift > 1) await sleep(drift);
  }

  console.log(`done — ${totalSent} entries streamed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
