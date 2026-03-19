import L from "leaflet";

/** Snap a point to the nearest position on a track centerline. */
export function snapToTrack(trackPts: [number, number][], lat: number, lon: number): [number, number] {
  let bestDist = Infinity;
  let bestPt: [number, number] = [lat, lon];

  for (let i = 0; i < trackPts.length - 1; i++) {
    const [aLat, aLon] = trackPts[i];
    const [bLat, bLon] = trackPts[i + 1];
    const dx = bLon - aLon;
    const dy = bLat - aLat;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;

    const t = Math.max(0, Math.min(1, ((lon - aLon) * dx + (lat - aLat) * dy) / lenSq));
    const pLat = aLat + t * dy;
    const pLon = aLon + t * dx;
    const dLat = lat - pLat;
    const dLon = lon - pLon;
    const dist = dLat * dLat + dLon * dLon;

    if (dist < bestDist) {
      bestDist = dist;
      bestPt = [pLat, pLon];
    }
  }
  return bestPt;
}

/** Compute fractional progress (0–1) of a point along a track polyline. */
export function trackProgress(trackPts: [number, number][], lat: number, lon: number): number {
  // Precompute cumulative segment lengths
  const segDists = [0];
  let total = 0;
  for (let i = 1; i < trackPts.length; i++) {
    const [aLat, aLon] = trackPts[i - 1];
    const [bLat, bLon] = trackPts[i];
    total += Math.sqrt((bLat - aLat) ** 2 + (bLon - aLon) ** 2);
    segDists.push(total);
  }
  if (total === 0) return 0;

  let bestDist = Infinity;
  let bestProgress = 0;
  for (let i = 0; i < trackPts.length - 1; i++) {
    const [aLat, aLon] = trackPts[i];
    const [bLat, bLon] = trackPts[i + 1];
    const dx = bLon - aLon;
    const dy = bLat - aLat;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((lon - aLon) * dx + (lat - aLat) * dy) / lenSq));
    const pLat = aLat + t * dy;
    const pLon = aLon + t * dx;
    const dist = (lat - pLat) ** 2 + (lon - pLon) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestProgress = (segDists[i] + t * (segDists[i + 1] - segDists[i])) / total;
    }
  }
  return bestProgress;
}

// Speed-to-color (km/h): white (0-64) → yellow (64-80) → orange (80-129) → red (129+)
const SPEED_COLORS: [number, [number, number, number]][] = [
  [0,   [255, 255, 255]],
  [64,  [255, 255, 255]],
  [80,  [241, 196, 15]],
  [129, [255, 107, 53]],
  [193, [231, 76, 60]],
];

export function speedToColor(kmh: number): string {
  if (kmh <= SPEED_COLORS[0][0]) {
    const [r, g, b] = SPEED_COLORS[0][1];
    return `rgb(${r},${g},${b})`;
  }
  for (let i = 1; i < SPEED_COLORS.length; i++) {
    if (kmh <= SPEED_COLORS[i][0]) {
      const [s0, c0] = SPEED_COLORS[i - 1];
      const [s1, c1] = SPEED_COLORS[i];
      const t = (kmh - s0) / (s1 - s0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
      return `rgb(${r},${g},${b})`;
    }
  }
  const [r, g, b] = SPEED_COLORS[SPEED_COLORS.length - 1][1];
  return `rgb(${r},${g},${b})`;
}

/** Throttle-to-color (0-100%): green (0-10) → white (10-40) → yellow (40-70) → orange (70-90) → red (90+) */
const THROTTLE_COLORS: [number, [number, number, number]][] = [
  [0,   [46, 204, 113]],
  [10,  [46, 204, 113]],
  [40,  [255, 255, 255]],
  [70,  [241, 196, 15]],
  [90,  [255, 107, 53]],
  [100, [231, 76, 60]],
];

export function throttleToColor(pct: number): string {
  if (pct <= THROTTLE_COLORS[0][0]) {
    const [r, g, b] = THROTTLE_COLORS[0][1];
    return `rgb(${r},${g},${b})`;
  }
  for (let i = 1; i < THROTTLE_COLORS.length; i++) {
    if (pct <= THROTTLE_COLORS[i][0]) {
      const [s0, c0] = THROTTLE_COLORS[i - 1];
      const [s1, c1] = THROTTLE_COLORS[i];
      const t = (pct - s0) / (s1 - s0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
      return `rgb(${r},${g},${b})`;
    }
  }
  const [r, g, b] = THROTTLE_COLORS[THROTTLE_COLORS.length - 1][1];
  return `rgb(${r},${g},${b})`;
}

const MAX_TRAIL_SEGMENTS = 60;

export function buildSpeedTrail(
  map: L.Map,
  coords: [number, number][],
  speeds: number[],
  existing: L.Polyline[],
): L.Polyline[] {
  for (const p of existing) p.remove();
  if (coords.length < 2) return [];

  const segments: L.Polyline[] = [];
  const bucketSize = Math.max(1, Math.ceil(coords.length / MAX_TRAIL_SEGMENTS));

  for (let b = 0; b < coords.length - 1; b += bucketSize) {
    const end = Math.min(b + bucketSize + 1, coords.length);
    const slice = coords.slice(b, end);
    if (slice.length < 2) continue;

    let sum = 0;
    let cnt = 0;
    for (let j = b; j < Math.min(b + bucketSize, speeds.length); j++) {
      sum += speeds[j];
      cnt++;
    }
    const avgSpeed = cnt > 0 ? sum / cnt : 0;
    const color = speedToColor(avgSpeed);

    const midIdx = (b + Math.min(b + bucketSize, coords.length - 1)) / 2;
    const opacity = 0.08 + (midIdx / (coords.length - 1)) * 0.5;

    const line = L.polyline(slice as L.LatLngExpression[], {
      color,
      weight: 2,
      opacity,
    }).addTo(map);
    segments.push(line);
  }
  return segments;
}
