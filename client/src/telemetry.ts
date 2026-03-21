import { TelemetryEntry, ConnectionState, ChannelBuffer } from "./types";
import { SERVER_URL } from "./server-url";

const MAX_POINTS = 6000; // ~2 min at 50Hz

export class TelemetryManager {
  readonly serverUrl = SERVER_URL;
  private es: EventSource | null = null;
  private buffers = new Map<string, ChannelBuffer>();
  private lastSeq = 0;
  private _state: ConnectionState = "disconnected";
  private _dirty = false;
  private retryDelay = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;

  onStateChange: ((state: ConnectionState) => void) | null = null;

  get state(): ConnectionState {
    return this._state;
  }

  get lastSeqNum(): number {
    return this.lastSeq;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  clearDirty(): void {
    this._dirty = false;
  }

  getChannels(): string[] {
    return Array.from(this.buffers.keys());
  }

  getBuffer(channel: string): ChannelBuffer | undefined {
    return this.buffers.get(channel);
  }

  /** EWMA of values within windowMs of the most recent server timestamp.
   *  Alpha is derived from window size: alpha = 2 / (N + 1) where N = samples in window. */
  getSmoothed(channel: string, windowMs = 500): number | undefined {
    const buf = this.buffers.get(channel);
    if (!buf || buf.values.length === 0) return undefined;
    const latest = buf.timestamps[buf.timestamps.length - 1];
    const cutoff = latest - windowMs / 1000;

    // Find start of window
    let start = buf.timestamps.length - 1;
    while (start > 0 && buf.timestamps[start - 1] >= cutoff) start--;

    const n = buf.timestamps.length - start;
    if (n === 0) return buf.values[buf.values.length - 1];
    if (n === 1) return buf.values[start];

    const alpha = 2 / (n + 1);
    let ema = buf.values[start];
    for (let i = start + 1; i < buf.timestamps.length; i++) {
      ema = alpha * buf.values[i] + (1 - alpha) * ema;
    }
    return ema;
  }

  connect(): void {
    this.cleanup();

    this.setState("connecting");

    const es = new EventSource(`${SERVER_URL}/stream?history=false`);
    this.es = es;

    es.addEventListener("entry", (e) => {
      const entry: TelemetryEntry = JSON.parse(e.data);
      this.ingest(entry);
    });

    es.onopen = () => {
      this.setState("live");
      this.retryDelay = 1000;
      this.resetStaleTimer();
    };

    es.onerror = () => {
      this.cleanup();
      this.setState("disconnected");
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.cleanup();
    this.setState("disconnected");
  }

  private cleanup(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 1.5, 10000);
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    this.onStateChange?.(s);
  }

  private ingest(entry: TelemetryEntry): void {
    if (entry.seq > this.lastSeq) this.lastSeq = entry.seq;

    let buf = this.buffers.get(entry.channel);
    if (!buf) {
      buf = { timestamps: [], values: [] };
      this.buffers.set(entry.channel, buf);
    }

    buf.timestamps.push(entry.ts / 1000); // ms → s for uPlot
    buf.values.push(entry.value);

    // ring buffer trim
    if (buf.timestamps.length > MAX_POINTS) {
      const excess = buf.timestamps.length - MAX_POINTS;
      buf.timestamps.splice(0, excess);
      buf.values.splice(0, excess);
    }

    this._dirty = true;
    this.resetStaleTimer();
  }

  private resetStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      if (this._state === "live") {
        this.setState("disconnected");
        this.cleanup();
        this.scheduleReconnect();
      }
    }, 5000);
  }
}
