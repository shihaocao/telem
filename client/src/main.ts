import "./style.css";
import { TelemetryManager } from "./telemetry";
import { createPanels, ChartPanel } from "./charts";
import { createMaps, MapPanels } from "./map";
import { ConnectionState } from "./types";

const statusEl = document.getElementById("connection-status")!;
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

let panels: ChartPanel[] = [];
let maps: MapPanels;

function init() {
  panels = createPanels(mgr);
  maps = createMaps(
    document.getElementById("map-follow")!,
    document.getElementById("map-overview")!,
    mgr,
  );
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

    // update stats
    const seq = mgr.lastSeqNum;
    seqEl.textContent = String(seq);

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
