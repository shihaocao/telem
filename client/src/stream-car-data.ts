import "./stream.css";
import { TelemetryManager } from "./telemetry";
import { speedToColor, rpmToColor } from "./track-utils";

const KMH_TO_MPH = 0.621371;
const SPARK_PTS = 150;

const mgr = new TelemetryManager();

interface Spark {
  label: string;
  channel: string;
  el: HTMLElement;
  valueEl: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  values: number[];
  format: (v: number) => string;
  color: (v: number) => string;
  convert?: (v: number) => number;
}

const CHANNELS: Array<{
  label: string;
  channel: string;
  format: (v: number) => string;
  color: (v: number) => string;
  convert?: (v: number) => number;
}> = [
  {
    label: "MPH",
    channel: "gps_speed",
    format: (v) => String(Math.round(v)),
    color: (v) => speedToColor(v / KMH_TO_MPH),
    convert: (v) => v * KMH_TO_MPH,
  },
  {
    label: "RPM",
    channel: "rpm",
    format: (v) => String(Math.round(v)),
    color: (v) => rpmToColor(v / 7000),
  },
  {
    label: "TPS",
    channel: "throttle_pos",
    format: (v) => `${Math.round(v)}%`,
    color: () => "rgba(255, 107, 53, 0.6)",
  },
  {
    label: "BRK",
    channel: "brake",
    format: (v) => (v > 0.5 ? "ON" : "OFF"),
    color: (v) => (v > 0.5 ? "#e74c3c" : "rgba(255, 255, 255, 0.15)"),
  },
];

const container = document.getElementById("gauges")!;
container.innerHTML = "";
const sparks: Spark[] = [];

for (const def of CHANNELS) {
  const el = document.createElement("div");
  el.className = "spark-row";
  el.innerHTML = `
    <div class="spark-meta">
      <span class="spark-label">${def.label}</span>
      <span class="spark-value">--</span>
    </div>
    <canvas class="spark-canvas"></canvas>
  `;
  container.appendChild(el);

  const canvas = el.querySelector("canvas")! as HTMLCanvasElement;
  sparks.push({
    ...def,
    el,
    valueEl: el.querySelector(".spark-value")!,
    canvas,
    ctx: canvas.getContext("2d")!,
    values: [],
  });
}

function drawSparkline(s: Spark): void {
  const { canvas, ctx, values } = s;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (values.length < 2) return;

  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const pad = range * 0.1;

  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((values[i] - min + pad) / (range + pad * 2)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  const lastVal = values[values.length - 1];
  ctx.strokeStyle = s.color(lastVal);
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function update(): void {
  for (const s of sparks) {
    const smoothed = mgr.getSmoothed(s.channel);
    if (smoothed == null) continue;
    const display = s.convert ? s.convert(smoothed) : smoothed;
    s.valueEl.textContent = s.format(display);
    s.valueEl.style.color = s.color(display);
    s.values.push(display);
    if (s.values.length > SPARK_PTS) s.values.shift();
    drawSparkline(s);
  }
}

mgr.connect();

function loop() {
  if (mgr.dirty) {
    update();
    mgr.clearDirty();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
