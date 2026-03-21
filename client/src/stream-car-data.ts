import "./stream.css";
import { TelemetryManager } from "./telemetry";
import { speedToColor, throttleToColor, rpmToColor } from "./track-utils";
import { inferGearFromRatio } from "../../server/src/gear";

const KMH_TO_MPH = 0.621371;
const MAX_MPH = 120;
const MAX_RPM = 7000;
const MPH_SEGMENTS = 32;
const TPS_SEGMENTS = 20;
const RPM_SEGMENTS = 28;

const MAX_G = 1.0;
const TRAIL_LEN = 200;
const RING_STEPS = [0.25, 0.5, 0.75, 1.0];

const mgr = new TelemetryManager();

// ── Gauges ──
const gaugesEl = document.getElementById("gauges")!;
gaugesEl.innerHTML = `
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

function createSegments(count: number): HTMLElement {
  const track = document.createElement("div");
  track.className = "seg-track";
  for (let i = 0; i < count; i++) {
    const seg = document.createElement("div");
    seg.className = "seg";
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

const gauges = gaugesEl.querySelectorAll(".gauge");
const mphTrack = createSegments(MPH_SEGMENTS);
gauges[0].appendChild(mphTrack);
const rpmTrack = createSegments(RPM_SEGMENTS);
gauges[1].appendChild(rpmTrack);
const tpsTrack = createSegments(TPS_SEGMENTS);
gauges[2].appendChild(tpsTrack);

const mphVal = document.getElementById("gauge-mph")!;
const rpmVal = document.getElementById("gauge-rpm")!;
const tpsVal = document.getElementById("gauge-tps")!;
const gearVal = document.getElementById("gauge-gear")!;
const brakeEl = document.getElementById("gauge-brake")!;

function updateGauges(): void {
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

  const speedForGear = mgr.getSmoothed("gps_speed") ?? mgr.getSmoothed("speed");
  if (rpmSmoothed != null && speedForGear != null && speedForGear > 3) {
    gearVal.textContent = String(inferGearFromRatio(rpmSmoothed, speedForGear));
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
}

// ── G-Force Circle ──
const gcircleEl = document.getElementById("gcircle")!;
const canvas = document.createElement("canvas");
canvas.style.width = "100%";
canvas.style.height = "100%";
gcircleEl.appendChild(canvas);
const ctx = canvas.getContext("2d")!;

let cw = 0;
let ch = 0;
const trail: { x: number; y: number }[] = [];
const EMA_ALPHA = 0.15;
let emaX = 0;
let emaY = 0;
let emaInit = false;

new ResizeObserver((entries) => {
  for (const entry of entries) {
    const r = entry.contentRect;
    const dpr = window.devicePixelRatio || 1;
    cw = r.width;
    ch = r.height;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}).observe(gcircleEl);

function updateGCircle(): void {
  if (cw === 0 || ch === 0) return;

  const gxBuf = mgr.getBuffer("g_force_x");
  const gyBuf = mgr.getBuffer("g_force_y");
  const len = Math.min(gxBuf?.values.length ?? 0, gyBuf?.values.length ?? 0);
  const gx = len > 0 ? gxBuf!.values[len - 1] : 0;
  const gy = len > 0 ? gyBuf!.values[len - 1] : 0;

  const rawX = -gy;
  const rawY = -gx;

  if (!emaInit) { emaX = rawX; emaY = rawY; emaInit = true; }
  else { emaX = EMA_ALPHA * rawX + (1 - EMA_ALPHA) * emaX; emaY = EMA_ALPHA * rawY + (1 - EMA_ALPHA) * emaY; }

  trail.push({ x: emaX, y: emaY });
  if (trail.length > TRAIL_LEN) trail.splice(0, trail.length - TRAIL_LEN);

  drawGCircle(emaX, emaY);
}

function drawGCircle(curX: number, curY: number): void {
  ctx.clearRect(0, 0, cw, ch);

  const cx = cw / 2;
  const cy = ch / 2;
  const radius = Math.min(cx, cy) - 24;
  const scale = radius / MAX_G;

  // ring guides
  ctx.lineWidth = 1;
  for (const g of RING_STEPS) {
    ctx.beginPath();
    ctx.arc(cx, cy, g * scale, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.stroke();
  }

  // crosshair
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // tick marks
  ctx.lineWidth = 1;
  for (const g of RING_STEPS) {
    const r = g * scale;
    ctx.beginPath();
    ctx.moveTo(cx + r, cy - 3); ctx.lineTo(cx + r, cy + 3);
    ctx.moveTo(cx - r, cy - 3); ctx.lineTo(cx - r, cy + 3);
    ctx.moveTo(cx - 3, cy + r); ctx.lineTo(cx + 3, cy + r);
    ctx.moveTo(cx - 3, cy - r); ctx.lineTo(cx + 3, cy - r);
    ctx.stroke();
  }

  // ring labels
  ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  for (const g of RING_STEPS) {
    ctx.fillText(`${g}g`, cx + 3, cy - g * scale - 2);
  }

  // axis labels
  ctx.fillStyle = "rgba(255, 107, 53, 0.5)";
  ctx.font = "bold 9px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("BRAKE", cx, cy - radius - 18);
  ctx.textBaseline = "bottom";
  ctx.fillText("ACCEL", cx, cy + radius + 18);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("L", cx - radius - 16, cy);
  ctx.textAlign = "right";
  ctx.fillText("R", cx + radius + 16, cy);

  // trail
  for (let i = 0; i < trail.length; i++) {
    const t = trail[i];
    const alpha = 0.03 + (i / trail.length) * 0.35;
    ctx.beginPath();
    ctx.arc(cx + t.x * scale, cy + t.y * scale, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 107, 53, ${alpha})`;
    ctx.fill();
  }

  // current dot
  const px = cx + curX * scale;
  const py = cy + curY * scale;

  ctx.beginPath();
  ctx.arc(px, py, 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 107, 53, 0.12)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#ff6b35";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // magnitude
  const mag = Math.sqrt(curX * curX + curY * curY);
  ctx.fillStyle = "#eee";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(`${mag.toFixed(2)}g`, cw - 8, 8);
}

// ── Loop ──
mgr.connect();

function loop() {
  if (mgr.dirty) {
    updateGauges();
    updateGCircle();
    mgr.clearDirty();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
