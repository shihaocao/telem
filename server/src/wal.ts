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
  snapshotThreshold: number;
  fsyncBatchSize: number;
}

interface Snapshot {
  seq: number;
  generation: number;
}

const WAL_DIR = "wal";
const SNAP_DIR = "snapshots";
const MAX_CHANNEL_ENTRIES = 6000;

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
  private entryCount = 0;

  private byChannel = new Map<string, WalEntry[]>();

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
    await fs.promises.mkdir(this.walDir, { recursive: true });
    await fs.promises.mkdir(this.snapDir, { recursive: true });

    // Clean up partial compaction if interrupted
    const tmpDir = path.join(this.walDir, "_compact_tmp");
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}

    const snap = await this.loadLatestSnapshot();
    if (snap) {
      this.seq = snap.seq;
      this.generation = snap.generation;
    }

    await this.fastReplay();
    this.openGeneration(this.generation);
  }

  private async loadLatestSnapshot(): Promise<Snapshot | null> {
    const files = (await fs.promises.readdir(this.snapDir)).filter((f) => f.startsWith("snap.")).sort();
    if (files.length === 0) return null;
    const content = await fs.promises.readFile(path.join(this.snapDir, files[files.length - 1]), "utf-8");
    return JSON.parse(content) as Snapshot;
  }

  private async fastReplay(): Promise<void> {
    const files = (await fs.promises.readdir(this.walDir)).filter((f) => f.startsWith("wal.")).sort();
    let totalLines = 0;

    for (const file of files) {
      const content = await fs.promises.readFile(path.join(this.walDir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (line.length === 0 || line.startsWith("#")) continue;
        let entry: WalEntry;
        try { entry = JSON.parse(line) as WalEntry; } catch { continue; }

        if (entry.seq > this.seq) this.seq = entry.seq;
        totalLines++;

        let arr = this.byChannel.get(entry.channel);
        if (!arr) { arr = []; this.byChannel.set(entry.channel, arr); }
        arr.push(entry);
        if (arr.length > MAX_CHANNEL_ENTRIES) arr.shift();
      }
    }

    this.entryCount = totalLines;

    const currentFile = path.join(this.walDir, walFileName(this.generation));
    try {
      const content = await fs.promises.readFile(currentFile, "utf-8");
      this.entriesInGeneration = content.split("\n").filter((l) => l.length > 0 && !l.startsWith("#")).length;
    } catch { /* file may not exist yet */ }
  }

  // ── Write path (sync for durability) ──

  private openGeneration(gen: number): void {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
    }
    this.generation = gen;
    this.fd = fs.openSync(path.join(this.walDir, walFileName(gen)), "a");
    this.pendingWrites = 0;
  }

  append(channel: string, value: unknown, ts?: number): WalEntry {
    const entry: WalEntry = {
      seq: ++this.seq,
      ts: ts ?? Date.now(),
      channel,
      value,
    };

    fs.writeSync(this.fd!, Buffer.from(JSON.stringify(entry) + "\n"));
    this.pendingWrites++;

    if (this.pendingWrites >= this.config.fsyncBatchSize) {
      fs.fsyncSync(this.fd!);
      this.pendingWrites = 0;
    }

    this.indexLive(entry);
    this.entriesInGeneration++;
    this.entryCount++;
    this.emit("entry", entry);

    if (this.entriesInGeneration >= this.config.snapshotThreshold && !this.snapshotting) {
      this.triggerSnapshot();
    }

    return entry;
  }

  appendBatch(items: Array<{ channel: string; value: unknown; ts?: number }>): WalEntry[] {
    const batchSeq = ++this.seq;
    const entries: WalEntry[] = [];

    for (const item of items) {
      const entry: WalEntry = {
        seq: batchSeq,
        ts: item.ts ?? Date.now(),
        channel: item.channel,
        value: item.value,
      };
      entries.push(entry);
      fs.writeSync(this.fd!, Buffer.from(JSON.stringify(entry) + "\n"));
      this.indexLive(entry);
      this.entriesInGeneration++;
      this.entryCount++;
    }

    fs.fsyncSync(this.fd!);
    this.pendingWrites = 0;

    for (const entry of entries) this.emit("entry", entry);

    if (this.entriesInGeneration >= this.config.snapshotThreshold && !this.snapshotting) {
      this.triggerSnapshot();
    }

    return entries;
  }

  private indexLive(entry: WalEntry): void {
    let arr = this.byChannel.get(entry.channel);
    if (!arr) { arr = []; this.byChannel.set(entry.channel, arr); }
    arr.push(entry);
    if (arr.length > MAX_CHANNEL_ENTRIES) arr.shift();
  }

  private triggerSnapshot(): void {
    this.snapshotting = true;
    fs.fsyncSync(this.fd!);
    this.pendingWrites = 0;

    const snap: Snapshot = { seq: this.seq, generation: this.generation + 1 };
    const snapFile = path.join(this.snapDir, snapFileName(snap.seq));
    const tmpFile = snapFile + ".tmp";
    const tmpFd = fs.openSync(tmpFile, "w");
    fs.writeSync(tmpFd, JSON.stringify(snap));
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    fs.renameSync(tmpFile, snapFile);

    this.openGeneration(this.generation + 1);
    this.entriesInGeneration = 0;
    this.snapshotting = false;
  }

  // ── Read path (async to avoid blocking ingestion) ──

  getChannels(): string[] {
    return Array.from(this.byChannel.keys());
  }

  getChannelCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [ch, arr] of this.byChannel) counts[ch] = arr.length;
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
    if (opts.afterSeq != null) startIdx = this.binarySearchAfterSeq(arr, opts.afterSeq);

    const result: WalEntry[] = [];
    for (let i = startIdx; i < arr.length && result.length < limit; i++) {
      const e = arr[i];
      if (opts.startTs != null && e.ts < opts.startTs) continue;
      if (opts.endTs != null && e.ts > opts.endTs) continue;
      result.push(e);
    }
    return result;
  }

  async getEntriesInRange(startSeq: number, endSeq: number, channels?: Set<string>): Promise<WalEntry[]> {
    const result: WalEntry[] = [];
    const files = (await fs.promises.readdir(this.walDir)).filter((f) => f.startsWith("wal.")).sort();

    for (const file of files) {
      const filePath = path.join(this.walDir, file);
      const range = await this.readFileRange(filePath);
      if (range) {
        if (range.maxSeq < startSeq) continue;
        if (range.minSeq > endSeq) break;
      }

      const content = await fs.promises.readFile(filePath, "utf-8");
      for (const line of content.split("\n")) {
        if (line.length === 0 || line.startsWith("#")) continue;
        let entry: WalEntry;
        try { entry = JSON.parse(line) as WalEntry; } catch { continue; }
        if (entry.seq < startSeq) continue;
        if (entry.seq > endSeq) return result;
        if (channels && !channels.has(entry.channel)) continue;
        result.push(entry);
      }
    }
    return result;
  }

  async getEntriesAfterSeq(afterSeq: number, channels?: Set<string>): Promise<WalEntry[]> {
    const result: WalEntry[] = [];
    const files = (await fs.promises.readdir(this.walDir)).filter((f) => f.startsWith("wal.")).sort();

    for (const file of files) {
      const filePath = path.join(this.walDir, file);
      const range = await this.readFileRange(filePath);
      if (range && range.maxSeq <= afterSeq) continue;

      const content = await fs.promises.readFile(filePath, "utf-8");
      for (const line of content.split("\n")) {
        if (line.length === 0 || line.startsWith("#")) continue;
        let entry: WalEntry;
        try { entry = JSON.parse(line) as WalEntry; } catch { continue; }
        if (entry.seq <= afterSeq) continue;
        if (channels && !channels.has(entry.channel)) continue;
        result.push(entry);
      }
    }
    return result;
  }

  /** Read #range:min,max footer from WAL file */
  private async readFileRange(filePath: string): Promise<{ minSeq: number; maxSeq: number } | null> {
    try {
      // Read just the last ~200 bytes for the footer
      const stat = await fs.promises.stat(filePath);
      const size = stat.size;
      if (size === 0) return null;
      const readSize = Math.min(200, size);
      const buf = Buffer.alloc(readSize);
      const fh = await fs.promises.open(filePath, "r");
      await fh.read(buf, 0, readSize, size - readSize);
      await fh.close();
      const tail = buf.toString("utf-8");
      const lines = tail.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("#range:")) {
          const parts = lines[i].slice(7).split(",");
          return { minSeq: parseInt(parts[0], 10), maxSeq: parseInt(parts[1], 10) };
        }
        if (lines[i].length > 0 && !lines[i].startsWith("#")) break;
      }
    } catch {}
    return null;
  }

  private binarySearchAfterSeq(arr: WalEntry[], targetSeq: number): number {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].seq <= targetSeq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get currentSeq(): number { return this.seq; }
  get currentGeneration(): number { return this.generation; }
  get totalEntries(): number { return this.entryCount; }

  // ── Maintenance ──

  async compact(): Promise<{ oldFiles: number; oldEntries: number; newEntries: number; newSeq: number }> {
    this.close();

    const files = (await fs.promises.readdir(this.walDir)).filter((f) => f.startsWith("wal.")).sort();
    const oldFileCount = files.length;

    const tmpDir = path.join(this.walDir, "_compact_tmp");
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const maxPerFile = this.config.snapshotThreshold;
    let newSeq = 0, lastTs = -1;
    let gen = 1, count = 0;
    let oldEntryCount = 0, newEntryCount = 0;
    let fileMinSeq = Infinity, fileMaxSeq = -1;
    let fh = await fs.promises.open(path.join(tmpDir, walFileName(gen)), "w");

    let lastLog = Date.now();
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const content = await fs.promises.readFile(path.join(this.walDir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (line.length === 0 || line.startsWith("#")) continue;
        let entry: WalEntry;
        try { entry = JSON.parse(line) as WalEntry; } catch { continue; }
        oldEntryCount++;

        if (Date.now() - lastLog > 2000) {
          console.log(`  compacting... file ${fi + 1}/${files.length}, ${oldEntryCount} entries processed`);
          lastLog = Date.now();
        }

        if (entry.ts !== lastTs) { newSeq++; lastTs = entry.ts; }
        entry.seq = newSeq;

        await fh.write(JSON.stringify(entry) + "\n");
        if (entry.seq < fileMinSeq) fileMinSeq = entry.seq;
        if (entry.seq > fileMaxSeq) fileMaxSeq = entry.seq;
        newEntryCount++;
        count++;

        if (count >= maxPerFile) {
          await fh.write(`#range:${fileMinSeq},${fileMaxSeq}\n`);
          await fh.sync();
          await fh.close();
          gen++;
          fh = await fs.promises.open(path.join(tmpDir, walFileName(gen)), "w");
          count = 0;
          fileMinSeq = Infinity;
          fileMaxSeq = -1;
        }
      }
    }

    if (fileMaxSeq >= 0) await fh.write(`#range:${fileMinSeq},${fileMaxSeq}\n`);
    await fh.sync();
    await fh.close();

    // Swap
    for (const file of files) await fs.promises.unlink(path.join(this.walDir, file));
    for (const file of await fs.promises.readdir(tmpDir)) {
      await fs.promises.rename(path.join(tmpDir, file), path.join(this.walDir, file));
    }
    await fs.promises.rmdir(tmpDir);

    // Snapshots
    const snaps = (await fs.promises.readdir(this.snapDir)).filter((f) => f.startsWith("snap."));
    for (const file of snaps) await fs.promises.unlink(path.join(this.snapDir, file));
    await fs.promises.writeFile(
      path.join(this.snapDir, snapFileName(newSeq)),
      JSON.stringify({ seq: newSeq, generation: gen } as Snapshot),
    );

    // Re-init
    this.byChannel.clear();
    this.seq = 0;
    this.generation = 1;
    this.entriesInGeneration = 0;
    this.entryCount = 0;
    await this.init();

    return { oldFiles: oldFileCount, oldEntries: oldEntryCount, newEntries: newEntryCount, newSeq };
  }

  async nuke(): Promise<void> {
    this.close();
    await fs.promises.rm(this.walDir, { recursive: true, force: true });
    await fs.promises.rm(this.snapDir, { recursive: true, force: true });
    this.byChannel.clear();
    this.seq = 0;
    this.generation = 1;
    this.entriesInGeneration = 0;
    this.entryCount = 0;
    await this.init();
  }

  close(): void {
    if (this.fd !== null) {
      try { fs.fsyncSync(this.fd); fs.closeSync(this.fd); } catch {}
      this.fd = null;
    }
  }
}
