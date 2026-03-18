import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

export interface WalEntry {
  seq: number;
  ts: number;
  channel: string;
  value: unknown;
}

export interface WalConfig {
  dataDir: string;
  snapshotThreshold: number; // entries per generation before snapshot
  fsyncBatchSize: number; // batch N writes per fsync
}

interface Snapshot {
  seq: number;
  generation: number;
}

const WAL_DIR = "wal";
const SNAP_DIR = "snapshots";

function walFileName(gen: number): string {
  return `wal.${String(gen).padStart(6, "0")}.log`;
}

function snapFileName(seq: number): string {
  return `snap.${String(seq).padStart(12, "0")}.json`;
}

export class WalEngine extends EventEmitter {
  private config: WalConfig;
  private seq = 0;
  private generation = 1;
  private entriesInGeneration = 0;
  private fd: number | null = null;
  private pendingWrites = 0;

  // in-memory index
  private byChannel = new Map<string, WalEntry[]>();
  private bySeq = new Map<number, WalEntry>();

  private walDir: string;
  private snapDir: string;
  private snapshotting = false;

  constructor(config: WalConfig) {
    super();
    this.config = config;
    this.walDir = path.join(config.dataDir, WAL_DIR);
    this.snapDir = path.join(config.dataDir, SNAP_DIR);
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.walDir, { recursive: true });
    fs.mkdirSync(this.snapDir, { recursive: true });

    // load latest snapshot
    const snap = this.loadLatestSnapshot();
    if (snap) {
      this.seq = snap.seq;
      this.generation = snap.generation;
    }

    // replay ALL WAL entries to rebuild full in-memory index
    // snapshot only provides seq + generation so we know where to resume writing
    await this.replayWal();

    // open current generation file for appending
    this.openGeneration(this.generation);
  }

  private loadLatestSnapshot(): Snapshot | null {
    const files = fs.readdirSync(this.snapDir).filter((f) => f.startsWith("snap.")).sort();
    if (files.length === 0) return null;

    const latest = files[files.length - 1];
    const data = fs.readFileSync(path.join(this.snapDir, latest), "utf-8");
    return JSON.parse(data) as Snapshot;
  }

  private async replayWal(): Promise<void> {
    const files = fs.readdirSync(this.walDir).filter((f) => f.startsWith("wal.")).sort();

    for (const file of files) {
      const content = fs.readFileSync(path.join(this.walDir, file), "utf-8");
      const lines = content.split("\n").filter((l) => l.length > 0);

      for (const line of lines) {
        let entry: WalEntry;
        try {
          entry = JSON.parse(line) as WalEntry;
        } catch {
          continue; // skip corrupt lines
        }

        this.indexEntry(entry);
        if (entry.seq > this.seq) {
          this.seq = entry.seq;
        }
      }
    }

    // figure out entries in current generation
    const currentFile = path.join(this.walDir, walFileName(this.generation));
    if (fs.existsSync(currentFile)) {
      const content = fs.readFileSync(currentFile, "utf-8");
      this.entriesInGeneration = content.split("\n").filter((l) => l.length > 0).length;
    }
  }

  private indexEntry(entry: WalEntry): void {
    this.bySeq.set(entry.seq, entry);
    let arr = this.byChannel.get(entry.channel);
    if (!arr) {
      arr = [];
      this.byChannel.set(entry.channel, arr);
    }
    arr.push(entry);
  }

  private openGeneration(gen: number): void {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
    }
    this.generation = gen;
    const filePath = path.join(this.walDir, walFileName(gen));
    this.fd = fs.openSync(filePath, "a");
    this.pendingWrites = 0;
  }

  append(channel: string, value: unknown, ts?: number): WalEntry {
    const entry: WalEntry = {
      seq: ++this.seq,
      ts: ts ?? Date.now(),
      channel,
      value,
    };

    const line = JSON.stringify(entry) + "\n";
    fs.writeSync(this.fd!, Buffer.from(line));
    this.pendingWrites++;

    if (this.pendingWrites >= this.config.fsyncBatchSize) {
      fs.fsyncSync(this.fd!);
      this.pendingWrites = 0;
    }

    this.indexEntry(entry);
    this.entriesInGeneration++;
    this.emit("entry", entry);

    if (this.entriesInGeneration >= this.config.snapshotThreshold && !this.snapshotting) {
      this.triggerSnapshot();
    }

    return entry;
  }

  appendBatch(items: Array<{ channel: string; value: unknown; ts?: number }>): WalEntry[] {
    const entries: WalEntry[] = [];

    for (const item of items) {
      const entry: WalEntry = {
        seq: ++this.seq,
        ts: item.ts ?? Date.now(),
        channel: item.channel,
        value: item.value,
      };
      entries.push(entry);

      const line = JSON.stringify(entry) + "\n";
      fs.writeSync(this.fd!, Buffer.from(line));
      this.indexEntry(entry);
      this.entriesInGeneration++;
    }

    // single fsync for the whole batch
    fs.fsyncSync(this.fd!);
    this.pendingWrites = 0;

    for (const entry of entries) {
      this.emit("entry", entry);
    }

    if (this.entriesInGeneration >= this.config.snapshotThreshold && !this.snapshotting) {
      this.triggerSnapshot();
    }

    return entries;
  }

  private triggerSnapshot(): void {
    this.snapshotting = true;

    // fsync current WAL before snapshotting
    fs.fsyncSync(this.fd!);
    this.pendingWrites = 0;

    const snap: Snapshot = {
      seq: this.seq,
      generation: this.generation + 1, // next generation after snapshot
    };

    const snapFile = path.join(this.snapDir, snapFileName(snap.seq));
    const tmpFile = snapFile + ".tmp";

    // write to tmp, fsync, rename
    const tmpFd = fs.openSync(tmpFile, "w");
    fs.writeSync(tmpFd, JSON.stringify(snap));
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    fs.renameSync(tmpFile, snapFile);

    // rotate WAL to new generation
    this.openGeneration(this.generation + 1);
    this.entriesInGeneration = 0;
    this.snapshotting = false;
  }

  // query helpers

  getChannels(): string[] {
    return Array.from(this.byChannel.keys());
  }

  getChannelCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [ch, arr] of this.byChannel) {
      counts[ch] = arr.length;
    }
    return counts;
  }

  queryByChannel(
    channel: string,
    opts: { startTs?: number; endTs?: number; afterSeq?: number; limit?: number } = {},
  ): WalEntry[] {
    const arr = this.byChannel.get(channel);
    if (!arr) return [];

    const limit = opts.limit ?? 10_000;
    let startIdx = 0;

    // binary search for afterSeq
    if (opts.afterSeq != null) {
      startIdx = this.binarySearchAfterSeq(arr, opts.afterSeq);
    }

    const result: WalEntry[] = [];
    for (let i = startIdx; i < arr.length && result.length < limit; i++) {
      const e = arr[i];
      if (opts.startTs != null && e.ts < opts.startTs) continue;
      if (opts.endTs != null && e.ts > opts.endTs) continue;
      result.push(e);
    }
    return result;
  }

  /** Get all entries after a given seq across all channels (or filtered) */
  getEntriesAfterSeq(afterSeq: number, channels?: Set<string>): WalEntry[] {
    const result: WalEntry[] = [];
    // walk seqs from afterSeq+1 to current
    for (let s = afterSeq + 1; s <= this.seq; s++) {
      const e = this.bySeq.get(s);
      if (!e) continue;
      if (channels && !channels.has(e.channel)) continue;
      result.push(e);
    }
    return result;
  }

  private binarySearchAfterSeq(arr: WalEntry[], targetSeq: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].seq <= targetSeq) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get totalEntries(): number {
    return this.bySeq.size;
  }

  /** Clear all data and reset to empty state */
  async nuke(): Promise<void> {
    this.close();
    fs.rmSync(this.walDir, { recursive: true, force: true });
    fs.rmSync(this.snapDir, { recursive: true, force: true });
    this.byChannel.clear();
    this.bySeq.clear();
    this.seq = 0;
    this.generation = 1;
    this.entriesInGeneration = 0;
    await this.init();
  }

  /** Flush pending writes and close the WAL fd */
  close(): void {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
