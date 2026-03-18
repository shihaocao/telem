import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import { TelemetryManager } from "./telemetry";
import { SONOMA_TRACK, TRACK_CENTER, TRACK_ZOOM, FINISH_LINE, TURNS } from "./track";

const TRAIL_MAX = 3000;
const TRAIL_COLOR = "#ff6b35";
const TRACK_OUTLINE_COLOR = "rgba(255, 255, 255, 0.3)";
const MARKER_COLOR = "#fff";
const DECAY_SEGMENTS = 20;

const TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILES_NOLABELS = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
const TILE_OPTS: L.TileLayerOptions = { maxZoom: 20, subdomains: "abcd" };

const TRACK_BEARING = -35;

/** Snap a point to the nearest position on the track centerline. */
function snapToTrack(lat: number, lon: number): [number, number] {
  let bestDist = Infinity;
  let bestPt: [number, number] = [lat, lon];

  for (let i = 0; i < SONOMA_TRACK.length - 1; i++) {
    const [aLat, aLon] = SONOMA_TRACK[i];
    const [bLat, bLon] = SONOMA_TRACK[i + 1];

    // project point onto segment [a, b]
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

export interface MapPanels {
  update: () => void;
}


// Speed-to-color (km/h): white (0-64) → yellow (64-80) → orange (80-129) → red (129+)
const SPEED_COLORS: [number, [number, number, number]][] = [
  [0,   [255, 255, 255]],  // white
  [64,  [255, 255, 255]],  // white (40 mph)
  [80,  [241, 196, 15]],   // yellow (50 mph)
  [129, [255, 107, 53]],   // orange (80 mph)
  [193, [231, 76, 60]],    // red (120 mph)
];

function speedToColor(kmh: number): string {
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

// Group consecutive coords by similar speed into segments, with age-based opacity
const MAX_TRAIL_SEGMENTS = 60;

function buildSpeedTrail(
  map: L.Map,
  coords: [number, number][],
  speeds: number[],
  existing: L.Polyline[],
): L.Polyline[] {
  for (const p of existing) p.remove();
  if (coords.length < 2) return [];

  const segments: L.Polyline[] = [];

  // bucket into groups of ~equal size to limit segment count
  const bucketSize = Math.max(1, Math.ceil(coords.length / MAX_TRAIL_SEGMENTS));

  for (let b = 0; b < coords.length - 1; b += bucketSize) {
    const end = Math.min(b + bucketSize + 1, coords.length);
    const slice = coords.slice(b, end);
    if (slice.length < 2) continue;

    // average speed for this bucket
    let sum = 0;
    let cnt = 0;
    for (let j = b; j < Math.min(b + bucketSize, speeds.length); j++) {
      sum += speeds[j];
      cnt++;
    }
    const avgSpeed = cnt > 0 ? sum / cnt : 0;
    const color = speedToColor(avgSpeed);

    // age-based opacity (kept subtle)
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

export function createMaps(
  followEl: HTMLElement,
  overviewEl: HTMLElement,
  mgr: TelemetryManager,
): MapPanels {
  // --- Follow map (current GPS position) ---
  const followMap = L.map(followEl, {
    zoomControl: false,
    attributionControl: false,
  }).setView([0, 0], 2);
  L.tileLayer(TILES, TILE_OPTS).addTo(followMap);

  let followTrailSegments: L.Polyline[] = [];

  function makeArrowIcon(heading: number): L.DivIcon {
    return L.divIcon({
      className: "car-arrow",
      html: `<svg width="20" height="20" viewBox="0 0 20 20" style="transform:rotate(${heading}deg)">
        <polygon points="10,2 16,16 10,12 4,16" fill="#e74c3c" stroke="${MARKER_COLOR}" stroke-width="1.5"/>
      </svg>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
  }

  let followHeading = 0;
  const followMarker = L.marker([0, 0], { icon: makeArrowIcon(0), interactive: false });

  let followHasPos = false;
  let followZoom = 17;

  // --- Overview map (rotated, no road labels) ---
  const overviewMap = L.map(overviewEl, {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
    minZoom: TRACK_ZOOM,
    maxZoom: TRACK_ZOOM,
    rotate: true,
    rotateControl: false,
    shiftKeyRotate: false,
    bearing: TRACK_BEARING,
  } as any).setView(TRACK_CENTER, TRACK_ZOOM);
  L.tileLayer(TILES_NOLABELS, TILE_OPTS).addTo(overviewMap);

  // track outline
  L.polyline(SONOMA_TRACK as L.LatLngExpression[], {
    color: TRACK_OUTLINE_COLOR,
    weight: 1.2,
    dashArray: "4 4",
  }).addTo(overviewMap);

  // start/finish marker
  L.marker(FINISH_LINE, {
    icon: L.divIcon({
      className: "turn-label sf-label",
      html: "S/F",
      iconSize: [24, 14],
      iconAnchor: [12, 7],
    }),
    interactive: false,
  }).addTo(overviewMap);

  // turn labels
  for (const t of TURNS) {
    L.marker(t.pos, {
      icon: L.divIcon({
        className: "turn-label",
        html: t.label,
        iconSize: [20, 14],
        iconAnchor: [10, 7],
      }),
      interactive: false,
    }).addTo(overviewMap);
  }

  let overviewTrailSegments: L.Polyline[] = [];

  const overviewMarker = L.marker([0, 0], { icon: makeArrowIcon(0), interactive: false });

  // resize handlers
  new ResizeObserver(() => followMap.invalidateSize()).observe(followEl);
  new ResizeObserver(() => overviewMap.invalidateSize()).observe(overviewEl);

  let lastLat = 0;
  let lastLon = 0;
  let lastLen = 0;
  let lastMapUpdate = 0;
  const MAP_UPDATE_INTERVAL = 100; // ms — throttle map pans to 10Hz

  function update(): void {
    const latBuf = mgr.getBuffer("gps_lat");
    const lonBuf = mgr.getBuffer("gps_lon");
    if (!latBuf || !lonBuf || latBuf.values.length === 0) return;

    const lat = latBuf.values[latBuf.values.length - 1];
    const lon = lonBuf.values[lonBuf.values.length - 1];
    if (lat === 0 && lon === 0) return;

    const len = Math.min(latBuf.values.length, lonBuf.values.length);
    if (lat === lastLat && lon === lastLon && len === lastLen) return;
    lastLat = lat;
    lastLon = lon;
    lastLen = len;

    const now = performance.now();
    if (now - lastMapUpdate < MAP_UPDATE_INTERVAL) return;
    lastMapUpdate = now;

    // build coordinate + speed arrays
    const speedBuf = mgr.getBuffer("gps_speed") ?? mgr.getBuffer("speed");
    const start = Math.max(0, len - TRAIL_MAX);
    const coords: [number, number][] = [];
    const speeds: number[] = [];
    for (let i = start; i < len; i++) {
      const la = latBuf.values[i];
      const lo = lonBuf.values[i];
      if (la !== 0 || lo !== 0) {
        coords.push([la, lo]);
        speeds.push(speedBuf && i < speedBuf.values.length ? speedBuf.values[i] : 0);
      }
    }

    // read heading
    const hdgBuf = mgr.getBuffer("gps_heading");
    const heading = hdgBuf?.values.length ? hdgBuf.values[hdgBuf.values.length - 1] : 0;

    // update arrow icons when heading changes
    if (heading !== followHeading) {
      followHeading = heading;
      const icon = makeArrowIcon(heading);
      followMarker.setIcon(icon);
      overviewMarker.setIcon(icon);
    }

    // --- update follow map ---
    followTrailSegments = buildSpeedTrail(followMap, coords, speeds, followTrailSegments);
    followMarker.setLatLng([lat, lon]);

    if (!followHasPos) {
      followMarker.addTo(followMap);
      followMap.setView([lat, lon], followZoom);
      followHasPos = true;
    } else {
      followMap.panTo([lat, lon], { animate: false });
    }

    // --- update overview map (snap GPS to track centerline) ---
    const snappedCoords = coords.map(([la, lo]) => snapToTrack(la, lo));
    overviewTrailSegments = buildSpeedTrail(overviewMap, snappedCoords, speeds, overviewTrailSegments);
    const [sLat, sLon] = snapToTrack(lat, lon);
    overviewMarker.setLatLng([sLat, sLon]);
    if (!overviewMap.hasLayer(overviewMarker)) {
      overviewMarker.addTo(overviewMap);
    }
  }

  return { update };
}
