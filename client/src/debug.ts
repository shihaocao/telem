import "./debug.css";
import { propagateQueryParams } from "./nav";

import { SERVER_URL } from "./server-url";
const MAX_PTS = 200;
const container = document.getElementById("channels")!;
const statusEl = document.getElementById("status")!;

interface Channel {
  el: HTMLElement;
  valueEl: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  values: number[];
  recent: { t: number; v: number }[];
}

const channels = new Map<string, Channel>();

// Latency tracking
const lastUpdateEl = document.getElementById("last-update")!;
const latencyValEl = document.getElementById("latency-val")!;
const latencyCanvas = document.getElementById("latency-canvas") as HTMLCanvasElement;
const latencyCtx = latencyCanvas.getContext("2d")!;
const LATENCY_WINDOW_MS = 60_000;
const latencyHistory: { t: number; ms: number }[] = [];
let lastEntryTime = 0;
let lastBatchTime = 0;
let batchDebounce: ReturnType<typeof setTimeout> | null = null;

function scheduleLatencyUpdate(): void {
  lastEntryTime = Date.now();
  if (batchDebounce) return;
  batchDebounce = setTimeout(() => {
    batchDebounce = null;
    const now = Date.now();
    const latencyMs = lastBatchTime ? now - lastBatchTime : 0;
    lastBatchTime = now;
    latencyHistory.push({ t: now, ms: latencyMs });
    const cutoff = now - LATENCY_WINDOW_MS;
    while (latencyHistory.length > 0 && latencyHistory[0].t < cutoff) latencyHistory.shift();
    const recent = latencyHistory.slice(-10);
    const avgMs = recent.length > 0 ? Math.round(recent.reduce((s, p) => s + p.ms, 0) / recent.length) : latencyMs;
    latencyValEl.textContent = `${avgMs}ms`;
    latencyValEl.style.color = avgMs < 200 ? "#2ecc71" : avgMs < 1000 ? "#d4a017" : "#e74c3c";
    drawLatencyChart();
  }, 5);
}

function drawLatencyChart(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = latencyCanvas.clientWidth;
  const h = latencyCanvas.clientHeight;
  latencyCanvas.width = w * dpr;
  latencyCanvas.height = h * dpr;
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
  latencyCtx.lineWidth = 1.5;
  latencyCtx.stroke();
}

setInterval(() => {
  if (!lastEntryTime) return;
  const ago = ((Date.now() - lastEntryTime) / 1000).toFixed(1);
  lastUpdateEl.textContent = `${ago}s ago`;
}, 100);

function getOrCreate(name: string): Channel {
  if (channels.has(name)) return channels.get(name)!;

  const el = document.createElement("div");
  el.className = "ch";
  el.innerHTML = `
    <div class="ch-header">
      <span class="ch-name">${name}</span>
      <span class="ch-value">--</span>
    </div>
    <div class="ch-canvas-wrap">
      <canvas class="ch-canvas"></canvas>
      <div class="ch-tooltip"></div>
    </div>
  `;
  container.appendChild(el);

  const canvas = el.querySelector("canvas") as HTMLCanvasElement;
  const tooltip = el.querySelector(".ch-tooltip") as HTMLElement;
  const ch: Channel = {
    el,
    valueEl: el.querySelector(".ch-value") as HTMLElement,
    canvas,
    ctx: canvas.getContext("2d")!,
    values: [],
    recent: [],
  };

  // Hover readout
  canvas.addEventListener("mousemove", (e) => {
    if (ch.values.length < 2) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = x / rect.width;
    const idx = Math.round(frac * (ch.values.length - 1));
    const val = ch.values[Math.max(0, Math.min(idx, ch.values.length - 1))];
    tooltip.textContent = val.toFixed(3);
    tooltip.style.left = `${x}px`;
    tooltip.style.display = "block";

    // Redraw with crosshair
    drawSparkline(ch, x / rect.width);
  });

  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    drawSparkline(ch);
  });

  channels.set(name, ch);
  return ch;
}

function drawSparkline(ch: Channel, cursorFrac?: number): void {
  const { canvas, ctx, values } = ch;
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

  function yPos(v: number): number {
    return h - ((v - min + pad) / (range + pad * 2)) * h;
  }

  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = (i / (values.length - 1)) * w;
    const y = yPos(values[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "rgba(255, 107, 53, 0.5)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Crosshair at cursor
  if (cursorFrac !== undefined) {
    const cx = cursorFrac * w;
    const idx = Math.round(cursorFrac * (values.length - 1));
    const val = values[Math.max(0, Math.min(idx, values.length - 1))];
    const cy = yPos(val);

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#ff6b35";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function connect(): void {
  statusEl.textContent = "CONNECTING";
  statusEl.className = "";

  const es = new EventSource(`${SERVER_URL}/stream?history=false`);

  es.addEventListener("entry", (e) => {
    const { channel, value } = JSON.parse(e.data);
    if (typeof value !== "number") return;

    const ch = getOrCreate(channel);
    ch.values.push(value);
    if (ch.values.length > MAX_PTS) ch.values.shift();
    const now = Date.now();
    ch.recent.push({ t: now, v: value });
    const cutoff = now - 250;
    while (ch.recent.length > 0 && ch.recent[0].t < cutoff) ch.recent.shift();
    const avg = ch.recent.reduce((s, p) => s + p.v, 0) / ch.recent.length;
    ch.valueEl.textContent = avg.toFixed(3);
    drawSparkline(ch);
    scheduleLatencyUpdate();
  });

  es.addEventListener("caught_up", () => {
    statusEl.textContent = "LIVE";
    statusEl.className = "live";
  });

  es.onerror = () => {
    es.close();
    statusEl.textContent = "DISCONNECTED";
    statusEl.className = "";
    setTimeout(connect, 2000);
  };
}

// Camera exposure controls
const expVal = document.getElementById("exp-val")!;
async function camExposure(action: string | null): Promise<void> {
  try {
    const url = action
      ? `${SERVER_URL}/cam/exposure/${action}`
      : `${SERVER_URL}/cam/exposure`;
    const res = await fetch(url, { method: action ? "POST" : "GET" });
    const data = await res.json();
    if (data.exposure_absolute != null) {
      expVal.textContent = `exp:${data.exposure_absolute} gain:${data.gain}`;
    }
  } catch { /* ignore */ }
}
document.getElementById("exp-up")!.addEventListener("click", () => camExposure("up"));
document.getElementById("exp-down")!.addEventListener("click", () => camExposure("down"));
camExposure(null);

document.getElementById("nuke-btn")!.addEventListener("click", async () => {
  if (!confirm("Clear all telemetry data on the server?")) return;
  try {
    await fetch(`${SERVER_URL}/nuke`, { method: "POST" });
    window.location.reload();
  } catch (err) {
    console.error("nuke failed:", (err as Error).message);
  }
});

connect();
propagateQueryParams();
