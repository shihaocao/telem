import uPlot from "uplot";
import { ChannelBuffer } from "./types";
import { TelemetryManager } from "./telemetry";

export interface ChartPanel {
  chart: uPlot;
  channels: string[];
  update: () => void;
}

interface ChartDef {
  title: string;
  el: string;
  channels: string[];
  seriesOpts: Array<{ label: string; stroke: string; width?: number }>;
  yRange: [number, number];
  yLabel: string;
}

const CHART_DEFS: ChartDef[] = [
  // --- ECU / sim channels ---
  {
    title: "RPM",
    el: "chart-engine",
    channels: ["rpm"],
    seriesOpts: [{ label: "RPM", stroke: "#e74c3c" }],
    yRange: [0, 14000],
    yLabel: "rpm",
  },
  {
    title: "SPEED",
    el: "chart-speed",
    channels: ["speed", "gps_speed"],
    seriesOpts: [
      { label: "ECU", stroke: "#3498db" },
      { label: "GPS", stroke: "#2ecc71" },
    ],
    yRange: [0, 350],
    yLabel: "km/h",
  },
  {
    title: "PEDALS",
    el: "chart-pedals",
    channels: ["throttle", "brake"],
    seriesOpts: [
      { label: "Throttle", stroke: "#2ecc71" },
      { label: "Brake", stroke: "#e74c3c" },
    ],
    yRange: [0, 100],
    yLabel: "%",
  },
  {
    title: "WHEEL TEMPS",
    el: "chart-temps",
    channels: ["wheel_temp_fl", "wheel_temp_fr", "wheel_temp_rl", "wheel_temp_rr"],
    seriesOpts: [
      { label: "FL", stroke: "#1abc9c" },
      { label: "FR", stroke: "#f39c12" },
      { label: "RL", stroke: "#9b59b6" },
      { label: "RR", stroke: "#e67e22" },
    ],
    yRange: [50, 150],
    yLabel: "°C",
  },
  // --- RaceBox GPS/IMU channels ---
  {
    title: "G-FORCE",
    el: "chart-gforce",
    channels: ["g_force_x", "g_force_y", "g_force_z"],
    seriesOpts: [
      { label: "Lat (Y)", stroke: "#e74c3c" },
      { label: "Lon (X)", stroke: "#3498db" },
      { label: "Vert (Z)", stroke: "#2ecc71" },
    ],
    yRange: [-3, 3],
    yLabel: "g",
  },
  {
    title: "GYRO",
    el: "chart-gyro",
    channels: ["gyro_x", "gyro_y", "gyro_z"],
    seriesOpts: [
      { label: "X", stroke: "#e67e22" },
      { label: "Y", stroke: "#9b59b6" },
      { label: "Z", stroke: "#1abc9c" },
    ],
    yRange: [-200, 200],
    yLabel: "°/s",
  },
  {
    title: "GPS HEADING",
    el: "chart-heading",
    channels: ["gps_heading"],
    seriesOpts: [{ label: "Heading", stroke: "#f1c40f" }],
    yRange: [0, 360],
    yLabel: "°",
  },
  {
    title: "GPS ALTITUDE",
    el: "chart-altitude",
    channels: ["gps_altitude"],
    seriesOpts: [{ label: "Alt MSL", stroke: "#1abc9c" }],
    yRange: [-50, 500],
    yLabel: "m",
  },
];

function formatTime(self: uPlot, splits: number[]): string[] {
  return splits.map((v) => {
    if (v == null) return "";
    const d = new Date(v * 1000);
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${m}:${s}`;
  });
}

function makeOpts(
  def: ChartDef,
  width: number,
  height: number,
): uPlot.Options {
  const series: uPlot.Series[] = [
    { label: "Time", value: (_, v) => v == null ? "--" : new Date(v * 1000).toLocaleTimeString() },
  ];

  for (const s of def.seriesOpts) {
    series.push({
      label: s.label,
      stroke: s.stroke,
      width: s.width ?? 1.5,
      points: { show: false },
    });
  }

  return {
    width,
    height,
    title: def.title,
    cursor: { show: true, drag: { x: false, y: false } },
    series,
    axes: [
      {
        stroke: "#666",
        grid: { stroke: "rgba(255,255,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(255,255,255,0.1)", width: 1 },
        values: formatTime,
      },
      {
        stroke: "#666",
        grid: { stroke: "rgba(255,255,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(255,255,255,0.1)", width: 1 },
        label: def.yLabel,
        range: () => def.yRange,
      },
    ],
    scales: {
      x: { time: false },
    },
  };
}

/**
 * Build unified x-axis from multiple channel buffers.
 * All channels from the data generator share timestamps so we just use the
 * longest buffer's timestamps and align the others by index (they arrive in lockstep).
 * For robustness, if lengths differ we pad shorter series with nulls.
 */
function buildData(
  channels: string[],
  mgr: TelemetryManager,
): uPlot.AlignedData {
  // find the channel with most data to use as the x-axis
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
      data.push(buf.values);
    } else {
      // pad front with nulls if this channel started later
      const pad = xs.length - buf.values.length;
      const padded = new Array(pad).fill(null).concat(buf.values);
      data.push(padded as any);
    }
  }

  return data;
}

export function createPanels(mgr: TelemetryManager): ChartPanel[] {
  const panels: ChartPanel[] = [];

  for (const def of CHART_DEFS) {
    const container = document.getElementById(def.el)!;
    const rect = container.getBoundingClientRect();
    const opts = makeOpts(def, rect.width, rect.height - 4);
    const emptyData: uPlot.AlignedData = [[]];
    for (let i = 0; i < def.channels.length; i++) emptyData.push([]);
    const chart = new uPlot(opts, emptyData, container);

    const update = () => {
      const data = buildData(def.channels, mgr);
      chart.setData(data);
    };

    // resize on container size change
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.setSize({ width, height: height - 4 });
      }
    });
    ro.observe(container);

    panels.push({ chart, channels: def.channels, update });
  }

  return panels;
}
