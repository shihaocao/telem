import "./review.css";
import { propagateQueryParams } from "./nav";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import { TRACKS, type TrackDef } from "./track";
import { speedToColor, throttleToColor } from "./track-utils";
import { createDropdown } from "./dropdown";

const REMOTE_URL = ((import.meta.env.VITE_SERVER_URL as string) ?? "http://gearados-nx.tail62d295.ts.net:4400").replace(/\/$/, "");
const LOCAL_URL = "http://localhost:4400";
const isLocal = new URLSearchParams(window.location.search).has("local");
const SERVER_URL = isLocal ? LOCAL_URL : REMOTE_URL;

const TILES_NOLABELS = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
const TILES_SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_OPTS: L.TileLayerOptions = { maxZoom: 20, subdomains: "abcd" };
const TILE_OPTS_SAT: L.TileLayerOptions = { maxZoom: 20 };

interface Lap { lap: number; time: number; flag: "clean" | "yellow" | "pit" | "out" | "in"; track: string; startSeq: number; endSeq: number; }
interface Session { id: string; track: string; driver: string; createdAt: number; running: boolean; laps: Lap[]; }
interface WalEntry { seq: number; ts: number; channel: string; value: number; }

// ── State ──
const params = new URLSearchParams(window.location.search);
const trackId = params.get("track") ?? "sonoma";
let trackDef: TrackDef = TRACKS[trackId] ?? TRACKS.sonoma;

let sessions: Session[] = [];
let session: Session | null = null;
let selectedLapIdx = -1;
let lapEntries: WalEntry[] = [];
let lapCoords: [number, number][] = [];
let lapSpeeds: number[] = [];
let lapThrottles: number[] = [];
let lapGx: number[] = [];
let lapGy: number[] = [];
let lapRpms: number[] = [];
let lapGears: number[] = [];
let lapBrakes: number[] = [];
let lapTimestamps: number[] = [];
let trailMode: "speed" | "throttle" | "rpm" | "gear" | "brake" = "speed";

const KMH_TO_MPH = 0.621371;
const MAX_MPH = 120;
const MAX_RPM = 7000;
const SPEED_SEGS = 24;
const TPS_SEGS = 16;
const RPM_SEGS = 20;

// ── DOM ──
const metaEl = document.getElementById("review-meta")!;
const sessionListEl = document.getElementById("review-session-list")!;
const lapListEl = document.getElementById("review-lap-list")!;
const mapEl = document.getElementById("review-map")!;
const gcircleEl = document.getElementById("review-gcircle")!;
const gaugesEl = document.getElementById("review-gauges")!;
const legendEl = document.getElementById("review-legend")!;
const seekEl = document.getElementById("review-seek") as HTMLInputElement;
const seekTimeEl = document.getElementById("review-seek-time")!;

// ── Trail mode dropdown (opens upward) ──
type TrailMode = "speed" | "throttle" | "rpm" | "gear" | "brake";
const trailModeDropdown = createDropdown("SPEED", "", "up");
trailModeDropdown.setOptions([
  { value: "speed", label: "SPEED" },
  { value: "throttle", label: "THROTTLE" },
  { value: "rpm", label: "RPM" },
  { value: "gear", label: "GEAR" },
  { value: "brake", label: "BRAKE" },
]);
trailModeDropdown.setValue("speed");
trailModeDropdown.onChange = (v) => {
  trailMode = v as TrailMode;
  drawTrail();
  renderLegend();
};
document.getElementById("review-trail-modes")!.appendChild(trailModeDropdown.el);

// Trail color functions for each mode
const GEAR_COLORS = ["#3498db", "#ffffff", "#f1c40f", "#ff6b35", "#e74c3c"];
function gearToColor(gear: number): string {
  return GEAR_COLORS[Math.max(0, Math.min(gear - 1, GEAR_COLORS.length - 1))] ?? "#999";
}
function rpmToColor(rpm: number): string {
  const f = Math.min(1, rpm / MAX_RPM);
  if (f < 0.6) return "rgb(255,255,255)";
  if (f < 0.8) { const t = (f - 0.6) / 0.2; return `rgb(255,${Math.round(255 - 148 * t)},${Math.round(255 - 202 * t)})`; }
  const t = (f - 0.8) / 0.2;
  return `rgb(${Math.round(255 - 24 * t)},${Math.round(107 - 31 * t)},${Math.round(53 + 7 * t)})`;
}

// ── Map ──
const map = L.map(mapEl, {
  zoomControl: true,
  attributionControl: false,
  rotate: true,
  rotateControl: false,
  shiftKeyRotate: false,
  bearing: trackDef.bearing,
} as any).setView(trackDef.center, trackDef.zoom);
let darkTiles = L.tileLayer(TILES_NOLABELS, TILE_OPTS).addTo(map);
let satTiles = L.tileLayer(TILES_SAT, TILE_OPTS_SAT);
let isSat = false;

const satToggle = document.getElementById("review-sat-toggle")!;
satToggle.addEventListener("click", () => {
  isSat = !isSat;
  satToggle.classList.toggle("active", isSat);
  if (isSat) {
    map.removeLayer(darkTiles);
    satTiles.addTo(map);
  } else {
    map.removeLayer(satTiles);
    darkTiles.addTo(map);
  }
});

new ResizeObserver(() => map.invalidateSize()).observe(mapEl);

let trackOverlays: L.Layer[] = [];
function drawTrackOverlays() {
  for (const l of trackOverlays) map.removeLayer(l);
  trackOverlays = [];
  trackOverlays.push(L.polyline(trackDef.track as L.LatLngExpression[], { color: "rgba(255,255,255,0.3)", weight: 1.2, dashArray: "4 4" }).addTo(map));
  trackOverlays.push(L.marker(trackDef.finishLine, { icon: L.divIcon({ className: "turn-label sf-label", html: "S/F", iconSize: [24, 14], iconAnchor: [12, 7] }), interactive: false }).addTo(map));
  for (const t of trackDef.turns) {
    trackOverlays.push(L.marker(t.pos, { icon: L.divIcon({ className: "turn-label", html: t.label, iconSize: [20, 14], iconAnchor: [10, 7] }), interactive: false }).addTo(map));
  }
}
drawTrackOverlays();

let trailLines: L.Polyline[] = [];
let posMarker: L.Marker | null = null;

// ── G-force canvas ──
const gCanvas = document.createElement("canvas");
gcircleEl.appendChild(gCanvas);
const gCtx = gCanvas.getContext("2d")!;
let gW = 0, gH = 0;

new ResizeObserver((entries) => {
  for (const entry of entries) {
    const r = entry.contentRect;
    const dpr = window.devicePixelRatio || 1;
    gW = r.width; gH = r.height;
    gCanvas.width = gW * dpr; gCanvas.height = gH * dpr;
    gCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}).observe(gcircleEl);

const MAX_G = 1.0;
const RING_STEPS = [0.25, 0.5, 0.75, 1.0];

function drawGCircle(gx: number, gy: number) {
  if (gW === 0 || gH === 0) return;
  gCtx.clearRect(0, 0, gW, gH);

  const cx = gW / 2, cy = gH / 2;
  const radius = Math.min(cx, cy) - 20;
  const scale = radius / MAX_G;
  const latG = -gy;  // lateral = x axis (negate so right turn = right on display)
  const lonG = -gx; // braking(+) = up

  // rings
  gCtx.lineWidth = 1;
  for (const g of RING_STEPS) {
    gCtx.beginPath();
    gCtx.arc(cx, cy, g * scale, 0, Math.PI * 2);
    gCtx.strokeStyle = "rgba(255,255,255,0.06)";
    gCtx.stroke();
  }

  // crosshair
  gCtx.strokeStyle = "rgba(255,255,255,0.1)";
  gCtx.beginPath();
  gCtx.moveTo(cx - radius, cy); gCtx.lineTo(cx + radius, cy);
  gCtx.moveTo(cx, cy - radius); gCtx.lineTo(cx, cy + radius);
  gCtx.stroke();

  // labels
  gCtx.fillStyle = "rgba(255,255,255,0.2)";
  gCtx.font = "9px monospace";
  gCtx.textAlign = "left"; gCtx.textBaseline = "bottom";
  for (const g of RING_STEPS) gCtx.fillText(`${g}g`, cx + 3, cy - g * scale - 2);

  gCtx.fillStyle = "rgba(255,107,53,0.5)";
  gCtx.font = "bold 8px monospace";
  gCtx.textAlign = "center";
  gCtx.textBaseline = "top"; gCtx.fillText("BRK", cx, cy - radius - 14);
  gCtx.textBaseline = "bottom"; gCtx.fillText("ACC", cx, cy + radius + 14);
  gCtx.textAlign = "left"; gCtx.textBaseline = "middle"; gCtx.fillText("L", cx - radius - 12, cy);
  gCtx.textAlign = "right"; gCtx.fillText("R", cx + radius + 12, cy);

  // dot
  const px = cx + latG * scale;
  const py = cy + lonG * scale;
  gCtx.beginPath(); gCtx.arc(px, py, 6, 0, Math.PI * 2);
  gCtx.fillStyle = "rgba(255,107,53,0.12)"; gCtx.fill();
  gCtx.beginPath(); gCtx.arc(px, py, 3.5, 0, Math.PI * 2);
  gCtx.fillStyle = "#ff6b35"; gCtx.fill();
  gCtx.strokeStyle = "#fff"; gCtx.lineWidth = 1.5; gCtx.stroke();

  // magnitude
  const mag = Math.sqrt(latG * latG + lonG * lonG);
  gCtx.fillStyle = "#eee"; gCtx.font = "bold 11px monospace";
  gCtx.textAlign = "right"; gCtx.textBaseline = "top";
  gCtx.fillText(`${mag.toFixed(2)}g`, gW - 6, 6);
}

// ── Gauges ──
function makeSegTrack(count: number): HTMLElement {
  const track = document.createElement("div");
  track.className = "review-seg-track";
  for (let i = 0; i < count; i++) {
    const seg = document.createElement("div");
    seg.className = "review-seg";
    track.appendChild(seg);
  }
  return track;
}

// Speed gauge
const speedGauge = document.createElement("div");
speedGauge.className = "review-gauge";
speedGauge.innerHTML = `<div class="review-gauge-label">速度 SPEED</div><div class="review-gauge-header"><span class="review-gauge-value" id="rv-speed">--</span><span class="review-gauge-unit">MPH</span></div>`;
const speedSegTrack = makeSegTrack(SPEED_SEGS);
speedGauge.appendChild(speedSegTrack);
gaugesEl.appendChild(speedGauge);
const speedValueEl = speedGauge.querySelector("#rv-speed")!;

// Throttle gauge
const throttleGauge = document.createElement("div");
throttleGauge.className = "review-gauge";
throttleGauge.innerHTML = `<div class="review-gauge-label">開度 THROTTLE</div><div class="review-gauge-header"><span class="review-gauge-value" id="rv-throttle">--</span><span class="review-gauge-unit">%</span></div>`;
const tpsSegTrack = makeSegTrack(TPS_SEGS);
throttleGauge.appendChild(tpsSegTrack);
gaugesEl.appendChild(throttleGauge);
const throttleValueEl = throttleGauge.querySelector("#rv-throttle")!;

// RPM gauge with gear badge
const rpmGauge = document.createElement("div");
rpmGauge.className = "review-gauge";
rpmGauge.innerHTML = `<div class="review-gauge-label">回転 RPM</div><div class="review-gauge-header"><span class="review-gauge-value" id="rv-rpm">--</span><span class="review-gauge-unit">RPM</span><span class="review-gauge-gear" id="rv-gear">--</span></div>`;
const rpmSegTrack = makeSegTrack(RPM_SEGS);
rpmGauge.appendChild(rpmSegTrack);
gaugesEl.appendChild(rpmGauge);
const rpmValueEl = rpmGauge.querySelector("#rv-rpm")!;
const gearValueEl = rpmGauge.querySelector("#rv-gear")!;

// Brake bar
const brakeWrap = document.createElement("div");
brakeWrap.className = "review-gauge";
brakeWrap.innerHTML = `<div class="review-gauge-label">制動 BRAKE</div><div class="review-brake" id="rv-brake">${Array(10).fill('<div class="review-brake-seg"></div>').join("")}</div>`;
gaugesEl.appendChild(brakeWrap);
const brakeEl = brakeWrap.querySelector("#rv-brake")!;

function rpmColor(fraction: number): string {
  if (fraction < 0.6) return "rgb(255,255,255)";
  if (fraction < 0.8) {
    const t = (fraction - 0.6) / 0.2;
    return `rgb(255,${Math.round(255 - 148 * t)},${Math.round(255 - 202 * t)})`;
  }
  const t = (fraction - 0.8) / 0.2;
  return `rgb(${Math.round(255 - 24 * t)},${Math.round(107 - 31 * t)},${Math.round(53 + 7 * t)})`;
}

function updateGaugeSegs(track: HTMLElement, fraction: number, colorFn: (idx: number, total: number) => string) {
  const segs = track.children;
  const lit = Math.round(fraction * segs.length);
  for (let i = 0; i < segs.length; i++) {
    const el = segs[i] as HTMLElement;
    if (i < lit) {
      const c = colorFn(i, segs.length);
      el.style.background = c;
      el.style.borderColor = c;
      el.style.boxShadow = `0 0 6px ${c}40`;
    } else {
      el.style.background = "";
      el.style.borderColor = "";
      el.style.boxShadow = "";
    }
  }
}

// ── Legend ──
interface LegendStop { color: string; label: string; }

const SPEED_LEGEND: LegendStop[] = [
  { color: "rgb(255,255,255)", label: "0-40 MPH" },
  { color: "rgb(241,196,15)", label: "40-50 MPH" },
  { color: "rgb(255,107,53)", label: "50-80 MPH" },
  { color: "rgb(231,76,60)", label: "80+ MPH" },
];

const THROTTLE_LEGEND: LegendStop[] = [
  { color: "rgb(46,204,113)", label: "0-10%" },
  { color: "rgb(255,255,255)", label: "10-40%" },
  { color: "rgb(241,196,15)", label: "40-70%" },
  { color: "rgb(255,107,53)", label: "70-90%" },
  { color: "rgb(231,76,60)", label: "90-100%" },
];

const RPM_LEGEND: LegendStop[] = [
  { color: "rgb(255,255,255)", label: "0-4200" },
  { color: "rgb(255,107,53)", label: "4200-5600" },
  { color: "rgb(231,76,60)", label: "5600-7000" },
];

const GEAR_LEGEND: LegendStop[] = [
  { color: "#3498db", label: "1ST" },
  { color: "#ffffff", label: "2ND" },
  { color: "#f1c40f", label: "3RD" },
  { color: "#ff6b35", label: "4TH" },
  { color: "#e74c3c", label: "5TH" },
];

const BRAKE_LEGEND: LegendStop[] = [
  { color: "rgba(255,255,255,0.3)", label: "OFF" },
  { color: "#e74c3c", label: "ON" },
];

const LEGENDS: Record<TrailMode, { title: string; stops: LegendStop[] }> = {
  speed: { title: "SPEED", stops: SPEED_LEGEND },
  throttle: { title: "THROTTLE", stops: THROTTLE_LEGEND },
  rpm: { title: "RPM", stops: RPM_LEGEND },
  gear: { title: "GEAR", stops: GEAR_LEGEND },
  brake: { title: "BRAKE", stops: BRAKE_LEGEND },
};

function renderLegend() {
  const { title, stops } = LEGENDS[trailMode];
  legendEl.innerHTML = `<div class="legend-title">${title}</div>`;
  for (const s of stops) {
    const row = document.createElement("div");
    row.className = "legend-row";
    row.innerHTML = `<span class="legend-swatch" style="background:${s.color}"></span><span class="legend-label">${s.label}</span>`;
    legendEl.appendChild(row);
  }
}
renderLegend();

function formatTime(ms: number): string {
  if (ms <= 0) return "0:00.000";
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toFixed(3).padStart(6, "0")}`;
}

function formatDate(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── LocalStorage cache layer ──
// Always serves from cache first. SYNC button fetches fresh from server.
const CACHE_PREFIX = "telem_review_";

function cacheSet(key: string, data: unknown): void {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(data)); } catch {}
}

function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const statusEl = document.getElementById("review-status")!;

function setStatus(text: string, cls: "" | "loading" | "error" = "") {
  statusEl.textContent = text;
  statusEl.className = cls ? `${cls}` : "";
  statusEl.id = "review-status";
}

async function apiFetch(path: string, method = "GET", body?: unknown, skipCache = false): Promise<any> {
  if (method === "GET" && !skipCache) {
    const cached = cacheGet(path);
    if (cached) return cached;
  }

  setStatus("LOADING...", "loading");
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${SERVER_URL}${path}`, opts);
    const data = await res.json();
    if (method === "GET") cacheSet(path, data);
    setStatus("CACHED");
    return data;
  } catch {
    if (method === "GET") {
      const cached = cacheGet(path);
      if (cached) { setStatus("OFFLINE (CACHED)"); return cached; }
    }
    setStatus("OFFLINE", "error");
    throw new Error(`Server unreachable and no cached data for ${path}`);
  }
}

async function syncFromServer() {
  const btn = document.getElementById("btn-sync")!;
  btn.textContent = "SYNCING...";
  setStatus("SYNCING...", "loading");
  try {
    sessions = await apiFetch(`/sessions?track=${trackId}`, "GET", undefined, true);
    renderSessionList();
    if (session) {
      session = await apiFetch(`/sessions/${session.id}`, "GET", undefined, true);
      renderLapList();
      updateMeta();
      if (selectedLapIdx >= 0 && session?.laps[selectedLapIdx]) {
        await selectLap(selectedLapIdx, true);
      }
    }
    setStatus("SYNCED");
    btn.textContent = "SYNC";
  } catch {
    setStatus("OFFLINE", "error");
    btn.textContent = "SYNC";
  }
}

document.getElementById("btn-sync")!.addEventListener("click", syncFromServer);

// ── Sessions ──
async function loadSessions() {
  try {
    sessions = await apiFetch(`/sessions?track=${trackId}`);
  } catch {
    sessions = [];
  }
  renderSessionList();
}

function renderSessionList() {
  sessionListEl.innerHTML = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = `review-session${session?.id === s.id ? " selected" : ""}`;
    row.innerHTML =
      `<span class="review-session-driver">${s.driver || "UNKNOWN"}</span>` +
      `<span class="review-session-info">${TRACKS[s.track]?.name ?? s.track}</span>` +
      `<span class="review-session-info">${formatDate(s.createdAt)}${s.running ? " // LIVE" : ""} // ${s.laps.length} laps</span>` +
      `<button class="review-session-del" data-id="${s.id}" title="Delete">\u00d7</button>`;
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".review-session-del")) return;
      selectSession(s.id);
    });
    sessionListEl.appendChild(row);
  }

  sessionListEl.querySelectorAll(".review-session-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id!;
      if (!confirm("Delete this session?")) return;
      try { await apiFetch(`/sessions/${id}`, "DELETE"); } catch {}
      // Clear cached data for this session
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key?.startsWith(CACHE_PREFIX) && key.includes(id)) localStorage.removeItem(key);
        }
      } catch {}
      if (session?.id === id) { session = null; selectedLapIdx = -1; clearLapView(); updateMeta(); }
      await loadSessions();
    });
  });
}

async function selectSession(id: string) {
  session = await apiFetch(`/sessions/${id}`);
  if (!session) return;

  const sesTrack = TRACKS[session.track];
  if (sesTrack && session.track !== trackId) {
    trackDef = sesTrack;
    map.setView(trackDef.center, trackDef.zoom);
    (map as any).setBearing(trackDef.bearing);
    drawTrackOverlays();
  }

  selectedLapIdx = -1;
  clearLapView();
  updateMeta();
  renderSessionList();
  renderLapList();
  if (session.laps.length > 0) selectLap(0);
}

function updateMeta() {
  if (!session) { metaEl.textContent = "SELECT A SESSION"; return; }
  const t = TRACKS[session.track];
  metaEl.textContent = `${session.driver || "UNKNOWN"} // ${t?.name ?? session.track} // ${formatDate(session.createdAt)} // ${session.laps.length} LAPS`;
}

function clearLapView() {
  for (const l of trailLines) l.remove();
  trailLines = [];
  if (posMarker) { posMarker.remove(); posMarker = null; }
  lapListEl.innerHTML = "";
  lapCoords = []; lapSpeeds = []; lapThrottles = []; lapGx = []; lapGy = [];
  lapRpms = []; lapGears = []; lapBrakes = []; lapTimestamps = []; lapEntries = [];
  seekEl.value = "0"; seekTimeEl.textContent = "0:00.000";
  speedValueEl.textContent = "--";
  throttleValueEl.textContent = "--";
  rpmValueEl.textContent = "--";
  gearValueEl.textContent = "--";
  brakeEl.classList.remove("active");
  updateGaugeSegs(speedSegTrack, 0, () => "");
  updateGaugeSegs(tpsSegTrack, 0, () => "");
  updateGaugeSegs(rpmSegTrack, 0, () => "");
  drawGCircle(0, 0);
}

// ── Laps ──
function getBestTime(): number | null {
  if (!session) return null;
  const clean = session.laps.filter((l) => l.flag === "clean");
  if (clean.length === 0) return null;
  return Math.min(...clean.map((l) => l.time));
}

function renderLapList() {
  lapListEl.innerHTML = "";
  if (!session) return;
  const best = getBestTime();

  for (let i = 0; i < session.laps.length; i++) {
    const lap = session.laps[i];
    const row = document.createElement("div");
    row.className = `review-lap${lap.flag !== "clean" ? " flagged" : ""}${i === selectedLapIdx ? " selected" : ""}`;

    const delta = best !== null && lap.flag === "clean" ? lap.time - best : null;
    let deltaStr = "", deltaClass = "review-lap-delta";
    if (delta === 0) { deltaStr = "BEST"; deltaClass = "review-lap-delta best"; }
    else if (delta !== null && delta > 0) deltaStr = `+${(delta / 1000).toFixed(3)}`;

    const flagText = lap.flag === "yellow" ? "YEL" : lap.flag === "pit" ? "PIT" : lap.flag === "out" ? "OUT" : lap.flag === "in" ? "IN" : "";
    row.innerHTML =
      `<span class="review-lap-num">L${lap.lap}</span>` +
      `<span class="review-lap-time">${formatTime(lap.time)}</span>` +
      `<span class="${deltaClass}">${deltaStr}</span>` +
      `<span class="review-lap-flag ${lap.flag}">${flagText}</span>`;
    row.addEventListener("click", () => selectLap(i));
    lapListEl.appendChild(row);
  }
}

async function selectLap(idx: number, forceRefresh = false) {
  if (!session || idx < 0 || idx >= session.laps.length) return;
  selectedLapIdx = idx;
  renderLapList();

  const lap = session.laps[idx];
  const channels = "gps_lat,gps_lon,gps_speed,gps_heading,throttle_pos,g_force_x,g_force_y,rpm,gear,brake,coolant_temp,manifold_pressure";
  const data = await apiFetch(`/wal/range?start_seq=${lap.startSeq}&end_seq=${lap.endSeq}&channels=${channels}`, "GET", undefined, forceRefresh);
  lapEntries = data.entries;

  // Sort all entries by timestamp, then build per-GPS-tick arrays
  // carrying forward the last known value for non-GPS channels
  lapEntries.sort((a, b) => a.ts - b.ts);

  const latest: Record<string, number> = {};
  lapCoords = []; lapSpeeds = []; lapThrottles = []; lapGx = []; lapGy = [];
  lapRpms = []; lapGears = []; lapBrakes = []; lapTimestamps = [];

  // Group entries by timestamp
  let i = 0;
  while (i < lapEntries.length) {
    const ts = lapEntries[i].ts;
    // Absorb all entries at this timestamp
    while (i < lapEntries.length && lapEntries[i].ts === ts) {
      latest[lapEntries[i].channel] = lapEntries[i].value;
      i++;
    }
    // Only emit a data point when we have a GPS fix
    if (latest.gps_lat !== undefined && latest.gps_lon !== undefined) {
      lapCoords.push([latest.gps_lat, latest.gps_lon]);
      lapSpeeds.push(latest.gps_speed ?? 0);
      lapThrottles.push(latest.throttle_pos ?? 0);
      lapGx.push(latest.g_force_x ?? 0);
      lapGy.push(latest.g_force_y ?? 0);
      lapRpms.push(latest.rpm ?? 0);
      lapGears.push(latest.gear ?? 0);
      lapBrakes.push(latest.brake ?? 0);
      lapTimestamps.push(ts);
    }
  }

  drawTrail();
  seekEl.max = String(Math.max(0, lapCoords.length - 1));
  seekEl.value = seekEl.max;
  updateSeek(lapCoords.length - 1);
}

function drawTrail() {
  for (const l of trailLines) l.remove();
  trailLines = [];
  if (lapCoords.length < 2) return;

  const valuesMap: Record<TrailMode, number[]> = {
    speed: lapSpeeds, throttle: lapThrottles, rpm: lapRpms, gear: lapGears, brake: lapBrakes,
  };
  const colorFnMap: Record<TrailMode, (v: number) => string> = {
    speed: speedToColor, throttle: throttleToColor, rpm: rpmToColor,
    gear: gearToColor, brake: (v) => v > 0.5 ? "#e74c3c" : "rgba(255,255,255,0.3)",
  };
  const values = valuesMap[trailMode];
  const colorFn = colorFnMap[trailMode];
  const bucketSize = Math.max(1, Math.ceil(lapCoords.length / 80));

  for (let b = 0; b < lapCoords.length - 1; b += bucketSize) {
    const end = Math.min(b + bucketSize + 1, lapCoords.length);
    const slice = lapCoords.slice(b, end);
    if (slice.length < 2) continue;

    let sum = 0, cnt = 0;
    for (let j = b; j < Math.min(b + bucketSize, values.length); j++) { sum += values[j]; cnt++; }
    const avg = cnt > 0 ? sum / cnt : 0;
    // For gear, use mode (most common) instead of average
    let color: string;
    if (trailMode === "gear") {
      const counts: Record<number, number> = {};
      for (let j = b; j < Math.min(b + bucketSize, values.length); j++) {
        counts[values[j]] = (counts[values[j]] ?? 0) + 1;
      }
      const modeGear = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      color = gearToColor(modeGear ? parseInt(modeGear[0]) : 0);
    } else {
      color = colorFn(avg);
    }

    const line = L.polyline(slice as L.LatLngExpression[], { color, weight: 3, opacity: 0.8 }).addTo(map);
    trailLines.push(line);
  }
}

function updateSeek(idx: number) {
  if (idx < 0 || idx >= lapCoords.length) return;

  const [lat, lon] = lapCoords[idx];
  if (!posMarker) {
    posMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #e74c3c;margin:-5px 0 0 -5px;box-shadow:0 0 8px rgba(231,76,60,0.6);"></div>`,
        iconSize: [0, 0],
      }),
      interactive: false,
    }).addTo(map);
  } else {
    posMarker.setLatLng([lat, lon]);
  }

  if (lapTimestamps.length > 0) {
    seekTimeEl.textContent = formatTime(lapTimestamps[idx] - lapTimestamps[0]);
  }

  // G-force dial
  drawGCircle(lapGx[idx] ?? 0, lapGy[idx] ?? 0);

  // Speed gauge
  const spdKmh = lapSpeeds[idx] ?? 0;
  const spdMph = Math.round(spdKmh * KMH_TO_MPH);
  speedValueEl.textContent = String(spdMph);
  updateGaugeSegs(speedSegTrack, Math.min(1, spdMph / MAX_MPH), (i, n) => {
    const segMph = ((i + 1) / n) * MAX_MPH;
    return speedToColor(segMph / KMH_TO_MPH);
  });

  // Throttle gauge
  const tps = lapThrottles[idx] ?? 0;
  throttleValueEl.textContent = String(Math.round(tps));
  updateGaugeSegs(tpsSegTrack, Math.min(1, tps / 100), (i, n) => {
    return throttleToColor(((i + 1) / n) * 100);
  });

  // RPM gauge + gear
  const rpmVal = lapRpms[idx] ?? 0;
  rpmValueEl.textContent = String(Math.round(rpmVal));
  updateGaugeSegs(rpmSegTrack, Math.min(1, rpmVal / MAX_RPM), (i, n) => rpmColor((i + 1) / n));
  const gear = lapGears[idx] ?? 0;
  gearValueEl.textContent = gear > 0 ? String(gear) : "N";

  // Brake
  brakeEl.classList.toggle("active", (lapBrakes[idx] ?? 0) > 0.5);
}

seekEl.addEventListener("input", () => updateSeek(parseInt(seekEl.value, 10)));

// ── Init ──
async function init() {
  await loadSessions();
  const requestedId = params.get("session");
  if (requestedId && sessions.find((s) => s.id === requestedId)) await selectSession(requestedId);
  else if (sessions.length > 0) await selectSession(sessions[0].id);
  else updateMeta();
}
init();
propagateQueryParams();
