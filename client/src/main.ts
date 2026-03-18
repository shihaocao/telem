import "./style.css";
import { TelemetryManager } from "./telemetry";
import { createPanels, ChartPanel } from "./charts";
import { createMaps, MapPanels } from "./map";
import { createGCircle, GCirclePanel } from "./gcircle";
import { createDiagnostics, DiagPanel } from "./diagnostics";
import { ConnectionState } from "./types";

const statusEl = document.getElementById("connection-status")!;
const headingEl = document.getElementById("stat-heading")!;
const seqEl = document.getElementById("stat-seq")!;
const rateEl = document.getElementById("stat-rate")!;
const nukeBtn = document.getElementById("nuke-btn")!;

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

let panels: ChartPanel[] = [];
let maps: MapPanels;
let gcircle: GCirclePanel;
let diag: DiagPanel;

// Nuke button — clear all server data
nukeBtn.addEventListener("click", async () => {
  if (!confirm("Clear all telemetry data on the server?")) return;
  try {
    await fetch(`${mgr.serverUrl}/nuke`, { method: "POST" });
    window.location.reload();
  } catch (err: any) {
    console.error("nuke failed:", err.message);
  }
});

function init() {
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

    const hdgBuf = mgr.getBuffer("gps_heading");
    if (hdgBuf && hdgBuf.values.length > 0) {
      const hdg = hdgBuf.values[hdgBuf.values.length - 1];
      headingEl.textContent = `${Math.round(hdg)}°`;
    }

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
