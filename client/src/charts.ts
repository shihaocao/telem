import { TelemetryManager } from "./telemetry";
import { throttleToColor } from "./track-utils";
import { inferGearFromRatio } from "../../server/src/gear";

export interface ChartPanel {
  update: () => void;
}

const KMH_TO_MPH = 0.621371;
const MAX_MPH = 120;
const MAX_RPM = 7000;
const MPH_SEGMENTS = 32;
const TPS_SEGMENTS = 20;
const RPM_SEGMENTS = 28;

// Speed color ramp (mph): white → yellow → orange → red
const SPEED_COLORS: [number, [number, number, number]][] = [
  [0,   [255, 255, 255]],
  [40,  [255, 255, 255]],
  [50,  [241, 196, 15]],
  [80,  [255, 107, 53]],
  [120, [231, 76, 60]],
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

// RPM color: white low → orange mid → red high
function rpmColor(fraction: number): string {
  if (fraction < 0.6) return "rgb(255, 255, 255)";
  if (fraction < 0.8) {
    const t = (fraction - 0.6) / 0.2;
    const r = 255;
    const g = Math.round(255 - (255 - 107) * t);
    const b = Math.round(255 - (255 - 53) * t);
    return `rgb(${r},${g},${b})`;
  }
  const t = (fraction - 0.8) / 0.2;
  const r = Math.round(255 - (255 - 231) * t);
  const g = Math.round(107 - (107 - 76) * t);
  const b = Math.round(53 + (60 - 53) * t);
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
const rpmColorFn = (i: number, n: number) => rpmColor((i + 1) / n);

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
      <div class="gauge-label">回転 <span class="gauge-label-jp">RPM</span></div>
      <div class="gauge-header">
        <span class="gauge-value" id="gauge-rpm">--</span>
        <span class="gauge-unit">RPM</span>
        <span class="gauge-gear-label">GEAR</span>
        <span class="gauge-gear-badge" id="gauge-gear">--</span>
      </div>
    </div>
    <div class="gauge-divider"></div>
    <div class="gauge">
      <div class="gauge-label">出力 <span class="gauge-label-jp">THROTTLE</span></div>
      <div class="gauge-header">
        <span class="gauge-value" id="gauge-tps">--</span>
        <span class="gauge-unit">%TPS</span>
      </div>
    </div>
    <div class="gauge-divider"></div>
    <div class="gauge-label">制動 <span class="gauge-label-jp">BRAKE</span></div>
    <div class="gauge-brake" id="gauge-brake">${Array(10).fill('<div class="gauge-brake-seg"></div>').join("")}</div>
  `;
  container.appendChild(inner);

  const gauges = inner.querySelectorAll(".gauge");

  const mphTrack = createSegments(MPH_SEGMENTS, "seg-speed");
  gauges[0].appendChild(mphTrack);

  const rpmTrack = createSegments(RPM_SEGMENTS, "seg-rpm");
  gauges[1].appendChild(rpmTrack);

  const tpsTrack = createSegments(TPS_SEGMENTS, "seg-throttle");
  gauges[2].appendChild(tpsTrack);

  const mphVal = container.querySelector("#gauge-mph") as HTMLElement;
  const rpmVal = container.querySelector("#gauge-rpm") as HTMLElement;
  const tpsVal = container.querySelector("#gauge-tps") as HTMLElement;
  const gearVal = container.querySelector("#gauge-gear") as HTMLElement;
  const brakeEl = container.querySelector("#gauge-brake") as HTMLElement;

  const update = () => {
    const speedSmoothed = mgr.getSmoothed("gps_speed") ?? mgr.getSmoothed("speed");
    if (speedSmoothed != null) {
      const mph = speedSmoothed * KMH_TO_MPH;
      mphVal.textContent = String(Math.round(mph));
      updateSegments(mphTrack, Math.min(1, mph / MAX_MPH), speedColorFn);
    }

    const rpmSmoothed = mgr.getSmoothed("rpm");
    if (rpmSmoothed != null) {
      rpmVal.textContent = String(Math.round(rpmSmoothed));
      updateSegments(rpmTrack, Math.min(1, rpmSmoothed / MAX_RPM), rpmColorFn);
    }

    // Infer gear from RPM + GPS speed (more reliable than serial bridge gear)
    const speedForGear = mgr.getSmoothed("gps_speed") ?? mgr.getSmoothed("speed");
    if (rpmSmoothed != null && speedForGear != null && speedForGear > 3) {
      const g = inferGearFromRatio(rpmSmoothed, speedForGear);
      gearVal.textContent = String(g);
    } else {
      gearVal.textContent = rpmSmoothed != null && rpmSmoothed > 500 ? "N" : "--";
    }

    const brakeBuf = mgr.getBuffer("brake");
    if (brakeBuf && brakeBuf.values.length > 0) {
      brakeEl.classList.toggle("active", brakeBuf.values[brakeBuf.values.length - 1] > 0.5);
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
