import { TelemetryManager } from "./telemetry";

const MAX_G = 2.0;
const TRAIL_LEN = 200;
const RING_STEPS = [0.5, 1.0, 1.5, 2.0];

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
    if (!gxBuf || !gyBuf || gxBuf.values.length === 0) return;

    const len = Math.min(gxBuf.values.length, gyBuf.values.length);
    const gx = gxBuf.values[len - 1]; // longitudinal
    const gy = gyBuf.values[len - 1]; // lateral

    trail.push({ x: gy, y: -gx }); // lateral = x-axis, braking(+) = up
    if (trail.length > TRAIL_LEN) trail.splice(0, trail.length - TRAIL_LEN);

    draw(gy, -gx);
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
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.stroke();
    }

    // crosshair
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // ring labels
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (const g of RING_STEPS) {
      ctx.fillText(`${g}g`, cx + 3, cy - g * scale - 2);
    }

    // axis labels
    ctx.fillStyle = "rgba(255,255,255,0.35)";
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
      const alpha = 0.05 + (i / trail.length) * 0.4;
      const px = cx + t.x * scale;
      const py = cy + t.y * scale;
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(231, 76, 60, ${alpha})`;
      ctx.fill();
    }

    // current point
    const px = cx + curX * scale;
    const py = cy + curY * scale;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#e74c3c";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // magnitude text
    const mag = Math.sqrt(curX * curX + curY * curY);
    ctx.fillStyle = "#ccc";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(`${mag.toFixed(2)}g`, w - 8, 8);

  }

  return { update };
}
