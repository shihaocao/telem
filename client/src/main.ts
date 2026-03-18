import "./style.css";
import { TelemetryManager } from "./telemetry";
import { createPanels, ChartPanel } from "./charts";
import { createMaps, MapPanels } from "./map";
import { createGCircle, GCirclePanel } from "./gcircle";
import { createDiagnostics, DiagPanel } from "./diagnostics";
import { ConnectionState } from "./types";

const statusEl = document.getElementById("connection-status")!;
const latencyEl = document.getElementById("stat-latency")!;
const latencySpark = document.getElementById("latency-spark") as HTMLCanvasElement;
const latencyCtx = latencySpark.getContext("2d")!;
const seqEl = document.getElementById("stat-seq")!;
const rateEl = document.getElementById("stat-rate")!;
const mgr = new TelemetryManager();

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: "CONNECTING",
  replaying: "REPLAYING",
  live: "LIVE",
  disconnected: "DISCONNECTED",
  error: "ERROR",
};

mgr.onStateChange = (state) => {
  statusEl.textContent = STATE_LABELS[state];
  statusEl.className = state;
};

// latency tracking — debounced per batch
const LATENCY_WINDOW = 60_000;
const latencyHistory: { t: number; ms: number }[] = [];
let lastBatchTime = 0;
let batchDebounce: ReturnType<typeof setTimeout> | null = null;

function onEntry(): void {
  if (batchDebounce) return;
  batchDebounce = setTimeout(() => {
    batchDebounce = null;
    const now = Date.now();
    const ms = lastBatchTime ? now - lastBatchTime : 0;
    lastBatchTime = now;
    latencyHistory.push({ t: now, ms });
    const cutoff = now - LATENCY_WINDOW;
    while (latencyHistory.length > 0 && latencyHistory[0].t < cutoff) latencyHistory.shift();
    const recent = latencyHistory.slice(-10);
    const avg = recent.length > 0 ? Math.round(recent.reduce((s, p) => s + p.ms, 0) / recent.length) : ms;
    latencyEl.textContent = `${avg}ms`;
    drawLatencySpark();
  }, 5);
}

function drawLatencySpark(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = latencySpark.clientWidth;
  const h = latencySpark.clientHeight;
  latencySpark.width = w * dpr;
  latencySpark.height = h * dpr;
  latencyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  latencyCtx.clearRect(0, 0, w, h);
  if (latencyHistory.length < 2) return;

  const vals = latencyHistory.map((p) => p.ms);
  const max = Math.max(...vals, 100);
  latencyCtx.beginPath();
  for (let i = 0; i < vals.length; i++) {
    const x = (i / (vals.length - 1)) * w;
    const y = h - (vals[i] / max) * h;
    if (i === 0) latencyCtx.moveTo(x, y);
    else latencyCtx.lineTo(x, y);
  }
  latencyCtx.strokeStyle = "rgba(255, 107, 53, 0.6)";
  latencyCtx.lineWidth = 1;
  latencyCtx.stroke();
}

// hook into telemetry manager's ingest
const origConnect = mgr.connect.bind(mgr);
mgr.connect = function () {
  origConnect();
  // patch: listen for dirty flag as a proxy for new entries
};

let panels: ChartPanel[] = [];
let maps: MapPanels;
let gcircle: GCirclePanel;
let diag: DiagPanel;

function init() {
  // track selector
  const trackSelect = document.getElementById("track-select") as HTMLSelectElement;
  const params = new URLSearchParams(window.location.search);
  const currentTrack = params.get("track") ?? "sonoma";
  trackSelect.value = currentTrack;
  trackSelect.addEventListener("change", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("track", trackSelect.value);
    window.location.href = url.toString();
  });

  panels = createPanels(mgr);
  maps = createMaps(
    document.getElementById("map-follow")!,
    document.getElementById("map-overview")!,
    mgr,
  );
  gcircle = createGCircle(document.getElementById("gcircle")!, mgr);
  diag = createDiagnostics(document.getElementById("diagnostics")!, mgr);
  mgr.connect();
  requestAnimationFrame(loop);
}

// rate tracking
let entryCount = 0;
let lastRateCheck = performance.now();

function loop() {
  if (mgr.dirty) {
    for (const p of panels) p.update();
    maps.update();
    gcircle.update();
    diag.update();

    // update stats
    const seq = mgr.lastSeqNum;
    seqEl.textContent = String(seq);

    // latency
    onEntry();

    entryCount++;
    const now = performance.now();
    const elapsed = now - lastRateCheck;
    if (elapsed > 1000) {
      const rate = Math.round((entryCount / elapsed) * 1000);
      rateEl.textContent = `${rate}/s`;
      entryCount = 0;
      lastRateCheck = now;
    }

    mgr.clearDirty();
  }

  requestAnimationFrame(loop);
}

init();
