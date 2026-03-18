/**
 * Generates dummy race telemetry and POSTs it to the ingest endpoint.
 *
 * Usage: tsx scripts/gen-data.ts [--url http://localhost:4400] [--hz 50] [--duration 120]
 *
 * Simulates a car driving laps around Sonoma Raceway with:
 *   - GPS position (lat/lon following the track polyline)
 *   - GPS speed, heading
 *   - G-forces (lateral + longitudinal)
 *   - Throttle position, coolant temp, manifold pressure (ECU channels)
 *   - Speed (ECU)
 */

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE_URL = arg("url", "http://localhost:4400");
const HZ = parseInt(arg("hz", "50"), 10);
const DURATION_S = parseInt(arg("duration", "0"), 10); // 0 = run forever

// Sonoma Raceway simplified track polyline (subset of full track)
const TRACK_POINTS: [number, number][] = [
  [38.1667017,-122.4621707],[38.1662819,-122.4615061],[38.1657488,-122.4606993],
  [38.1656475,-122.4602444],[38.1655235,-122.4599228],[38.1653371,-122.4596693],
  [38.1650062,-122.4592699],[38.1648987,-122.4589415],[38.164874,-122.4585675],
  [38.1648118,-122.4578599],[38.1645834,-122.4574578],[38.1631171,-122.4552131],
  [38.1629691,-122.4550213],[38.1628299,-122.4550778],[38.1626919,-122.4551892],
  [38.1625694,-122.4551408],[38.1624583,-122.4548244],[38.1623648,-122.4543013],
  [38.1623079,-122.4537997],[38.1621516,-122.4534209],[38.1619794,-122.4531998],
  [38.1617218,-122.4529933],[38.161362,-122.4528203],[38.1606777,-122.4525471],
  [38.1594297,-122.4520654],[38.1588705,-122.4518716],[38.1587138,-122.4518912],
  [38.1585873,-122.4520476],[38.1585761,-122.4522239],[38.1586632,-122.4524153],
  [38.1587918,-122.452515],[38.1597011,-122.4528785],[38.1604236,-122.4531788],
  [38.1606313,-122.4533357],[38.1607621,-122.4535011],[38.161504,-122.4546997],
  [38.1620664,-122.455692],[38.1621053,-122.455955],[38.1621074,-122.4561323],
  [38.1621101,-122.4571156],[38.1620694,-122.4574503],[38.1619959,-122.4576351],
  [38.1618098,-122.4579616],[38.1616363,-122.4581702],[38.1614163,-122.4583219],
  [38.1611457,-122.4585053],[38.1610411,-122.4586743],[38.1609953,-122.4589926],
  [38.1610623,-122.4592498],[38.1612813,-122.4596092],[38.161531,-122.4599354],
  [38.1618617,-122.4603302],[38.1621279,-122.4606162],[38.1623328,-122.4607735],
  [38.1625688,-122.4610667],[38.1626211,-122.461267],[38.1626251,-122.461445],
  [38.1625949,-122.4619232],[38.1626129,-122.4621569],[38.1626432,-122.4622236],
  [38.162712,-122.4623387],[38.1628402,-122.4624846],[38.163839,-122.4633171],
  [38.1640716,-122.4634222],[38.1641815,-122.4633823],[38.1643135,-122.4631284],
  [38.1645243,-122.4620834],[38.1645466,-122.4618003],[38.1645111,-122.4614858],
  [38.1644058,-122.4611456],[38.1642304,-122.4608195],[38.1640659,-122.4606354],
  [38.1629009,-122.4596693],[38.1627457,-122.4594891],[38.1626124,-122.4591549],
  [38.1625886,-122.45894],[38.1626078,-122.4587174],[38.1626692,-122.4585242],
  [38.1627721,-122.4583285],[38.1628902,-122.4581818],[38.1630246,-122.4580882],
  [38.1632437,-122.4580161],[38.1634436,-122.4580054],[38.163653,-122.4580729],
  [38.1638394,-122.4582089],[38.1640273,-122.4584216],[38.164858,-122.4597723],
  [38.1651214,-122.4603734],[38.1660416,-122.4627046],[38.1660744,-122.4627303],
  [38.1664776,-122.462373],[38.1667017,-122.4621707],
];

// precompute cumulative distances along track
const segDists: number[] = [0];
let totalDist = 0;
for (let i = 1; i < TRACK_POINTS.length; i++) {
  const [lat1, lon1] = TRACK_POINTS[i - 1];
  const [lat2, lon2] = TRACK_POINTS[i];
  const dlat = (lat2 - lat1) * 111320;
  const dlon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  totalDist += Math.sqrt(dlat * dlat + dlon * dlon);
  segDists.push(totalDist);
}

function getTrackPos(dist: number): { lat: number; lon: number; heading: number } {
  const d = ((dist % totalDist) + totalDist) % totalDist;
  for (let i = 1; i < segDists.length; i++) {
    if (d <= segDists[i]) {
      const segLen = segDists[i] - segDists[i - 1];
      const frac = segLen > 0 ? (d - segDists[i - 1]) / segLen : 0;
      const [lat1, lon1] = TRACK_POINTS[i - 1];
      const [lat2, lon2] = TRACK_POINTS[i];
      const lat = lat1 + (lat2 - lat1) * frac;
      const lon = lon1 + (lon2 - lon1) * frac;
      const heading = (Math.atan2(lon2 - lon1, lat2 - lat1) * 180) / Math.PI;
      return { lat, lon, heading: ((heading % 360) + 360) % 360 };
    }
  }
  return { lat: TRACK_POINTS[0][0], lon: TRACK_POINTS[0][1], heading: 0 };
}

// track segment types based on curvature
type SegmentType = "straight" | "braking" | "corner" | "corner_exit";
interface Segment { type: SegmentType; duration: number; }

const TRACK_SEGMENTS: Segment[] = [
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

const LAP_DURATION = TRACK_SEGMENTS.reduce((s, seg) => s + seg.duration, 0);

function getSegment(t: number): { seg: Segment; progress: number } {
  const lapT = t % LAP_DURATION;
  let elapsed = 0;
  for (const seg of TRACK_SEGMENTS) {
    if (lapT < elapsed + seg.duration) {
      return { seg, progress: (lapT - elapsed) / seg.duration };
    }
    elapsed += seg.duration;
  }
  return { seg: TRACK_SEGMENTS[TRACK_SEGMENTS.length - 1], progress: 1 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function jitter(v: number, amount: number): number {
  return v + (Math.random() - 0.5) * 2 * amount;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// state
let speed = 80;       // km/h
let throttlePos = 0;  // 0-100%
let gForceX = 0;      // longitudinal (braking/accel)
let gForceY = 0;      // lateral
let coolantTemp = 85;  // °C — warms up then stabilizes
let mapKpa = 40;       // manifold pressure kPa
let trackDist = 0;     // cumulative distance along track

function step(dt: number, seg: Segment, progress: number): void {
  switch (seg.type) {
    case "straight":
      throttlePos = lerp(throttlePos, clamp(90 + Math.random() * 10, 90, 100), dt * 4);
      speed = lerp(speed, clamp(speed + 40 * dt, 80, 200), dt * 2);
      gForceX = lerp(gForceX, jitter(0.3, 0.05), dt * 5);
      gForceY = lerp(gForceY, jitter(0, 0.05), dt * 5);
      mapKpa = lerp(mapKpa, clamp(85 + throttlePos * 0.15, 70, 101), dt * 3);
      break;

    case "braking":
      throttlePos = lerp(throttlePos, 0, dt * 12);
      speed = lerp(speed, clamp(speed - 120 * dt, 60, 200), dt * 4);
      gForceX = lerp(gForceX, jitter(-0.8 - progress * 0.3, 0.05), dt * 6);
      gForceY = lerp(gForceY, jitter(0, 0.1), dt * 4);
      mapKpa = lerp(mapKpa, 25, dt * 5);
      break;

    case "corner":
      throttlePos = lerp(throttlePos, clamp(20 + progress * 30, 15, 60), dt * 5);
      speed = lerp(speed, clamp(80 + progress * 30, 60, 140), dt * 3);
      gForceX = lerp(gForceX, jitter(0.1, 0.05), dt * 4);
      gForceY = lerp(gForceY, jitter(0.6 + progress * 0.3, 0.08), dt * 4);
      mapKpa = lerp(mapKpa, 35 + throttlePos * 0.3, dt * 3);
      break;

    case "corner_exit":
      throttlePos = lerp(throttlePos, clamp(50 + progress * 50, 50, 100), dt * 4);
      speed = lerp(speed, clamp(speed + 30 * dt, 80, 200), dt * 2);
      gForceX = lerp(gForceX, jitter(0.4, 0.05), dt * 5);
      gForceY = lerp(gForceY, jitter(0.3 - progress * 0.3, 0.05), dt * 5);
      mapKpa = lerp(mapKpa, 50 + throttlePos * 0.4, dt * 3);
      break;
  }

  // coolant slowly warms to operating temp then holds
  coolantTemp = lerp(coolantTemp, 92, dt * 0.05);
  coolantTemp = clamp(jitter(coolantTemp, 0.2), 60, 110);

  // clamp
  throttlePos = clamp(throttlePos, 0, 100);
  speed = clamp(speed, 30, 220);
  gForceX = clamp(gForceX, -1.5, 1.5);
  gForceY = clamp(gForceY, -1.5, 1.5);
  mapKpa = clamp(mapKpa, 20, 101);

  // advance along track
  trackDist += (speed / 3.6) * dt; // m/s * dt
}

// Reverse conversions: converted values → raw voltage (matching serial-bridge.ts)
// TPS: V = throttle_pct * 4.0 / 100 + 0.5
function tpsToVoltage(pct: number): number {
  return pct * 4.0 / 100 + 0.5;
}

// MAP: V = (kPa - 20) / 32.4 + 0.5
function mapToVoltage(kpa: number): number {
  return (kpa - 20) / 32.4 + 0.5;
}

// ECT: temp → resistance (log interp on table), then V = 5 * R / (R_pullup + R)
const ECT_PULLUP = 6.65; // kΩ, matches serial-bridge.ts
const ECT_TABLE: [number, number][] = [
  [12.0, -20], [5.0, 0], [2.0, 20], [1.2, 40],
  [0.7, 60], [0.4, 80], [0.2, 100], [0.1, 120],
];

function ectToVoltage(tempC: number): number {
  // temp → resistance via log interpolation
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
  return 5 * rKohm / (ECT_PULLUP + rKohm);
}

// ADC noise: Mega 10-bit ADC, LSB ≈ 4.9mV
const ADC_NOISE = 0.05; // ±50mV

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

  console.log(`streaming live at ${HZ}Hz ${DURATION_S ? `for ${DURATION_S}s` : "continuously"} → ${BASE_URL}  (ctrl-c to stop)`);

  const startReal = performance.now();
  const maxTicks = DURATION_S ? HZ * DURATION_S : Infinity;

  for (let i = 0; i < maxTicks; i++) {
    const { seg, progress } = getSegment(t);
    step(dt, seg, progress);
    const ts = Date.now();

    const pos = getTrackPos(trackDist);

    const batch = [
      // GPS (from RaceBox)
      { channel: "gps_lat", value: pos.lat, ts },
      { channel: "gps_lon", value: pos.lon, ts },
      { channel: "gps_speed", value: Math.round(jitter(speed, 2) * 10) / 10, ts },
      { channel: "gps_heading", value: Math.round(pos.heading * 10) / 10, ts },
      // G-forces (from RaceBox)
      { channel: "g_force_x", value: Math.round(jitter(gForceX, 0.06) * 1000) / 1000, ts },
      { channel: "g_force_y", value: Math.round(jitter(gForceY, 0.06) * 1000) / 1000, ts },
      // ECU (from serial bridge)
      { channel: "speed", value: Math.round(jitter(speed, 3) * 10) / 10, ts },
      { channel: "throttle_pos", value: Math.round(jitter(throttlePos, 2) * 10) / 10, ts },
      { channel: "coolant_temp", value: Math.round(jitter(coolantTemp, 1.5) * 10) / 10, ts },
      { channel: "manifold_pressure", value: Math.round(jitter(mapKpa, 2) * 10) / 10, ts },
      // Raw voltages (with ADC noise)
      { channel: "tps_voltage", value: Math.round(jitter(tpsToVoltage(throttlePos), ADC_NOISE) * 1000) / 1000, ts },
      { channel: "ect_voltage", value: Math.round(jitter(ectToVoltage(coolantTemp), ADC_NOISE) * 1000) / 1000, ts },
      { channel: "map_voltage", value: Math.round(jitter(mapToVoltage(mapKpa), ADC_NOISE) * 1000) / 1000, ts },
    ];

    await send(batch);
    totalSent += batch.length;
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
