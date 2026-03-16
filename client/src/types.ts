export interface TelemetryEntry {
  seq: number;
  ts: number;
  channel: string;
  value: number;
}

export type ConnectionState =
  | "connecting"
  | "replaying"
  | "live"
  | "disconnected"
  | "error";

export interface ChannelBuffer {
  timestamps: number[]; // seconds (uPlot uses seconds)
  values: number[];
}
