import uPlot from "uplot";
import { ChannelBuffer } from "./types";
import { TelemetryManager } from "./telemetry";

export interface ChartPanel {
  update: () => void;
}

const KMH_TO_MPH = 0.621371;

function buildSparklineOpts(width: number, height: number): uPlot.Options {
  return {
    width,
    height,
    cursor: { show: false },
    legend: { show: false },
    series: [
      {},
      {
        stroke: "rgba(52, 152, 219, 0.6)",
        width: 2,
        fill: "rgba(52, 152, 219, 0.1)",
        points: { show: false },
      },
      {
        stroke: "rgba(46, 204, 113, 0.45)",
        width: 1.5,
        points: { show: false },
      },
    ],
    axes: [
      { show: false },
      { show: false },
    ],
    scales: {
      x: { time: false },
      y: { range: () => [0, 220] as uPlot.Range.MinMax },
    },
  };
}

function buildData(
  channels: string[],
  mgr: TelemetryManager,
): uPlot.AlignedData {
  let bestBuf: ChannelBuffer | undefined;
  for (const ch of channels) {
    const b = mgr.getBuffer(ch);
    if (b && (!bestBuf || b.timestamps.length > bestBuf.timestamps.length)) {
      bestBuf = b;
    }
  }

  if (!bestBuf || bestBuf.timestamps.length === 0) {
    const empty: number[] = [];
    const result: uPlot.AlignedData = [empty];
    for (let i = 0; i < channels.length; i++) result.push(empty);
    return result;
  }

  const xs = bestBuf.timestamps;
  const data: uPlot.AlignedData = [xs];

  for (const ch of channels) {
    const buf = mgr.getBuffer(ch);
    if (!buf || buf.values.length === 0) {
      data.push(new Array(xs.length).fill(null) as any);
    } else if (buf.values.length === xs.length) {
      // convert km/h to mph for display
      data.push(buf.values.map((v) => v * KMH_TO_MPH));
    } else {
      const pad = xs.length - buf.values.length;
      const padded = new Array(pad).fill(null).concat(
        buf.values.map((v) => v * KMH_TO_MPH),
      );
      data.push(padded as any);
    }
  }

  return data;
}

export function createPanels(mgr: TelemetryManager): ChartPanel[] {
  const container = document.getElementById("chart-speed")!;

  // speed overlay
  const overlay = document.createElement("div");
  overlay.className = "speed-overlay";
  overlay.innerHTML = `<span class="speed-value">--</span><span class="speed-unit">MPH</span>`;
  container.appendChild(overlay);

  // throttle bar
  const throttleBar = document.createElement("div");
  throttleBar.className = "throttle-bar-container";
  throttleBar.innerHTML = `<div class="throttle-bar-fill"></div>`;
  container.appendChild(throttleBar);
  const throttleFill = throttleBar.querySelector(".throttle-bar-fill") as HTMLElement;

  const throttleLabel = document.createElement("div");
  throttleLabel.className = "throttle-label";
  throttleLabel.textContent = "TPS --%";
  container.appendChild(throttleLabel);

  const rect = container.getBoundingClientRect();
  const channels = ["speed", "gps_speed"];
  const opts = buildSparklineOpts(rect.width, rect.height);
  const chart = new uPlot(opts, [[], [], []], container);

  const valueEl = overlay.querySelector(".speed-value")!;

  const update = () => {
    const data = buildData(channels, mgr);
    chart.setData(data);

    // update big number from gps_speed (preferred) or ecu speed
    const gpsBuf = mgr.getBuffer("gps_speed");
    const ecuBuf = mgr.getBuffer("speed");
    const buf = gpsBuf?.values.length ? gpsBuf : ecuBuf;
    if (buf && buf.values.length > 0) {
      const mph = buf.values[buf.values.length - 1] * KMH_TO_MPH;
      valueEl.textContent = String(Math.round(mph));
    }

    // update throttle bar
    const tpsBuf = mgr.getBuffer("throttle_pos");
    if (tpsBuf && tpsBuf.values.length > 0) {
      const tps = tpsBuf.values[tpsBuf.values.length - 1];
      const pct = Math.max(0, Math.min(100, tps));
      throttleFill.style.width = `${pct}%`;
      throttleLabel.textContent = `TPS ${Math.round(pct)}%`;
    }
  };

  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      chart.setSize({ width, height });
    }
  });
  ro.observe(container);

  return [{ update }];
}
