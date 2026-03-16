import { TelemetryEntry, ConnectionState, ChannelBuffer } from "./types";

const MAX_POINTS = 6000; // ~2 min at 50Hz

const SERVER_URL = ((import.meta.env.VITE_SERVER_URL as string) ?? "http://gearados-nx.tail62d295.ts.net:4400").replace(/\/$/, "");

export class TelemetryManager {
  private es: EventSource | null = null;
  private buffers = new Map<string, ChannelBuffer>();
  private lastSeq = 0;
  private _state: ConnectionState = "disconnected";
  private _dirty = false;
  private retryDelay = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

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

  getBuffer(channel: string): ChannelBuffer | undefined {
    return this.buffers.get(channel);
  }

  connect(): void {
    this.cleanup();

    this.setState("connecting");

    // On first connect with no data, skip history. On reconnect, replay from lastSeq.
    const params = this.lastSeq > 0
      ? `after_seq=${this.lastSeq}`
      : "history=false";

    const es = new EventSource(`${SERVER_URL}/stream?${params}`);
    this.es = es;

    es.addEventListener("entry", (e) => {
      const entry: TelemetryEntry = JSON.parse(e.data);
      this.ingest(entry);
    });

    es.addEventListener("caught_up", () => {
      this.setState("live");
      this.retryDelay = 1000; // reset backoff
    });

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
    if (entry.seq <= this.lastSeq) return; // dedup
    this.lastSeq = entry.seq;

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
  }
}
