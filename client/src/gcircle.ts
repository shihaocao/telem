import { TelemetryManager } from "./telemetry";

const MAX_G = 1.0;
const TRAIL_LEN = 200;
const RING_STEPS = [0.25, 0.5, 0.75, 1.0];

const GRID_DIM = "rgba(255, 255, 255, 0.06)";
const GRID_LINE = "rgba(255, 255, 255, 0.1)";
const GRID_TEXT = "rgba(255, 255, 255, 0.2)";
const AXIS_LABEL = "rgba(255, 107, 53, 0.5)";
const DOT_COLOR = "#ff6b35";
const TRAIL_DIM = (a: number) => `rgba(255, 107, 53, ${a})`;
const TEXT_BRIGHT = "#eee";

export interface GCirclePanel {
  update: () => void;
}

export function createGCircle(
  container: HTMLElement,
  mgr: TelemetryManager,
): GCirclePanel {
  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d")!;
  let w = 0;
  let h = 0;

  const trail: { x: number; y: number }[] = [];
  const EMA_ALPHA = 0.15;
  let emaX = 0;
  let emaY = 0;
  let emaInit = false;

  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const r = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      w = r.width;
      h = r.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  });
  ro.observe(container);

  function update(): void {
    if (w === 0 || h === 0) return;

    const gxBuf = mgr.getBuffer("g_force_x");
    const gyBuf = mgr.getBuffer("g_force_y");

    const len = Math.min(gxBuf?.values.length ?? 0, gyBuf?.values.length ?? 0);
    const gx = len > 0 ? gxBuf!.values[len - 1] : 0;
    const gy = len > 0 ? gyBuf!.values[len - 1] : 0;

    const rawX = -gy;    // lateral = x-axis (negate so right turn = right on display)
    const rawY = -gx;    // braking(+) = up

    if (!emaInit) {
      emaX = rawX;
      emaY = rawY;
      emaInit = true;
    } else {
      emaX = EMA_ALPHA * rawX + (1 - EMA_ALPHA) * emaX;
      emaY = EMA_ALPHA * rawY + (1 - EMA_ALPHA) * emaY;
    }

    trail.push({ x: emaX, y: emaY });
    if (trail.length > TRAIL_LEN) trail.splice(0, trail.length - TRAIL_LEN);

    draw(emaX, emaY);
  }

  function draw(curX: number, curY: number): void {
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) - 24;
    const scale = radius / MAX_G;

    // ring guides
    ctx.lineWidth = 1;
    for (const g of RING_STEPS) {
      const r = g * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = GRID_DIM;
      ctx.stroke();
    }

    // crosshair
    ctx.strokeStyle = GRID_LINE;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // tick marks on crosshair
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    for (const g of RING_STEPS) {
      const r = g * scale;
      const tickLen = 3;
      // horizontal ticks
      ctx.beginPath();
      ctx.moveTo(cx + r, cy - tickLen);
      ctx.lineTo(cx + r, cy + tickLen);
      ctx.moveTo(cx - r, cy - tickLen);
      ctx.lineTo(cx - r, cy + tickLen);
      // vertical ticks
      ctx.moveTo(cx - tickLen, cy + r);
      ctx.lineTo(cx + tickLen, cy + r);
      ctx.moveTo(cx - tickLen, cy - r);
      ctx.lineTo(cx + tickLen, cy - r);
      ctx.stroke();
    }

    // ring labels
    ctx.fillStyle = GRID_TEXT;
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (const g of RING_STEPS) {
      ctx.fillText(`${g}g`, cx + 3, cy - g * scale - 2);
    }

    // axis labels
    ctx.fillStyle = AXIS_LABEL;
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

    // trail with decay
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i];
      const alpha = 0.03 + (i / trail.length) * 0.35;
      const px = cx + t.x * scale;
      const py = cy + t.y * scale;
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = TRAIL_DIM(alpha);
      ctx.fill();
    }

    // current point
    const px = cx + curX * scale;
    const py = cy + curY * scale;

    // glow
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 107, 53, 0.12)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = DOT_COLOR;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // magnitude text
    const mag = Math.sqrt(curX * curX + curY * curY);
    ctx.fillStyle = TEXT_BRIGHT;
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(`${mag.toFixed(2)}g`, w - 8, 8);

  }

  return { update };
}
