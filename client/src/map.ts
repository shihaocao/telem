import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import { TelemetryManager } from "./telemetry";
import { SONOMA_TRACK, TRACK_CENTER, TRACK_ZOOM, FINISH_LINE, TURNS } from "./track";

const TRAIL_MAX = 3000;
const TRAIL_COLOR = "#e74c3c";
const TRACK_OUTLINE_COLOR = "rgba(255,255,255,0.35)";
const MARKER_COLOR = "#fff";
const DECAY_SEGMENTS = 20;

const TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILES_NOLABELS = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
const TILE_OPTS: L.TileLayerOptions = { maxZoom: 20, subdomains: "abcd" };

const TRACK_BEARING = -35;

export interface MapPanels {
  update: () => void;
}

function zoomForSpeed(kmh: number): number {
  if (kmh < 10) return 18;
  if (kmh < 60) return 17;
  if (kmh < 120) return 16;
  if (kmh < 200) return 15;
  return 14;
}

/** Splits coords into N segments with decaying opacity (newest = most opaque) */
function buildDecayTrail(
  map: L.Map,
  coords: [number, number][],
  existing: L.Polyline[],
): L.Polyline[] {
  for (const p of existing) p.remove();
  if (coords.length < 2) return [];

  const segments: L.Polyline[] = [];
  const chunkSize = Math.max(1, Math.ceil(coords.length / DECAY_SEGMENTS));

  for (let i = 0; i < DECAY_SEGMENTS; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize + 1, coords.length);
    if (start >= coords.length) break;
    const slice = coords.slice(start, end);
    if (slice.length < 2) continue;

    const opacity = 0.08 + (i / (DECAY_SEGMENTS - 1)) * 0.92;
    const line = L.polyline(slice as L.LatLngExpression[], {
      color: TRAIL_COLOR,
      weight: 2.5,
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

  const followTrail = L.polyline([], {
    color: TRAIL_COLOR,
    weight: 2.5,
  }).addTo(followMap);

  const followMarker = L.circleMarker([0, 0], {
    radius: 5,
    color: MARKER_COLOR,
    fillColor: TRAIL_COLOR,
    fillOpacity: 1,
    weight: 2,
  });

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

  const overviewMarker = L.circleMarker([0, 0], {
    radius: 4,
    color: MARKER_COLOR,
    fillColor: TRAIL_COLOR,
    fillOpacity: 1,
    weight: 2,
  });

  // resize handlers
  new ResizeObserver(() => followMap.invalidateSize()).observe(followEl);
  new ResizeObserver(() => overviewMap.invalidateSize()).observe(overviewEl);

  let lastLat = 0;
  let lastLon = 0;
  let lastLen = 0;

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

    // build coordinate array
    const start = Math.max(0, len - TRAIL_MAX);
    const coords: [number, number][] = [];
    for (let i = start; i < len; i++) {
      const la = latBuf.values[i];
      const lo = lonBuf.values[i];
      if (la !== 0 || lo !== 0) coords.push([la, lo]);
    }

    // --- update follow map ---
    followTrail.setLatLngs(coords as L.LatLngExpression[]);
    followMarker.setLatLng([lat, lon]);

    const speedBuf = mgr.getBuffer("gps_speed") ?? mgr.getBuffer("speed");
    const speed = speedBuf?.values.length ? speedBuf.values[speedBuf.values.length - 1] : 0;
    const targetZoom = zoomForSpeed(speed);

    if (!followHasPos) {
      followMarker.addTo(followMap);
      followZoom = targetZoom;
      followMap.setView([lat, lon], followZoom);
      followHasPos = true;
    } else if (targetZoom !== followZoom) {
      followZoom = targetZoom;
      followMap.setView([lat, lon], followZoom, { animate: false });
    } else {
      followMap.panTo([lat, lon], { animate: false });
    }

    // --- update overview map (decay trail) ---
    overviewTrailSegments = buildDecayTrail(overviewMap, coords, overviewTrailSegments);
    overviewMarker.setLatLng([lat, lon]);
    if (!overviewMap.hasLayer(overviewMarker)) {
      overviewMarker.addTo(overviewMap);
    }
  }

  return { update };
}
