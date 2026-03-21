import { TelemetryManager } from "./telemetry";
import { speedToColor, throttleToColor, rpmToColor } from "./track-utils";
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

const speedColorFn = (i: number, n: number) => speedToColor(((i + 1) / n) * MAX_MPH / KMH_TO_MPH);
const throttleColorFn = (i: number, n: number) => throttleToColor(((i + 1) / n) * 100);
const rpmColorFn = (i: number, n: number) => rpmToColor((i + 1) / n);

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
