import { TelemetryManager } from "./telemetry";
import { throttleToColor } from "./track-utils";

export interface ChartPanel {
  update: () => void;
}

const KMH_TO_MPH = 0.621371;
const MAX_MPH = 120;
const MPH_SEGMENTS = 32;
const TPS_SEGMENTS = 20;

// Speed color ramp (mph): white → yellow → orange → red
const SPEED_COLORS: [number, [number, number, number]][] = [
  [0,   [255, 255, 255]],  // white
  [40,  [255, 255, 255]],  // white
  [50,  [241, 196, 15]],   // yellow
  [80,  [255, 107, 53]],   // orange
  [120, [231, 76, 60]],    // red
];

function speedColor(mph: number): string {
  const kmh = mph / KMH_TO_MPH;
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

function updateSegments(track: HTMLElement, fraction: number, colorFn?: (i: number, n: number) => string): void {
  const segs = track.children;
  const lit = Math.round(fraction * segs.length);
  for (let i = 0; i < segs.length; i++) {
    const el = segs[i] as HTMLElement;
    const on = i < lit;
    el.classList.toggle("seg-on", on);
    if (on && colorFn) {
      const c = colorFn(i, segs.length);
      el.style.background = c;
      el.style.borderColor = c;
      el.style.boxShadow = `0 0 8px ${c}40, inset 0 0 4px ${c}4d`;
    } else if (!on) {
      el.style.background = "";
      el.style.borderColor = "";
      el.style.boxShadow = "";
    }
  }
}

const speedColorFn = (i: number, n: number) => speedColor(((i + 1) / n) * MAX_MPH);
const throttleColorFn = (i: number, n: number) => throttleToColor(((i + 1) / n) * 100);

export function createPanels(mgr: TelemetryManager): ChartPanel[] {
  const container = document.getElementById("chart-speed")!;

  const inner = document.createElement("div");
  inner.className = "gauges-container";
  inner.innerHTML = `
    <div class="gauge">
      <div class="gauge-label">速度 <span class="gauge-label-jp">SPEED</span></div>
      <div class="gauge-header">
        <span class="gauge-value" id="gauge-mph">--</span>
        <span class="gauge-unit">MPH</span>
      </div>
    </div>
    <div class="gauge-divider"></div>
    <div class="gauge">
      <div class="gauge-label">出力 <span class="gauge-label-jp">THROTTLE</span></div>
      <div class="gauge-header">
        <span class="gauge-value" id="gauge-tps">--</span>
        <span class="gauge-unit">% TPS</span>
      </div>
    </div>
  `;
  container.appendChild(inner);

  const gauges = inner.querySelectorAll(".gauge");

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
      updateSegments(mphTrack, Math.min(1, mph / MAX_MPH), speedColorFn);
    }

    const tpsSmoothed = mgr.getSmoothed("throttle_pos");
    if (tpsSmoothed != null) {
      const tps = Math.max(0, Math.min(100, tpsSmoothed));
      tpsVal.textContent = String(Math.round(tps));
      updateSegments(tpsTrack, tps / 100, throttleColorFn);
    }
  };

  return [{ update }];
}
