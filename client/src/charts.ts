import { TelemetryManager } from "./telemetry";

export interface ChartPanel {
  update: () => void;
}

const KMH_TO_MPH = 0.621371;
const MAX_MPH = 160;
const MPH_SEGMENTS = 32;
const TPS_SEGMENTS = 20;

function createSegments(count: number, className: string): HTMLElement {
  const track = document.createElement("div");
  track.className = "seg-track";
  for (let i = 0; i < count; i++) {
    const seg = document.createElement("div");
    seg.className = `seg ${className}`;
    track.appendChild(seg);
  }
  return track;
}

function updateSegments(track: HTMLElement, fraction: number): void {
  const segs = track.children;
  const lit = Math.round(fraction * segs.length);
  for (let i = 0; i < segs.length; i++) {
    segs[i].classList.toggle("seg-on", i < lit);
  }
}

export function createPanels(mgr: TelemetryManager): ChartPanel[] {
  const container = document.getElementById("chart-speed")!;

  container.innerHTML = `
    <div class="gauges-container">
      <div class="gauge">
        <div class="gauge-header">
          <span class="gauge-value" id="gauge-mph">--</span>
          <span class="gauge-unit">MPH</span>
        </div>
      </div>
      <div class="gauge">
        <div class="gauge-header">
          <span class="gauge-value" id="gauge-tps">--</span>
          <span class="gauge-unit">% TPS</span>
        </div>
      </div>
    </div>
  `;

  const gauges = container.querySelectorAll(".gauge");

  const mphTrack = createSegments(MPH_SEGMENTS, "seg-speed");
  gauges[0].appendChild(mphTrack);

  const tpsTrack = createSegments(TPS_SEGMENTS, "seg-throttle");
  gauges[1].appendChild(tpsTrack);

  const mphVal = container.querySelector("#gauge-mph") as HTMLElement;
  const tpsVal = container.querySelector("#gauge-tps") as HTMLElement;

  const update = () => {
    const speedSmoothed = mgr.getSmoothed("gps_speed") ?? mgr.getSmoothed("speed");
    if (speedSmoothed != null) {
      const mph = speedSmoothed * KMH_TO_MPH;
      mphVal.textContent = String(Math.round(mph));
      updateSegments(mphTrack, Math.min(1, mph / MAX_MPH));
    }

    const tpsSmoothed = mgr.getSmoothed("throttle_pos");
    if (tpsSmoothed != null) {
      const tps = Math.max(0, Math.min(100, tpsSmoothed));
      tpsVal.textContent = String(Math.round(tps));
      updateSegments(tpsTrack, tps / 100);
    }
  };

  return [{ update }];
}
