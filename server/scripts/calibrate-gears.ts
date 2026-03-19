/**
 * Auto-discover gear ratios from WAL telemetry data.
 *
 * Scans all rpm + gps_speed entries, computes rpm/kph ratios,
 * clusters them into gears, and outputs the detected ratios.
 *
 * Usage: tsx scripts/calibrate-gears.ts [--url http://localhost:4400]
 */

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE_URL = arg("url", "http://localhost:4400");

async function fetchChannel(channel: string): Promise<{ ts: number; value: number }[]> {
  const res = await fetch(`${BASE_URL}/query?channel=${channel}&limit=100000`);
  const data = await res.json();
  return data.entries.map((e: any) => ({ ts: e.ts, value: e.value }));
}

async function main() {
  console.log(`fetching telemetry from ${BASE_URL}...`);

  const [rpmEntries, speedEntries] = await Promise.all([
    fetchChannel("rpm"),
    fetchChannel("gps_speed"),
  ]);

  console.log(`  rpm: ${rpmEntries.length} entries`);
  console.log(`  gps_speed: ${speedEntries.length} entries`);

  if (rpmEntries.length === 0 || speedEntries.length === 0) {
    console.log("not enough data");
    return;
  }

  // Align by timestamp — find nearest speed for each rpm entry
  const speedByTs = new Map<number, number>();
  for (const e of speedEntries) speedByTs.set(e.ts, e.value);

  // For each RPM sample, find the closest speed sample (within 100ms)
  const ratios: number[] = [];
  const speedTs = speedEntries.map(e => e.ts);
  let si = 0;

  for (const rpmEntry of rpmEntries) {
    // Advance speed index to closest timestamp
    while (si < speedTs.length - 1 && Math.abs(speedTs[si + 1] - rpmEntry.ts) < Math.abs(speedTs[si] - rpmEntry.ts)) {
      si++;
    }

    const timeDiff = Math.abs(speedTs[si] - rpmEntry.ts);
    if (timeDiff > 100) continue; // skip if no speed within 100ms

    const speed = speedEntries[si].value;
    const rpm = rpmEntry.value;

    // Filter: speed > 5 kph (avoid idle/stationary), rpm > 800 (avoid stall)
    if (speed < 5 || rpm < 800) continue;

    ratios.push(rpm / speed);
  }

  console.log(`\n${ratios.length} valid rpm/kph samples`);

  if (ratios.length < 50) {
    console.log("not enough valid samples for clustering");
    return;
  }

  // Sort ratios and find clusters using histogram approach
  ratios.sort((a, b) => a - b);

  // Build histogram with fine bins
  const BIN_WIDTH = 2;
  const minR = ratios[0];
  const maxR = ratios[ratios.length - 1];
  const bins: { center: number; count: number }[] = [];
  for (let r = minR; r <= maxR; r += BIN_WIDTH) {
    const count = ratios.filter(v => v >= r && v < r + BIN_WIDTH).length;
    bins.push({ center: r + BIN_WIDTH / 2, count });
  }

  // Find peaks (local maxima with minimum count)
  const MIN_PEAK_COUNT = Math.max(5, ratios.length * 0.02);
  const peaks: { ratio: number; count: number }[] = [];

  for (let i = 1; i < bins.length - 1; i++) {
    if (bins[i].count >= MIN_PEAK_COUNT &&
        bins[i].count >= bins[i - 1].count &&
        bins[i].count >= bins[i + 1].count) {
      // Merge nearby peaks (within 8 units)
      if (peaks.length > 0 && bins[i].center - peaks[peaks.length - 1].ratio < 8) {
        if (bins[i].count > peaks[peaks.length - 1].count) {
          peaks[peaks.length - 1] = { ratio: bins[i].center, count: bins[i].count };
        }
      } else {
        peaks.push({ ratio: bins[i].center, count: bins[i].count });
      }
    }
  }

  // Refine peak centers using weighted average of nearby samples
  const refined: { ratio: number; count: number; gear: number }[] = [];
  for (const peak of peaks) {
    const nearby = ratios.filter(r => Math.abs(r - peak.ratio) < 6);
    const avg = nearby.reduce((s, r) => s + r, 0) / nearby.length;
    refined.push({ ratio: avg, count: nearby.length, gear: 0 });
  }

  // Sort by ratio descending (gear 1 = highest ratio)
  refined.sort((a, b) => b.ratio - a.ratio);
  refined.forEach((r, i) => r.gear = i + 1);

  console.log("\n=== Detected gear ratios (rpm/kph) ===");
  for (const r of refined) {
    console.log(`  Gear ${r.gear}: ${r.ratio.toFixed(2)} rpm/kph  (${r.count} samples)`);
  }

  // Back-calculate transmission gear ratios
  // rpm/kph = (1/3.6) / tire_circ * gear_ratio * final_drive * 60
  // gear_ratio * final_drive = rpm/kph * tire_circ * 3.6 / 60
  const TIRE_CIRC = Math.PI * (15 * 0.0254 + 2 * 0.195 * 0.50);
  const combined = refined.map(r => r.ratio * TIRE_CIRC * 3.6 / 60);

  console.log("\n=== Combined ratios (gear × final_drive) ===");
  for (let i = 0; i < refined.length; i++) {
    console.log(`  Gear ${refined[i].gear}: ${combined[i].toFixed(3)}`);
  }

  // If we got 5 gears, estimate final drive and individual ratios
  if (refined.length >= 3) {
    // Use highest gear (5th) as reference — its ratio should be ~0.685
    // Try common final drives: 4.062, 4.266, 4.428
    const KNOWN_FINALS = [4.062, 4.266, 4.428];
    console.log("\n=== Estimated gear ratios for known final drives ===");
    for (const fd of KNOWN_FINALS) {
      const gearRatios = combined.map(c => c / fd);
      console.log(`  FD ${fd}:  [${gearRatios.map(r => r.toFixed(3)).join(", ")}]`);
    }
  }

  // Output as code
  if (refined.length === 5) {
    console.log("\n=== Copy-paste for gear.ts ===");
    console.log(`export const GEAR_RPM_PER_KPH = [${refined.map(r => r.ratio.toFixed(2)).join(", ")}];`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
