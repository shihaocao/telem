import { TelemetryManager } from "./telemetry";

export interface DiagPanel {
  update: () => void;
}

const SPARK_POINTS = 100;

// NERV colors
const AMBER = "rgb(255, 107, 53)";
const RED = "rgb(231, 76, 60)";

interface DiagCell {
  channel: string;
  label: string;
  unit: string;
  valueEl: HTMLElement;
  cellEl: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  color: string;
  min: number;
  max: number;
  warnAbove?: number;
}

function drawSparkline(
  cell: DiagCell,
  values: number[],
): void {
  const { canvas, ctx, color, min, max } = cell;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (values.length < 2) return;

  const start = Math.max(0, values.length - SPARK_POINTS);
  const pts = values.slice(start);
  const range = max - min || 1;

  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = (i / (pts.length - 1)) * w;
    const y = h - ((pts[i] - min) / range) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // fill under
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color.replace(")", ", 0.06)").replace("rgb", "rgba");
  ctx.fill();
}

function createCell(
  parent: HTMLElement,
  channel: string,
  label: string,
  unit: string,
  color: string,
  min: number,
  max: number,
  warnAbove?: number,
): DiagCell {
  const cell = document.createElement("div");
  cell.className = "diag-cell";
  cell.innerHTML = `
    <div class="diag-cell-header">
      <span class="diag-cell-label">${label}</span>
      <span class="diag-cell-readout">
        <span class="diag-cell-value">--</span>
        <span class="diag-cell-unit">${unit}</span>
      </span>
    </div>
    <canvas class="diag-cell-spark"></canvas>
  `;
  parent.appendChild(cell);

  const canvas = cell.querySelector(".diag-cell-spark") as HTMLCanvasElement;

  return {
    channel,
    label,
    unit,
    valueEl: cell.querySelector(".diag-cell-value") as HTMLElement,
    cellEl: cell,
    canvas,
    ctx: canvas.getContext("2d")!,
    color,
    min,
    max,
    warnAbove,
  };
}

export function createDiagnostics(
  container: HTMLElement,
  mgr: TelemetryManager,
): DiagPanel {
  container.innerHTML = `<div class="diag-grid"></div>`;
  const grid = container.querySelector(".diag-grid") as HTMLElement;

  const cells: DiagCell[] = [
    createCell(grid, "coolant_temp", "冷却 COOLANT", "\u00B0C", RED, 0, 130, 100),
    createCell(grid, "manifold_pressure", "圧力 MAP", "kPa", AMBER, 0, 110),
  ];

  function update(): void {
    for (const cell of cells) {
      const buf = mgr.getBuffer(cell.channel);
      if (!buf || buf.values.length === 0) continue;

      const smoothed = mgr.getSmoothed(cell.channel) ?? buf.values[buf.values.length - 1];
      cell.valueEl.textContent = String(Math.round(smoothed));
      drawSparkline(cell, buf.values);

      // warning state
      if (cell.warnAbove != null) {
        cell.cellEl.classList.toggle("warning", smoothed > cell.warnAbove);
      }
    }
  }

  return { update };
}
